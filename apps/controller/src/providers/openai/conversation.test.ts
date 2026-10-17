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
import { fixture, replies, running, threadResult } from './replacement-fixture.ts';

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
const bytes = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);

function admit(reader: ConversationTranscript, directory: string) {
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
      reader.push(bytes({ id: request.id, result: threadResult(directory) }));
      break;
    }
    reader.push(bytes({ id: request.id, result: replies[request.method] }));
  }
  const next = reader.next();
  assert(next);
  const request = JSON.parse(Buffer.from(next).toString());
  assert.equal(request.method, 'turn/start');
  assert.deepEqual(request.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  reader.push(bytes({ id: request.id, result: { turn: running } }));
  return request;
}

function complete(reader: ConversationTranscript, value: unknown) {
  const item = {
    id: 'message-1',
    type: 'agentMessage',
    text: JSON.stringify(value),
    phase: 'final_answer',
  };
  for (const message of [
    { method: 'turn/started', params: { threadId: 'thread-1', turn: running } },
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
  const reader = new ConversationTranscript(trusted, { now: () => 1, timeoutMs: 60_000 });
  const request = admit(reader, trusted.directory);
  assert(Buffer.byteLength(request.params.input[0].text) <= 65_536);
  assert.equal(JSON.parse(request.params.input[0].text.split('\n').at(-1)).omittedHistoryCount, 2);
  complete(reader, valid);
  assert.deepEqual(reader.finish().conversation, valid);
  assert.equal(reader.finish().qualified, false);
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
  const directory = resolve(root, 'context');
  mkdirSync(directory, { mode: 0o700 });
  const trusted = plan(directory);
  const start = fixture.indexOf(
    '    const path = message.params.outputSchema.properties.path.const;',
  );
  const end = fixture.indexOf('    for (const [method,params]', start);
  assert(start > 0 && end > start);
  const peer =
    fixture.slice(0, start) +
    `
    const task = JSON.parse(message.params.input[0].text.split('\\n').at(-1));
    const reply = {version:1,bindingHash:message.params.outputSchema.properties.bindingHash.const,message:'I need a boundary for: '+task.history.at(-1).text,questions:['Should the net total stop at zero?'],proposal:null};
    const item = {id:'message-1',type:'agentMessage',text:JSON.stringify(reply),phase:'final_answer'};
` +
    fixture.slice(end);
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
        schedule: () => () => {},
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
          const phase = args.at(-1) === 'list' ? 'features' : ++servers === 1 ? 'prepare' : 'task';
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
              if (message.method === 'turn/start') {
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
    assert.equal(result.reason, null);
    assert.equal(result.quiescent, true);
    assert.equal(result.metadata?.conversation.bindingHash, conversationBindingHash(trusted));
    assert.equal(
      result.metadata?.conversation.message,
      `I need a boundary for: ${trusted.history[0].text}`,
    );
    assert.equal(result.metadata?.qualified, false);
    assert.equal(submissions, 1);
    assert.equal(methods.filter((method) => method === 'turn/start').length, 1);
    assert.equal(methods.filter((method) => method === 'thread/start').length, 1);
    assert.equal(handle.groups.length, 3);
    assert(handle.groups.every(groupAbsent));
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
  } finally {
    for (const { child } of children)
      if (child.pid && !groupAbsent(child.pid)) process.kill(-child.pid, 'SIGKILL');
    await Promise.all(children.map(({ closed }) => closed));
    rmSync(root, { recursive: true, force: true });
  }
});
