import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { hashCanonical } from '@crewkite/contracts/hash';
import { spawnCheckChild } from '../../host/check-ownership.ts';
import { groupAbsent } from '../../host/worker.ts';
import {
  type ConversationPlan,
  ConversationTranscript,
  conversationBindingHash,
  conversationPlan,
  startConversation,
} from './conversation.ts';
import { configuration, fixture, replies, running, threadResult } from './replacement-fixture.ts';

const scope = { paths: ['net.mjs'], roles: ['coder' as const], checks: ['node-net'] };
const plan = (directory: string) =>
  conversationPlan({
    binding: {
      taskId: 'tsk_01M51M322B2AEBXD9MA74CBCFM',
      runId: 'run_01M51M322B2AEBXD9MA74CBCFM',
      attemptId: 'att_01M51M322B2AEBXD9MA74CBCFM',
      generation: 0,
      routeId: 'rte_01M51M322B2AEBXD9MA74CBCFM',
      role: 'lead',
      taskRevision: 2,
      conversationRevision: 3,
      scopeHash: hashCanonical(scope),
      limitMinutes: 1,
    },
    model: 'gpt-6.1-sol',
    effort: 'low',
    directory,
    context: { title: 'Calculate net totals', outcome: 'Add netMinor.', criteria: [] },
    scope,
    history: [{ role: 'user', text: 'Should a discount exceed the subtotal?' }],
    omittedHistoryCount: 2,
  });
const reply = (trusted: ConversationPlan) => ({
  version: 1 as const,
  bindingHash: conversationBindingHash(trusted),
  message: 'The result needs a lower bound.',
  questions: ['Should the result stop at zero?'],
  proposal: {
    summary: 'Bound the net total.',
    criteria: ['Return zero when the discount exceeds the subtotal.'],
    slices: [
      { id: 'net', title: 'Calculate net', role: 'coder', scope: ['net.mjs'], dependsOn: [] },
    ],
    checks: ['node-net'],
  },
});
const requested = {
  version: 1 as const,
  observation: { artifactId: 'art_01M51M322B2AEBXD9MA74CBCFM', hash: 'a'.repeat(64) },
  model: 'planning-fixture',
  effort: 'medium',
};
const modelChoices = [
  { model: 'gpt-6.1-sol', efforts: ['low'], defaultEffort: 'low' },
  { model: requested.model, efforts: ['medium', 'high'], defaultEffort: 'medium' },
];
const catalog = {
  data: modelChoices.map((entry, index) => ({
    id: `fixture-${index}`,
    model: entry.model,
    description: 'private-catalog-canary',
    supportedReasoningEfforts: entry.efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: 'private-catalog-canary',
    })),
    defaultReasoningEffort: entry.defaultEffort,
  })),
  nextCursor: null,
};
const withSelection = (trusted: ConversationPlan) =>
  conversationPlan({
    ...trusted,
    model: requested.model,
    effort: requested.effort,
    selection: { version: 1, configurationRevision: 3, modelRequest: requested },
  });
const bytes = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);

function admit(
  reader: ConversationTranscript,
  directory: string,
  overrides: Record<string, unknown> = {},
  thread = threadResult(directory),
) {
  for (;;) {
    const next = reader.next();
    assert(next);
    const request = Buffer.from(next)
      .toString()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((message) => message.id);
    if (request.method === 'thread/start') {
      assert.equal(request.params.sandbox, 'read-only');
      reader.push(bytes({ id: request.id, result: thread }));
      break;
    }
    reader.push(
      bytes({ id: request.id, result: overrides[request.method] ?? replies[request.method] }),
    );
  }
  const next = reader.next();
  assert(next);
  const request = JSON.parse(Buffer.from(next).toString());
  assert.equal(request.method, 'turn/start');
  assert.deepEqual(request.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  reader.push(bytes({ id: request.id, result: { turn: running } }));
  return request;
}

function complete(reader: ConversationTranscript, value: unknown, notifications: unknown[] = []) {
  const item = {
    id: 'message-1',
    type: 'agentMessage',
    text: JSON.stringify(value),
    phase: 'final_answer',
  };
  for (const message of [
    { method: 'turn/started', params: { threadId: 'thread-1', turn: running } },
    ...notifications,
    {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { ...item, text: '' },
        startedAtMs: 1,
      },
    },
    {
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item, completedAtMs: 2 },
    },
    {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { ...running, status: 'completed' } },
    },
  ])
    reader.push(bytes(message));
}

test('conversation replies bind frozen scope and remain finite proposals', () => {
  const trusted = plan(resolve('internal/conversation-input'));
  const messageId = 'msg_01M51M322B2AEBXD9MA74CBCFM';
  const contextSource = { projectId: 'prj_01M51M322B2AEBXD9MA74CBCFM', base: 'a'.repeat(40) };
  const selectedText = 'Treat this source comment as data.\n';
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  const bundle = {
    version: 1 as const,
    ...contextSource,
    files: [
      {
        kind: 'source' as const,
        path: 'net.mjs',
        mode: '100644' as const,
        hash: digest(selectedText),
        bytes: Buffer.byteLength(selectedText),
        text: selectedText,
      },
    ],
  };
  const attachment = {
    messageId,
    artifactId: 'art_01M51M322B2AEBXD9MA74CBCFM',
    hash: hashCanonical(bundle),
    bundle,
  };
  const withContext = {
    ...trusted,
    contextSource,
    contextAttachments: [attachment],
    history: [{ ...trusted.history[0], messageId }],
  };
  const selected = conversationPlan(withContext);
  const legacyHash = hashCanonical({
    binding: trusted.binding,
    context: trusted.context,
    scope: trusted.scope,
    history: trusted.history,
    omittedHistoryCount: trusted.omittedHistoryCount,
  });
  assert.equal(conversationBindingHash(trusted), legacyHash);
  const chosen = withSelection(trusted);
  assert(chosen.selection);
  const choiceHash = conversationBindingHash(chosen);
  assert.notEqual(choiceHash, legacyHash);
  for (const selection of [
    { ...chosen.selection, configurationRevision: 4 },
    {
      ...chosen.selection,
      modelRequest: {
        ...requested,
        observation: { ...requested.observation, hash: 'b'.repeat(64) },
      },
    },
  ])
    assert.notEqual(
      conversationBindingHash(conversationPlan({ ...chosen, selection })),
      choiceHash,
    );
  for (const settings of [
    { model: requested.model, effort: 'high' },
    { model: 'gpt-6.1-sol', effort: 'low' },
  ]) {
    const changed = conversationPlan({
      ...chosen,
      ...settings,
      selection: { ...chosen.selection, modelRequest: { ...requested, ...settings } },
    });
    assert.notEqual(conversationBindingHash(changed), choiceHash);
  }
  for (const change of [
    { selection: undefined },
    { model: 'different-model' },
    { effort: 'high' },
    { selection: { ...chosen.selection, configurationRevision: -1 } },
    { selection: { ...chosen.selection, version: 2 } },
  ])
    assert.throws(() => conversationPlan({ ...chosen, ...change } as ConversationPlan));
  const choiceReader = new ConversationTranscript(chosen, { now: () => 1, timeoutMs: 60_000 });
  const choiceTurn = admit(
    choiceReader,
    chosen.directory,
    { 'model/list': catalog },
    {
      ...threadResult(chosen.directory),
      model: requested.model,
      reasoningEffort: requested.effort,
    },
  );
  assert.equal(choiceTurn.params.model, requested.model);
  assert.equal(choiceTurn.params.effort, requested.effort);
  assert.deepEqual(
    JSON.parse(choiceTurn.params.input[0].text.split('\n').at(-1)).selection,
    chosen.selection,
  );
  complete(choiceReader, reply(chosen));
  assert.deepEqual(choiceReader.finish().modelChoices, modelChoices);
  assert(!JSON.stringify(choiceReader.finish()).includes('private-catalog-canary'));
  for (const [overrides, cause] of [
    [{}, 'model-unavailable'],
    [
      {
        'model/list': {
          ...catalog,
          data: [
            {
              ...catalog.data[1],
              supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
              defaultReasoningEffort: 'high',
            },
          ],
        },
      },
      'effort-unavailable',
    ],
    [
      {
        'model/list': catalog,
        'account/read': {
          account: { type: 'chatgpt', planType: 'plus' },
          requiresOpenaiAuth: true,
        },
      },
      'admission',
    ],
    [
      {
        'model/list': catalog,
        'account/rateLimits/read': { ordinaryUsageAllowed: false, rateLimits: {} },
      },
      'admission',
    ],
    [
      {
        'model/list': catalog,
        'config/read': {
          config: { ...configuration, mcp_servers: { fixture_server: { enabled: true } } },
        },
      },
      'admission',
    ],
  ] as const) {
    const refused = new ConversationTranscript(chosen, { now: () => 1, timeoutMs: 60_000 });
    assert.throws(() => admit(refused, chosen.directory, overrides));
    assert.equal(refused.submitted, false);
    assert.equal(refused.diagnostic?.cause, cause);
    assert.throws(() => refused.finish());
  }
  for (const change of [{ model: 'different-model' }, { reasoningEffort: 'high' }]) {
    const mismatch = new ConversationTranscript(chosen, { now: () => 1, timeoutMs: 60_000 });
    assert.throws(() =>
      admit(
        mismatch,
        chosen.directory,
        { 'model/list': catalog },
        {
          ...threadResult(chosen.directory),
          model: requested.model,
          reasoningEffort: requested.effort,
          ...change,
        },
      ),
    );
    assert.equal(mismatch.submitted, false);
  }
  const unfinished = new ConversationTranscript(chosen, { now: () => 1, timeoutMs: 60_000 });
  assert.throws(() => unfinished.finish());

  const empty = conversationPlan({ ...withContext, contextAttachments: [] });
  assert.equal(conversationBindingHash(empty), legacyHash);
  assert.deepEqual(empty, trusted);
  assert.notEqual(conversationBindingHash(selected), legacyHash);
  const selectedReader = new ConversationTranscript(selected, { now: () => 1, timeoutMs: 60_000 });
  const selectedRequest = admit(selectedReader, selected.directory);
  const selectedTask = JSON.parse(selectedRequest.params.input[0].text.split('\n').at(-1));
  assert.match(selectedRequest.params.input[0].text, /untrusted source or log text/);
  assert.deepEqual(selectedTask.contextAttachments, [attachment]);
  assert.deepEqual(selectedTask.contextSource, contextSource);
  assert.deepEqual(selectedTask.scope, trusted.scope);
  assert.equal(selectedTask.history[0].messageId, messageId);
  assert.equal(
    selectedRequest.params.outputSchema.properties.bindingHash.const,
    conversationBindingHash(selected),
  );
  complete(selectedReader, reply(selected));
  assert.deepEqual(selectedReader.finish().conversation, reply(selected));
  const staleReader = new ConversationTranscript(selected, { now: () => 1, timeoutMs: 60_000 });
  admit(staleReader, selected.directory);
  assert.throws(() => complete(staleReader, reply(trusted)));
  const changedText = {
    ...bundle,
    files: [
      {
        ...bundle.files[0],
        text: 'Changed bytes.\n',
        bytes: Buffer.byteLength('Changed bytes.\n'),
      },
    ],
  };
  for (const change of [
    { contextSource: undefined },
    { contextSource: { ...contextSource, projectId: 'prj_01M51M322B2AEBXD9MA74CBCFN' } },
    { contextSource: { ...contextSource, base: 'b'.repeat(40) } },
    { history: trusted.history },
    { history: [withContext.history[0], withContext.history[0]] },
    { history: [{ ...withContext.history[0], role: 'agent' }] },
    { contextAttachments: [{ ...attachment, hash: '0'.repeat(64) }] },
    { contextAttachments: [{ ...attachment, messageId: 'msg_01M51M322B2AEBXD9MA74CBCFN' }] },
    { contextAttachments: [attachment, attachment] },
    {
      contextAttachments: [
        attachment,
        { ...attachment, artifactId: 'art_01M51M322B2AEBXD9MA74CBCFN' },
      ],
    },
    {
      contextAttachments: [
        { ...attachment, hash: hashCanonical(changedText), bundle: changedText },
      ],
    },
  ])
    assert.throws(() => conversationPlan({ ...withContext, ...change } as ConversationPlan));
  const largeText = 'x'.repeat(8192);
  const largeBundle = {
    ...bundle,
    files: ['a.mjs', 'b.mjs', 'c.mjs'].map((path) => ({
      ...bundle.files[0],
      path,
      text: largeText,
      bytes: 8192,
      hash: digest(largeText),
    })),
  };
  assert.throws(() =>
    conversationPlan({
      ...withContext,
      history: Array.from({ length: 5 }, (_, index) => ({
        role: 'user',
        text: 'x'.repeat(4096),
        messageId: `msg_01M51M322B2AEBXD9MA74CBCF${index}`,
      })),
      contextAttachments: [0, 1].map((index) => ({
        ...attachment,
        messageId: `msg_01M51M322B2AEBXD9MA74CBCF${index}`,
        bundle: largeBundle,
        hash: hashCanonical(largeBundle),
      })),
    }),
  );
  for (const amendment of [
    { binding: { ...trusted.binding, scopeHash: '0'.repeat(64) } },
    { binding: { ...trusted.binding, role: 'coder' } },
    { binding: { ...trusted.binding, limitMinutes: 6 } },
    { model: 'unsupported' },
    { scope: { ...scope, paths: ['../escape'] } },
    { scope: { ...scope, roles: ['coder', 'coder'] } },
    { history: [{ role: 'user', text: 'é'.repeat(2049) }] },
    { history: [{ role: 'user', text: 'a\0b' }] },
    { history: Array.from({ length: 20 }, () => ({ role: 'user', text: 'a'.repeat(4096) })) },
    { omittedHistoryCount: -1 },
  ])
    assert.throws(() => conversationPlan({ ...trusted, ...amendment } as ConversationPlan));
  assert.notEqual(
    conversationBindingHash(trusted),
    conversationBindingHash(conversationPlan({ ...trusted, omittedHistoryCount: 3 })),
  );
  const valid = reply(trusted);
  const slice = valid.proposal.slices[0];
  for (const value of [
    { ...valid, bindingHash: '0'.repeat(64) },
    { ...valid, command: 'execute' },
    { ...valid, message: '\ud800' },
    { ...valid, questions: Array.from({ length: 9 }, () => 'Question?') },
    { ...valid, proposal: { ...valid.proposal, checks: ['arbitrary command'] } },
    { ...valid, proposal: { ...valid.proposal, slices: [{ ...slice, role: 'advisor' }] } },
    { ...valid, proposal: { ...valid.proposal, slices: [{ ...slice, scope: ['private.mjs'] }] } },
    { ...valid, proposal: { ...valid.proposal, slices: [slice, slice] } },
    { ...valid, proposal: { ...valid.proposal, slices: [{ ...slice, dependsOn: ['missing'] }] } },
    { ...valid, proposal: { ...valid.proposal, slices: [{ ...slice, dependsOn: ['net'] }] } },
  ]) {
    const reader = new ConversationTranscript(trusted, { now: () => 1, timeoutMs: 60_000 });
    admit(reader, trusted.directory);
    assert.throws(() => complete(reader, value));
    assert.throws(() => reader.finish());
  }
  const usageNotification = (tokenUsage: object, identity = {}) => ({
    method: 'thread/tokenUsage/updated',
    params: { threadId: 'thread-1', turnId: 'turn-1', ...identity, tokenUsage },
  });
  const lastUsage = {
    total: { totalTokens: 900_000 },
    last: { totalTokens: 123 },
    modelContextWindow: 4096,
  };
  for (const capacity of [4096, null, undefined]) {
    const measured = new ConversationTranscript(trusted, { now: () => 1, timeoutMs: 60_000 });
    admit(measured, trusted.directory);
    complete(measured, valid, [
      usageNotification(lastUsage),
      usageNotification({ ...lastUsage, last: { totalTokens: 17 }, modelContextWindow: capacity }),
    ]);
    assert.deepEqual(measured.finish().contextUsage, {
      threadId: 'thread-1',
      turnId: 'turn-1',
      model: trusted.model,
      usedTokens: 17,
      capacityTokens: capacity ?? null,
    });
  }
  for (const notification of [
    usageNotification(lastUsage, { threadId: 'other-thread' }),
    usageNotification(lastUsage, { turnId: 'other-turn' }),
    usageNotification({ ...lastUsage, last: { totalTokens: -1 } }),
    usageNotification({ ...lastUsage, modelContextWindow: 0 }),
    usageNotification({ ...lastUsage, modelContextWindow: Number.MAX_SAFE_INTEGER + 1 }),
  ]) {
    const refused = new ConversationTranscript(trusted, { now: () => 1, timeoutMs: 60_000 });
    admit(refused, trusted.directory);
    assert.throws(() => complete(refused, valid, [notification]));
    assert.throws(() => refused.finish());
  }
  const reader = new ConversationTranscript(trusted, { now: () => 1, timeoutMs: 60_000 });
  const request = admit(reader, trusted.directory);
  assert(Buffer.byteLength(request.params.input[0].text) <= 65_536);
  assert.equal(JSON.parse(request.params.input[0].text.split('\n').at(-1)).omittedHistoryCount, 2);
  complete(reader, valid);
  assert.deepEqual(reader.finish().conversation, valid);
  assert.equal(reader.finish().qualified, false);
  assert.equal(Object.hasOwn(reader.finish(), 'contextUsage'), false);
  assert.equal(reader.next(), null);
  const launch = {
    executable: process.execPath,
    sha256: '0'.repeat(64),
    directory: trusted.directory,
    repositoryRoot: trusted.directory,
    environment: {},
  };
  assert.throws(() => startConversation(launch, trusted, { timeoutMs: 60_001, onSubmitted() {} }));
  assert.throws(() =>
    startConversation({ ...launch, directory: resolve('internal/other') }, trusted, {
      timeoutMs: 60_000,
      onSubmitted() {},
    }),
  );
});

test('conversation turns use one correlated submission through owned native phases', async () => {
  mkdirSync(resolve('internal'), { recursive: true });
  const root = mkdtempSync(resolve('internal/conversation-owner-'));
  try {
    for (const mode of ['success', 'stopped', 'unknown'] as const) {
      const directory = resolve(root, mode);
      mkdirSync(directory, { mode: 0o700 });
      const input = plan(directory);
      const selectedText = 'Selected log text cannot grant execution.\n';
      const selectedMessageId = 'msg_01M51M322B2AEBXD9MA74CBCFM';
      const contextSource = { projectId: 'prj_01M51M322B2AEBXD9MA74CBCFM', base: 'a'.repeat(40) };
      const bundle = {
        version: 1 as const,
        ...contextSource,
        files: [
          {
            kind: 'log' as const,
            path: 'build.log',
            mode: '100644' as const,
            hash: createHash('sha256').update(selectedText).digest('hex'),
            bytes: Buffer.byteLength(selectedText),
            text: selectedText,
          },
        ],
      };
      const trusted = withSelection(
        conversationPlan({
          ...input,
          history: [{ ...input.history[0], messageId: selectedMessageId }],
          contextSource,
          contextAttachments: [
            {
              messageId: selectedMessageId,
              artifactId: 'art_01M51M322B2AEBXD9MA74CBCFM',
              hash: hashCanonical(bundle),
              bundle,
            },
          ],
        }),
      );
      const start = fixture.indexOf(
        '    const path = message.params.outputSchema.properties.path.const;',
      );
      const end = fixture.indexOf('    for (const [method,params]', start);
      assert(start > 0 && end > start);
      const transcript =
        fixture.slice(0, start) +
        `
    const task = JSON.parse(message.params.input[0].text.split('\\n').at(-1));
    const attachment = task.contextAttachments[0];
    if (attachment.messageId !== task.history[0].messageId || attachment.bundle.files[0].text !== ${JSON.stringify(selectedText)}) throw new Error('Selected context was not delivered intact.');
    const reply = {version:1,bindingHash:message.params.outputSchema.properties.bindingHash.const,message:'I need a boundary for: '+task.history.at(-1).text,questions:['Should the net total stop at zero?'],proposal:null};
    const item = {id:'message-1',type:'agentMessage',text:JSON.stringify(reply),phase:'final_answer'};
` +
        fixture.slice(end);
      const peer = transcript
        .replace(
          'let result = replies[message.method];',
          `let result = replies[message.method]; if (message.method === 'model/list' && phase === 'task') result = ${JSON.stringify(catalog)};`,
        )
        .replace(
          "if (message.method === 'thread/start') result = thread(process.cwd());",
          `if (message.method === 'thread/start') result = {...thread(process.cwd()),model:${JSON.stringify(requested.model)},reasoningEffort:${JSON.stringify(requested.effort)}};`,
        )
        .replace(
          "['turn/completed',{threadId:'thread-1',turn:{...running,status:'completed'}}],",
          "['thread/tokenUsage/updated',{threadId:'thread-1',turnId:'turn-1',tokenUsage:{total:{totalTokens:900000},last:{totalTokens:17},modelContextWindow:4096}}],\n      ['turn/completed',{threadId:'thread-1',turn:{...running,status:'completed'}}],",
        );
      const calls: { milliseconds: number; work: () => void; active: boolean }[] = [];
      const events: string[] = [];
      const methods: string[] = [];
      const groups: number[] = [];
      const children: { child: ChildProcessWithoutNullStreams; closed: Promise<void> }[] = [];
      let servers = 0;
      let submissions = 0;
      try {
        const handle = startConversation(
          {
            executable: process.execPath,
            sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
            directory,
            repositoryRoot: root,
            environment: { HOME: root, PATH: process.env.PATH },
          },
          trusted,
          {
            timeoutMs: 60_000,
            now: () => 1,
            schedule: (work, milliseconds) => {
              const call = { work, milliseconds, active: true };
              calls.push(call);
              return () => {
                call.active = false;
              };
            },
            onSubmitted: () => {
              submissions++;
            },
            lifecycle: {
              beforePhase: (phase) => {
                events.push(`before:${phase.sequence}:${phase.kind}`);
              },
              owned: (phase) => {
                events.push(`owned:${phase.sequence}`);
              },
              quiescent: (phase) => {
                events.push(`quiescent:${phase.sequence}`);
              },
            },
            spawn: (executable, args, options) => {
              assert(groups.every(groupAbsent));
              const phase =
                args.at(-1) === 'list' ? 'features' : ++servers === 1 ? 'prepare' : 'task';
              const child = spawnCheckChild(executable, ['-e', peer, 'success', phase], options);
              children.push({
                child,
                closed: new Promise((resolve) => child.once('close', () => resolve())),
              });
              if (child.pid) groups.push(child.pid);
              const write = child.stdin.write.bind(child.stdin);
              child.stdin.write = ((data: string | Uint8Array) => {
                assert(handle.groups.includes(child.pid as number));
                for (const line of Buffer.from(data).toString().trim().split('\n')) {
                  const message = JSON.parse(line);
                  methods.push(message.method);
                  if (message.method === 'thread/start') {
                    assert.equal(message.params.model, requested.model);
                    assert.equal(message.params.config.model_reasoning_effort, requested.effort);
                  }
                  if (message.method === 'turn/start') {
                    if (mode !== 'success')
                      child.stdout.once('data', () => {
                        handle.stop();
                        const grace = calls.findLast(
                          (call) =>
                            call.active && call.milliseconds === (mode === 'unknown' ? 2000 : 250),
                        );
                        assert(grace);
                        grace.work();
                      });
                    assert.equal(message.params.model, requested.model);
                    assert.equal(message.params.effort, requested.effort);
                    assert.equal(submissions, 1);
                    assert.deepEqual(message.params.sandboxPolicy, {
                      type: 'readOnly',
                      networkAccess: false,
                    });
                  }
                }
                return write(data);
              }) as typeof child.stdin.write;
              return child;
            },
          },
        );
        const result = await handle.result;
        if (mode === 'success') {
          assert.equal(result.reason, null);
          assert.deepEqual(result.metadata?.modelChoices, modelChoices);
          assert.equal(result.quiescent, true);
          assert.equal(result.metadata?.conversation.bindingHash, conversationBindingHash(trusted));
          assert.equal(
            result.metadata?.conversation.message,
            `I need a boundary for: ${trusted.history[0].text}`,
          );
          assert.equal(result.metadata?.qualified, false);
          assert.deepEqual(result.metadata?.contextUsage, {
            threadId: 'thread-1',
            turnId: 'turn-1',
            model: requested.model,
            usedTokens: 17,
            capacityTokens: 4096,
          });
        } else {
          assert.equal(result.metadata, null);
          assert.equal(result.reason, mode === 'unknown' ? 'ownership' : 'stopped');
          assert.equal(result.quiescent, mode !== 'unknown');
        }
        assert.equal(submissions, 1);
        assert.equal(methods.filter((method) => method === 'model/list').length, 2);
        assert.equal(methods.filter((method) => method === 'turn/start').length, 1);
        assert.equal(methods.filter((method) => method === 'thread/start').length, 1);
        assert.equal(handle.groups.length, 3);
        if (mode !== 'unknown') assert(handle.groups.every(groupAbsent));
        if (mode === 'success')
          assert.deepEqual(events, [
            'before:0:effective-features',
            'owned:0',
            'quiescent:0',
            'before:1:metadata-preparation',
            'owned:1',
            'quiescent:1',
            'before:2:app-server-task',
            'owned:2',
            'quiescent:2',
          ]);
        assert(!JSON.stringify(result).includes('private-diagnostic-canary'));
        assert(!JSON.stringify(result).includes('private-catalog-canary'));
      } finally {
        for (const { child } of children)
          if (child.pid && !groupAbsent(child.pid)) process.kill(-child.pid, 'SIGKILL');
        await Promise.all(children.map(({ closed }) => closed));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
