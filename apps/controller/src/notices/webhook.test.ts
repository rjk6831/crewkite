import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  ChatFamily,
  ChatThread,
  CommandResult,
  Event,
  Project,
  Task,
  WebhookBody,
  WebhookEventKind,
} from '@crewkite/contracts';
import { createDemoFixtures, createTestClock, createTestIds } from '@crewkite/testkit';
import {
  type ChatScriptStep,
  createScriptedChatAdapter,
  type ScriptedChatRequest,
} from '@crewkite/testkit/chat-adapter';
import { createSyntheticRepository } from '@crewkite/testkit/repository';
import { ArtifactFiles } from '../artifacts/index.ts';
import { type ChatAdapter, chatFailure } from '../chat/adapter.ts';
import { ChatService } from '../chat/service.ts';
import { RemoteEffects } from '../github/effects.ts';
import type { PlanEvent } from '../recipes/events.ts';
import { installedTools, setup } from '../store/controller-fixture.ts';
import { Store } from '../store/index.ts';
import { WebhookNotifier } from './webhook.ts';

const selection = { family: 'openai', model: 'fixture-model', effort: 'default' } as const;
const ADDRESS = 'https://hooks.example.com/crewkite';

type Call = { url: string; body: WebhookBody };

// A controller on a temp SQLite home with a scripted chat adapter and a fetch that records each
// post. PATH holds git alone, so no installed gh or provider client is ever found.
async function open(t: TestContext, turns: ChatScriptStep[][], fetch?: typeof globalThis.fetch) {
  const tools = mkdtempSync(join(tmpdir(), 'ck-webhook-'));
  t.after(() => rmSync(tools, { recursive: true, force: true }));
  const calls: Call[] = [];
  const logs: string[] = [];
  const recorder = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as WebhookBody });
    return new Response('', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const context = await setup(t, {
    chatAdapters: new Map([['openai', createScriptedChatAdapter({ family: 'openai', turns })]]),
    identity: { name: 'Fixture owner', email: 'owner@example.invalid' },
    gitEnvironment: { HOME: tools, PATH: installedTools(tools, 'git') },
    webhookFetch: fetch ?? recorder,
    webhookLog: (line) => logs.push(line),
  });
  const { controller, command } = context;
  const task = (await controller.execute(context.draft, 'local-owner')).entity as Task;
  const run = (name: string, payload: object, revision?: number) =>
    controller.execute(command(name, { taskId: task.id, ...payload }, revision), 'local-owner');
  const setAddress = (url: string) =>
    controller.execute(command('SetWebhook', { url }, 0), 'local-owner');
  const until = (match: (event: Event) => boolean) =>
    new Promise<Event>((resolve) => {
      const stop = controller.store.subscribe((event) => {
        if (!match(event)) return;
        stop();
        resolve(event);
      });
    });
  return { controller, task, run, setAddress, calls, logs, until, command };
}

const turnEnds = (event: Event) =>
  event.type === 'chat.turn' && ['done', 'failed', 'stopped'].includes(event.payload.state);
const reply = (text: string): ChatScriptStep[] => [{ kind: 'text', itemId: 'r', chunks: [text] }];

type Posted = { kind: WebhookEventKind; line: string };
/** The PATH this file started with. Each service harness narrows it to git while it runs. */
const PATH = process.env.PATH;

/**
 * A chat service on a temp SQLite home, the way the plan tests build one, with one scripted
 * adapter per family, a catalog that lists those families as connected, and a notice listener
 * that records what it hears. PATH holds git alone while it runs. `start` builds another service
 * on the same store, the way a restart does.
 */
function service(
  t: TestContext,
  scripts: Partial<Record<ChatFamily, ChatScriptStep[][]>>,
  options: {
    /** The clock moves a second with every reading. */
    ticking?: true;
    /** OpenAI turns, by the order they start, that the client ends on its own, with its reason. */
    clientEnds?: Record<number, string | null>;
    /** The thread tools socket is down, so each cloud turn says so as it starts. */
    toolsDown?: true;
  } = {},
) {
  // The real path, so an edit the client names inside the copy reads as inside it.
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'ck-notices-'));
  process.env.PATH = PATH;
  process.env.PATH = installedTools(directory, 'git', 'node');
  t.after(() => {
    process.env.PATH = PATH;
    rmSync(directory, { recursive: true, force: true });
  });
  const clock = createTestClock();
  const ids = createTestIds(clock.now());
  const fixtures = createDemoFixtures(clock.now());
  const repository = createSyntheticRepository(join(directory, 'demo-shop'));
  const store = new Store(join(directory, 'state.sqlite'));
  t.after(() => store.close());
  store.applyMigrations(fileURLToPath(new URL('../../migrations/', import.meta.url)));
  const project: Project = { id: fixtures.task.projectId, name: 'demo-shop', revision: 0 };
  store.transaction(() => {
    store.put('project', project.id, 0, project);
    store.put('task', fixtures.task.id, 0, fixtures.task);
  });
  const taskId = fixtures.task.id;
  const families = Object.keys(scripts) as ChatFamily[];
  const ends = options.clientEnds ?? {};
  let started = 0;
  const adapters = new Map(
    families.map((family) => {
      const scripted = createScriptedChatAdapter({ family, turns: scripts[family] ?? [] });
      if (family !== 'openai') return [family, scripted] as const;
      const ending: ChatAdapter = {
        ...scripted,
        startTurn(request, emit) {
          const index = started++;
          const handle = scripted.startTurn(request as ScriptedChatRequest, emit);
          if (!(index in ends)) return handle;
          const reason = ends[index];
          return {
            ...handle,
            result: handle.result.then((result) => ({
              ...result,
              stopReason: 'stopped' as const,
              failure: reason
                ? chatFailure({ stage: 'stream', kind: 'client-exit', message: reason })
                : null,
            })),
          };
        },
      };
      return [family, ending] as const;
    }),
  );
  let at = Date.parse(clock.now());
  const now = options.ticking
    ? () => {
        at += 1000;
        return new Date(at).toISOString();
      }
    : clock.now;
  const observed: PlanEvent[] = [];
  const posted: Posted[] = [];
  const seen = clock.now();
  // A family named here has no allowance left and credit spending off.
  const exhausted = new Set<ChatFamily>();
  const start = () =>
    new ChatService({
      store,
      artifacts: new ArtifactFiles(join(directory, 'artifacts')),
      home: directory,
      googleTermsAcknowledged: () => true,
      now,
      id: (prefix) => (prefix === 'trn' ? `trn_${ids('msg').slice(4)}` : ids(prefix)),
      emit: (type, task, revision, payload) =>
        store.append({
          protocol: 1,
          id: ids('evt'),
          at: now(),
          taskId: task,
          revision,
          type,
          payload,
        }),
      adapters,
      resolveEnvironment: () => ({}),
      projectPath: () => repository.directory,
      resolveSelection: (_taskId, value) => value ?? null,
      // OpenAI has the least allowance left, so a handoff moves to the other family.
      catalog: () => ({
        families: families.map((family) => ({
          family,
          connected: true,
          reason: null,
          models: [
            {
              model: `${family}-model`,
              label: family,
              efforts: ['default'],
              defaultEffort: 'default',
            },
          ],
          defaultModel: `${family}-model`,
          remaining: [
            {
              windowId: 'weekly',
              label: 'weekly',
              percent: exhausted.has(family) ? 0 : family === 'openai' ? 10 : 60,
              resetsAt: null,
              observedAt: seen,
            },
          ],
          accepts: null,
          ...(exhausted.has(family)
            ? {
                creditSpending: false,
                credits: {
                  state: 'available',
                  balance: '5',
                  limitReached: false,
                  observedAt: seen,
                },
              }
            : {}),
        })),
      }),
      remoteEffects: new RemoteEffects({
        store,
        home: directory,
        now: clock.now,
        id: () => ids('rfx'),
        projectPath: () => repository.directory,
      }),
      ...(options.toolsDown ? { threadToolsDown: () => true } : {}),
      observe: (event) => observed.push(event),
      notice: (event) => {
        assert.equal(event.taskId, taskId);
        posted.push({ kind: event.kind, line: event.line });
      },
    });
  const chat = start();
  t.after(() => chat.close());
  const act = (work: (effects: (() => void)[]) => CommandResult) => {
    const effects: (() => void)[] = [];
    const result = store.transaction(() => work(effects));
    for (const effect of effects) effect();
    return result;
  };
  const on = (family: ChatFamily) =>
    ({ family, model: `${family}-model`, effort: 'default' }) as const;
  const send = (text: string, role: 'assistant' | 'fixer' | 'reviewer' | 'advisor' = 'assistant') =>
    act((effects) =>
      chat.sendMessage(
        { taskId, text, role, attachments: [], files: [], selection: on('openai') },
        effects,
      ),
    );
  const configure = (patch: object) =>
    assert.equal(
      store.transaction(() => chat.configure({ taskId, ...patch })).outcome,
      'applied',
      JSON.stringify(patch),
    );
  const until = (match: (event: Event) => boolean) =>
    new Promise<Event>((resolve) => {
      const stop = store.subscribe((event) => {
        if (!match(event)) return;
        stop();
        resolve(event);
      });
    });
  const read = (to = chat) => to.readThread({ taskId, limit: 100 });
  // Notices go out a microtask after their commit, and a step after an ending runs on later ones.
  const quiet = async () => {
    for (let n = 0; n < 5; n++) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    chat,
    start,
    store,
    taskId,
    posted,
    act,
    send,
    configure,
    until,
    read,
    on,
    quiet,
    exhausted,
    observed,
    root: repository.directory,
  };
}

const lineIs = (pattern: RegExp) => (event: Event) =>
  event.type === 'conversation.entry' && pattern.test((event.payload as { text: string }).text);
const turnIn = (state: string, role?: string) => (event: Event) =>
  event.type === 'chat.turn' &&
  event.payload.state === state &&
  (role === undefined || event.payload.role === role);

const limit = chatFailure({ stage: 'stream', kind: 'usage-limit', message: 'Limit.' });
const broken = chatFailure({ stage: 'stream', kind: 'client-exit', message: 'It exited.' });
const fail = (failure: typeof limit, stopReason: 'limit' | 'error'): ChatScriptStep[] => [
  { kind: 'fail', stopReason, failure },
];
const park: ChatScriptStep[] = [{ kind: 'permission', requestId: 'park', question: 'Go on?' }];
const solo = {
  name: 'Solo',
  members: [
    { role: 'builder', selection: { family: 'openai', model: 'openai-model', effort: 'default' } },
  ],
};

// Claim: a turn the person sent posts finished when nothing follows it, failed or limit when it
// does not end done, and nothing for a limit that moves to another family. A Solo gate decides
// how its work ended. A question posts once it waits for the person, and one the controller or
// the client answers, or that Run tests raises for the person who pressed it, posts nothing. A
// thread deleted first posts nothing.
test('a turn the person sent, its gate and its questions post what the person needs to know', {
  timeout: 60000,
}, async (t) => {
  const rows: {
    name: string;
    scripts: Partial<Record<ChatFamily, ChatScriptStep[][]>>;
    options?: Parameters<typeof service>[2];
    configure?: object;
    role?: 'fixer' | 'reviewer' | 'advisor';
    ends: (event: Event) => boolean;
    stop?: true;
    /** Runs before the message is sent. */
    before?: (thread: ReturnType<typeof service>) => void;
    /** Starts the work in place of the message. */
    start?: (thread: ReturnType<typeof service>) => void;
    /** The first post's line, when the row names it. */
    line?: string | RegExp;
    expect: WebhookEventKind[];
  }[] = [
    {
      name: 'a Solo builder in Glide',
      scripts: { openai: [reply('Built.')] },
      configure: { crew: solo, flightMode: 'glide', permissionPolicy: 'allow-all' },
      ends: turnIn('done'),
      expect: ['finished'],
    },
    {
      name: 'a Manual thread',
      scripts: { openai: [reply('Done.')] },
      ends: turnIn('done'),
      expect: ['finished'],
    },
    {
      name: 'a limit with nothing to move it on',
      scripts: { openai: [fail(limit, 'limit')] },
      ends: turnIn('failed'),
      expect: ['limit'],
    },
    {
      name: 'a limit that moves to another family',
      scripts: { openai: [fail(limit, 'limit')], anthropic: [reply('Done there.')] },
      configure: { autoHandoff: true },
      ends: turnIn('done'),
      expect: ['finished'],
    },
    {
      name: 'a question for the person, then the person stops the turn',
      scripts: { openai: [park] },
      ends: (event) =>
        event.type === 'agent.event' && event.payload.type === 'permission.requested',
      stop: true,
      expect: ['approval-needed'],
    },
    {
      name: 'a question the controller answers itself',
      scripts: {
        openai: [
          [
            { kind: 'permission', requestId: 'edit', question: 'Edit net.mjs?' },
            {
              kind: 'tool',
              callId: 'w',
              toolKind: 'edit',
              title: 'Write net.mjs',
              write: { path: 'net.mjs', content: 'export const net = 1;\n' },
            },
            ...reply('Edited.'),
          ],
        ],
      },
      configure: { crew: solo, flightMode: 'balanced' },
      ends: turnIn('done'),
      expect: ['finished'],
    },
    {
      // The client's own policy answers the ask as it is asked.
      name: 'allow-all with a permission step',
      scripts: { openai: [[...park, ...reply('Went on.')]] },
      configure: { crew: solo, flightMode: 'glide', permissionPolicy: 'allow-all' },
      ends: turnIn('done'),
      expect: ['finished'],
    },
    {
      name: 'a fixer turn the person sent that ends done',
      scripts: { openai: [reply('Fixed.')] },
      role: 'fixer',
      ends: turnIn('done'),
      expect: ['finished'],
    },
    {
      name: 'a fixer turn the person sent that fails',
      scripts: { openai: [fail(broken, 'error')] },
      role: 'fixer',
      ends: turnIn('failed'),
      expect: ['failed'],
    },
    {
      name: 'a fixer turn the person sent that stops at a limit',
      scripts: { openai: [fail(limit, 'limit')] },
      role: 'fixer',
      ends: turnIn('failed'),
      expect: ['limit'],
    },
    {
      name: "the checks' question after a writing turn",
      scripts: { openai: [reply('Built.')] },
      configure: { crew: solo, flightMode: 'balanced', checks: { add: 'node --version' } },
      ends: (event) => event.type === 'chat.thread' && !!(event.payload as ChatThread).checks?.ask,
      expect: ['approval-needed'],
    },
    {
      // Each gate fails, so the fixer runs twice and the chain goes on with the checks failing.
      name: 'a chain whose last gate still fails',
      scripts: { openai: [reply('Built.'), reply('Fixed.'), reply('Fixed again.')] },
      configure: {
        crew: solo,
        flightMode: 'glide',
        permissionPolicy: 'allow-all',
        checks: { add: 'node --no-such-flag' },
      },
      ends: lineIs(/^Crew finished/),
      expect: ['failed'],
    },
    {
      // The thread goes before the ending's notice leaves, so nothing is posted.
      name: 'a deleted thread',
      scripts: { openai: [reply('Done.')] },
      ends: turnIn('done'),
      before: (thread) => {
        const stop = thread.store.subscribe((event) => {
          if (!turnIn('done')(event)) return;
          stop();
          queueMicrotask(() =>
            thread.act((effects) => thread.chat.deleteThread({ taskId: thread.taskId }, effects)),
          );
        });
      },
      expect: [],
    },
    {
      name: 'a turn the provider client ended with its reason',
      scripts: { openai: [reply('Half.')] },
      options: { clientEnds: { 0: 'The client quit.' } },
      ends: turnIn('stopped'),
      line: 'Stopped: The client quit.',
      expect: ['failed'],
    },
    {
      name: 'a turn the provider client ended with no reason',
      scripts: { openai: [reply('Half.')] },
      options: { clientEnds: { 0: null } },
      ends: turnIn('stopped'),
      line: 'Stopped: the provider ended the turn.',
      expect: ['failed'],
    },
    {
      // The turn says the tools are down as it starts. The line posted is the one it ended with.
      name: 'a failed turn whose first line was written at its start',
      scripts: { openai: [fail(broken, 'error')] },
      options: { toolsDown: true },
      ends: turnIn('failed'),
      line: /^It exited\./,
      expect: ['failed'],
    },
    {
      name: 'a turn sent to the reviewer',
      scripts: { openai: [reply('Looks right.')] },
      role: 'reviewer',
      ends: turnIn('done'),
      expect: ['finished'],
    },
    {
      name: 'a turn sent to the advisor',
      scripts: { openai: [reply('Keep it small.')] },
      role: 'advisor',
      ends: turnIn('done'),
      expect: ['finished'],
    },
    {
      name: 'the question Run tests raises',
      scripts: { openai: [] },
      ends: (event) => event.type === 'chat.thread' && !!(event.payload as ChatThread).checks?.ask,
      start: (thread) => {
        writeFileSync(
          join(thread.root, 'package.json'),
          JSON.stringify({ scripts: { test: 'node --version' } }),
        );
        thread.configure({ checks: { refresh: true } });
        assert.equal(
          thread.act((effects) => thread.chat.runTests({ taskId: thread.taskId }, effects)).outcome,
          'applied',
        );
      },
      expect: [],
    },
    {
      // The first gate fails and the fixer makes it pass. The clock moves with every reading, so
      // nothing tells the two gates apart by time.
      name: 'a Solo check that passes after one fix',
      scripts: {
        openai: [
          [writeStep('gate.mjs', GATE), ...reply('Built.')],
          [writeStep('fixed.txt', 'yes\n'), ...reply('Fixed.')],
        ],
      },
      options: { ticking: true },
      before: (thread) => {
        writeFileSync(join(thread.root, 'gate.mjs'), GATE);
        thread.configure({
          crew: solo,
          flightMode: 'glide',
          permissionPolicy: 'allow-all',
          checks: { add: 'node gate.mjs' },
        });
      },
      ends: lineIs(/^Crew finished/),
      expect: ['finished'],
    },
    {
      // The same on a clock that stands still, where every run and turn carries one time.
      name: 'a Solo check that passes after one fix, on a clock that stands still',
      scripts: {
        openai: [
          [writeStep('gate.mjs', GATE), ...reply('Built.')],
          [writeStep('fixed.txt', 'yes\n'), ...reply('Fixed.')],
        ],
      },
      before: (thread) => {
        writeFileSync(join(thread.root, 'gate.mjs'), GATE);
        thread.configure({
          crew: solo,
          flightMode: 'glide',
          permissionPolicy: 'allow-all',
          checks: { add: 'node gate.mjs' },
        });
      },
      ends: lineIs(/^Crew finished/),
      expect: ['finished'],
    },
  ];
  for (const row of rows) {
    const thread = service(t, row.scripts, row.options);
    if (row.configure) thread.configure(row.configure);
    row.before?.(thread);
    const ended = thread.until(row.ends);
    if (row.start) row.start(thread);
    else assert.equal(thread.send('Go.', row.role).outcome, 'applied', row.name);
    const last = await ended;
    await thread.quiet();
    if (row.stop) {
      const turnId = (last.payload as { turnId: string }).turnId;
      const stopped = thread.until(turnIn('stopped'));
      thread.act((effects) => thread.chat.stopTurn({ taskId: thread.taskId, turnId }, effects));
      await stopped;
      await thread.quiet();
    }
    assert.deepEqual(
      thread.posted.map((item) => item.kind),
      row.expect,
      row.name,
    );
    if (typeof row.line === 'string') assert.equal(thread.posted[0]?.line, row.line, row.name);
    else if (row.line) assert.match(thread.posted[0]?.line ?? '', row.line, row.name);
  }
});

const BLOCK = 'setInterval(() => {}, 60_000);\n';
/** A check that fails until the fixer writes fixed.txt into the copy. */
const GATE =
  "import { existsSync } from 'node:fs';\nprocess.exit(existsSync('fixed.txt') ? 0 : 1);\n";
const writeStep = (path: string, content: string): ChatScriptStep => ({
  kind: 'tool',
  callId: `w-${path}`,
  toolKind: 'edit',
  title: `Write ${path}`,
  write: { path, content },
});
const pair = {
  name: 'Pair',
  members: [
    { role: 'builder', selection: { family: 'openai', model: 'openai-model', effort: 'default' } },
    { role: 'reviewer', selection: { family: 'openai', model: 'openai-model', effort: 'default' } },
  ],
};

// Claim: a crew chain posts once, when it ends: finished with its own line, failed when a step
// fails, and nothing when the person stops it. The builder turn that starts it and each step
// inside it post nothing.
test('a crew chain posts once at its end and nothing when the person stops it', {
  timeout: 60000,
}, async (t) => {
  const rows: {
    name: string;
    openai: ChatScriptStep[][];
    ends: RegExp;
    stop?: true;
    checks?: string;
    stopChecks?: true;
    rollBack?: true;
    options?: Parameters<typeof service>[2];
    expect: Posted[];
  }[] = [
    {
      name: 'a clean review',
      openai: [reply('Built.'), reply('Looks right.\nFindings: 0')],
      ends: /^Crew finished/,
      expect: [{ kind: 'finished', line: 'Crew finished: 1 review round, 0 fixes.' }],
    },
    {
      name: 'a fix round',
      openai: [
        reply('Built.'),
        reply('Rounding drops a cent.\nFindings: 1'),
        reply('Fixed.'),
        reply('Looks right.\nFindings: 0'),
      ],
      ends: /^Crew finished/,
      expect: [{ kind: 'finished', line: 'Crew finished: 2 review rounds, 1 fix.' }],
    },
    {
      name: 'a review that fails',
      openai: [reply('Built.'), fail(broken, 'error')],
      ends: /^Crew stopped/,
      expect: [{ kind: 'failed', line: 'Crew stopped: the review failed.' }],
    },
    {
      name: 'a review the person stops',
      openai: [reply('Built.'), [{ kind: 'wait' }]],
      ends: /^Crew stopped/,
      stop: true,
      expect: [],
    },
    {
      name: 'a review that stops at a limit',
      openai: [reply('Built.'), fail(limit, 'limit')],
      ends: /^Crew stopped/,
      expect: [{ kind: 'limit', line: 'Crew stopped: OpenAI reached its usage limit.' }],
    },
    {
      // The builder writes a check that runs until it is stopped.
      name: 'a gate check the person stops',
      openai: [
        [
          {
            kind: 'tool',
            callId: 'w',
            toolKind: 'edit',
            title: 'Write block.mjs',
            write: { path: 'block.mjs', content: BLOCK },
          },
          ...reply('Built.'),
        ],
      ],
      checks: 'node block.mjs',
      ends: /^Crew stopped/,
      stopChecks: true,
      expect: [],
    },
    {
      name: 'a review the provider client ended',
      openai: [reply('Built.'), reply('Half a review.')],
      options: { clientEnds: { 1: 'The client quit.' } },
      ends: /^Crew stopped/,
      expect: [{ kind: 'failed', line: 'Crew stopped: the provider ended the turn.' }],
    },
    {
      // The commit that ends the chain rolls back, so its finished line never stands and posts
      // nothing. The chain then stops with the failure's own line, in a commit of its own, and
      // that posts failed once. A chain left as it was would read as never ended.
      name: 'a chain end that rolls back',
      openai: [reply('Built.'), reply('Looks right.\nFindings: 0')],
      ends: /^$/,
      rollBack: true,
      expect: [
        {
          kind: 'failed',
          line: 'Crew stopped: the next step could not start. The commit rolls back.',
        },
      ],
    },
  ];
  for (const row of rows) {
    const thread = service(t, { openai: row.openai }, row.options);
    thread.configure({ crew: pair, flightMode: 'glide', permissionPolicy: 'allow-all' });
    // The check's file sits in the project with the bytes the builder writes into the copy, so
    // the check reads as unchanged since it was turned on and asks nothing.
    if (row.checks) {
      writeFileSync(join(thread.root, 'block.mjs'), BLOCK);
      thread.configure({ checks: { add: row.checks } });
    }
    const ended = row.rollBack
      ? thread.until(turnIn('done', 'reviewer'))
      : thread.until(lineIs(row.ends));
    if (row.rollBack) {
      // The commit after the review's own is the chain's, and it throws once its work is done.
      const store = thread.store;
      const transaction = store.transaction.bind(store);
      let armed = false;
      const stop = store.subscribe((event) => {
        if (turnIn('done', 'reviewer')(event)) {
          stop();
          armed = true;
        }
      });
      store.transaction = <T>(work: () => T): T =>
        transaction(() => {
          const result = work();
          if (!armed) return result;
          armed = false;
          throw new Error('The commit rolls back.');
        });
      t.after(() => {
        store.transaction = transaction;
      });
    }
    if (row.stop) {
      const reviewing = thread.until(turnIn('running', 'reviewer'));
      thread.send('Go.');
      const turnId = ((await reviewing).payload as { id: string }).id;
      thread.act((effects) => thread.chat.stopTurn({ taskId: thread.taskId, turnId }, effects));
    } else if (row.stopChecks) {
      const built = thread.until(turnIn('done', 'assistant'));
      const checking = thread.until(
        (event) =>
          event.type === 'chat.thread' &&
          (event.payload as ChatThread).checks?.runs.at(-1)?.status === 'running',
      );
      thread.send('Go.');
      const turnId = ((await built).payload as { id: string }).id;
      await checking;
      thread.act((effects) => thread.chat.stopTurn({ taskId: thread.taskId, turnId }, effects));
    } else thread.send('Go.');
    await ended;
    await thread.quiet();
    assert.deepEqual(thread.posted, row.expect, row.name);
  }
});

const sliceOf = (id: number) => ({
  id,
  title: `Part ${id}`,
  brief: `Do part ${id}.`,
  files: [],
  depends: [],
  difficulty: 'medium',
  readOnly: false,
});
const planOf = (count: number) =>
  reply(
    `\`\`\`json plan\n${JSON.stringify({
      planId: 'p1',
      goal: 'Split it.',
      slices: Array.from({ length: count }, (_, at) => sliceOf(at + 1)),
    })}\n\`\`\``,
  );
const planned = {
  name: 'Planned',
  members: [
    { role: 'builder', selection: { family: 'openai', model: 'openai-model', effort: 'default' } },
    {
      role: 'orchestrator',
      selection: { family: 'openai', model: 'openai-model', effort: 'default' },
    },
  ],
};

// Claim: a plan posts once for how it ends, from the branch that ends it: finished at its end,
// failed when a slice fails, approval-needed once when it waits for the person, and nothing for a
// cancel, a slice turn the person stops, a pause or a restart. A question inside a slice still
// reaches the person, and a later failure in the same thread still posts.
test('a plan posts once for how it ends and nothing the person caused', {
  timeout: 120000,
}, async (t) => {
  const rows: {
    name: string;
    openai: ChatScriptStep[][];
    mode?: 'balanced';
    policy?: 'ask';
    options?: Parameters<typeof service>[2];
    run: (thread: ReturnType<typeof service>) => Promise<void>;
    /** The first post's line, when the row names it. */
    line?: string;
    expect: WebhookEventKind[];
  }[] = [
    {
      name: 'a plan that runs to its end',
      openai: [planOf(1), reply('Built.')],
      run: async (thread) => {
        const ended = thread.until(lineIs(/^Crew finished/));
        thread.send('Plan it.');
        await ended;
      },
      expect: ['finished'],
    },
    {
      name: 'a slice that fails',
      openai: [planOf(1), fail(broken, 'error')],
      run: async (thread) => {
        const ended = thread.until(lineIs(/^Plan stopped/));
        thread.send('Plan it.');
        await ended;
      },
      expect: ['failed'],
    },
    {
      name: 'a plan that waits for approval, then a failed turn',
      openai: [planOf(1), fail(broken, 'error')],
      mode: 'balanced',
      run: async (thread) => {
        const proposed = thread.until(turnIn('done', 'orchestrator'));
        thread.send('Plan it.');
        await proposed;
        await thread.quiet();
        const failed = thread.until(turnIn('failed'));
        thread.send('Try something else.');
        await failed;
      },
      line: 'waiting for approval',
      expect: ['approval-needed', 'failed'],
    },
    {
      name: 'a slice the provider client ended',
      openai: [planOf(1), reply('Half built.')],
      options: { clientEnds: { 1: null } },
      run: async (thread) => {
        const ended = thread.until(lineIs(/^Plan stopped/));
        thread.send('Plan it.');
        await ended;
      },
      line: 'Plan stopped: the provider ended the turn.',
      expect: ['failed'],
    },
    {
      // The slice's checks wait on the person, who switches the thread to Manual and then allows
      // them. The plan stops for the person's switch, and the run's plan ends stopped.
      name: "a switch to Manual while a plan's question waits",
      openai: [planOf(1), reply('Built.')],
      policy: 'ask',
      run: async (thread) => {
        thread.configure({ checks: { add: 'node --version' } });
        const built = thread.until(turnIn('done', 'assistant'));
        const asked = thread.until(
          (event) => event.type === 'chat.thread' && !!(event.payload as ChatThread).checks?.ask,
        );
        thread.send('Plan it.');
        const turnId = ((await built).payload as { id: string }).id;
        await asked;
        thread.configure({ flightMode: 'manual' });
        const requestId = thread.read().thread.checks?.ask?.requestId ?? '';
        const ended = thread.until(lineIs(/^Plan stopped/));
        thread.act((effects) =>
          thread.chat.resolvePermission(
            { taskId: thread.taskId, turnId, requestId, choice: 'allow' },
            effects,
          ),
        );
        await ended;
        await thread.quiet();
        const last = thread.observed.findLast((event) => event.kind === 'plan-ended');
        assert.equal(last?.kind === 'plan-ended' && last.outcome, 'stopped');
      },
      expect: ['approval-needed'],
    },
    {
      name: 'a plan the person cancels',
      openai: [planOf(1), [{ kind: 'wait' }]],
      run: async (thread) => {
        const building = thread.until(turnIn('running', 'assistant'));
        thread.send('Plan it.');
        await building;
        const ended = thread.until(lineIs(/^Plan stopped/));
        thread.act((effects) =>
          thread.chat.cancelPlan({ taskId: thread.taskId, planId: 'p1' }, effects),
        );
        await ended;
      },
      expect: [],
    },
    {
      name: 'a slice turn the person stops',
      openai: [planOf(1), [{ kind: 'wait' }]],
      run: async (thread) => {
        const building = thread.until(turnIn('running', 'assistant'));
        thread.send('Plan it.');
        const turnId = ((await building).payload as { id: string }).id;
        const ended = thread.until(lineIs(/^Plan stopped/));
        thread.act((effects) => thread.chat.stopTurn({ taskId: thread.taskId, turnId }, effects));
        await ended;
      },
      expect: [],
    },
    {
      name: 'one slice run alone, then the plan pauses',
      openai: [planOf(2), reply('Built.')],
      mode: 'balanced',
      run: async (thread) => {
        const proposed = thread.until(turnIn('done', 'orchestrator'));
        thread.send('Plan it.');
        await proposed;
        const paused = thread.until(lineIs(/^Plan paused/));
        thread.act((effects) =>
          thread.chat.runPlan({ taskId: thread.taskId, planId: 'p1', sliceId: 1 }, effects),
        );
        await paused;
      },
      expect: ['approval-needed'],
    },
    {
      name: 'a question inside a slice',
      openai: [planOf(1), park],
      policy: 'ask',
      run: async (thread) => {
        const asked = thread.until(
          (event) => event.type === 'agent.event' && event.payload.type === 'permission.requested',
        );
        thread.send('Plan it.');
        await asked;
        await thread.quiet();
        const ended = thread.until(lineIs(/^Plan stopped/));
        thread.act((effects) =>
          thread.chat.cancelPlan({ taskId: thread.taskId, planId: 'p1' }, effects),
        );
        await ended;
      },
      expect: ['approval-needed'],
    },
    {
      name: 'a slice that stops at a limit',
      openai: [planOf(1), fail(limit, 'limit')],
      run: async (thread) => {
        const ended = thread.until(lineIs(/^Plan stopped/));
        thread.send('Plan it.');
        await ended;
      },
      expect: ['limit'],
    },
    {
      name: 'an orchestrator answer with no plan',
      openai: [reply('Two parts would be too many for this.')],
      run: async (thread) => {
        const answered = thread.until(turnIn('done', 'orchestrator'));
        thread.send('Plan it.');
        await answered;
      },
      expect: ['finished'],
    },
    {
      // OpenAI runs out after the plan is made, and no other family can take the slice.
      name: 'a plan paused for credits',
      openai: [planOf(1)],
      mode: 'balanced',
      run: async (thread) => {
        const proposed = thread.until(turnIn('done', 'orchestrator'));
        thread.send('Plan it.');
        await proposed;
        thread.exhausted.add('openai');
        const paused = thread.until(lineIs(/^Plan paused/));
        thread.act((effects) =>
          thread.chat.runPlan({ taskId: thread.taskId, planId: 'p1' }, effects),
        );
        await paused;
      },
      expect: ['approval-needed', 'limit'],
    },
    {
      name: 'a restart while a slice runs',
      openai: [planOf(1), [{ kind: 'wait' }]],
      run: async (thread) => {
        const building = thread.until(turnIn('running', 'assistant'));
        thread.send('Plan it.');
        await building;
        const restarted = thread.start();
        t.after(() => restarted.close());
        restarted.recover();
        assert.equal(thread.read(restarted).thread.plan?.phase, 'stopped');
      },
      expect: [],
    },
  ];
  for (const row of rows) {
    const thread = service(t, { openai: row.openai }, row.options);
    thread.configure({
      crew: planned,
      flightMode: row.mode ?? 'glide',
      permissionPolicy: row.policy ?? 'allow-all',
    });
    await row.run(thread);
    await thread.quiet();
    assert.deepEqual(
      thread.posted.map((item) => item.kind),
      row.expect,
      row.name,
    );
    if (row.line) assert.equal(thread.posted[0]?.line, row.line, row.name);
  }
});

test('a failed post is tried twice and dropped, and close waits on nothing', {
  timeout: 30000,
}, async (t) => {
  let attempts = 0;
  let tried!: () => void;
  const second = new Promise<void>((resolve) => {
    tried = resolve;
  });
  const down = (async () => {
    attempts += 1;
    if (attempts === 2) tried();
    throw new TypeError('offline');
  }) as unknown as typeof fetch;
  const failing = await open(t, [reply('Done.')], down);
  await failing.setAddress(ADDRESS);
  await failing.run('SendChatMessage', { text: 'Go.', selection }, failing.task.revision);
  await second;
  await Promise.resolve();
  assert.equal(attempts, 2);
  assert.equal(failing.logs.length, 2);

  // A post that ignores its abort signal and never answers. Close aborts it and returns, so it
  // fails if close waits on the post.
  const signals: AbortSignal[] = [];
  const posting = Promise.withResolvers<void>();
  const hung = ((_url: string, init: RequestInit) => {
    signals.push(init.signal as AbortSignal);
    posting.resolve();
    return new Promise<Response>(() => {});
  }) as unknown as typeof fetch;
  const stuck = await open(t, [reply('Done.')], hung);
  await stuck.setAddress(ADDRESS);
  await stuck.run('SendChatMessage', { text: 'Go.', selection }, stuck.task.revision);
  await posting.promise;
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, false);
  await stuck.controller.close();
  assert.equal(signals[0]?.aborted, true);
  assert.equal(signals.length, 1);
});

test('an address that is not https or this computer is refused and nothing is saved', {
  timeout: 30000,
}, async (t) => {
  const { calls, setAddress, run, until, task, controller, command } = await open(t, [
    reply('Done.'),
  ]);
  const saved = async () =>
    (await controller.execute(command('ReadWebhook', {}), 'local-owner')).data;
  assert.deepEqual(await saved(), { kind: 'webhook', url: null });

  for (const url of [
    'http://example.com/hook',
    'http://192.168.1.5/hook',
    'https://user:pw@example.com/',
    'ftp://example.com/',
    'not a url',
    // Short as typed, past the bound once it is percent-encoded.
    `https://example.com/${'é'.repeat(800)}`,
  ]) {
    const refused = await setAddress(url);
    assert.equal(refused.outcome, 'blocked', url);
    assert.equal(refused.reason, 'webhook-address-invalid', url);
    assert.deepEqual(await saved(), { kind: 'webhook', url: null }, url);
  }

  for (const url of [
    'http://127.0.0.1:8080/hook',
    'http://localhost:8080/hook',
    'http://[::1]:8080/hook',
  ]) {
    const answer = await setAddress(url);
    assert.equal(answer.outcome, 'applied', url);
    assert.equal(answer.data, undefined, url);
    assert.deepEqual(await saved(), { kind: 'webhook', url }, url);
  }
  // A refused address leaves the saved one alone, and an empty one clears it.
  assert.equal((await setAddress('http://example.com/hook')).outcome, 'blocked');
  assert.deepEqual(await saved(), { kind: 'webhook', url: 'http://[::1]:8080/hook' });
  assert.equal((await setAddress('')).outcome, 'applied');
  assert.deepEqual(await saved(), { kind: 'webhook', url: null });
  // The address can be a bearer secret, so no receipt keeps it once it is cleared.
  const receipts = controller.store.db.prepare('SELECT * FROM receipts').all();
  assert.equal(JSON.stringify(receipts).includes('8080'), false);

  const ended = until(turnEnds);
  await run('SendChatMessage', { text: 'Go.', selection }, task.revision);
  await ended;
  // The turn's notice leaves after the steps that follow its end. None of them posts.
  for (let n = 0; n < 5; n++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
});

test('a redirect is refused and a key in a title is redacted', { timeout: 30000 }, async (t) => {
  const hits: string[] = [];
  const bodies: string[] = [];
  const waiting: { count: number; resolve: () => void }[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? '');
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      // The first request is redirected. Every later one is answered.
      if (hits.length === 1) response.writeHead(302, { location: '/elsewhere' });
      else bodies.push(Buffer.concat(chunks).toString('utf8'));
      response.end();
      for (const entry of waiting) if (bodies.length >= entry.count) entry.resolve();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const bodyCount = (count: number) =>
    new Promise<void>((resolve) => {
      if (bodies.length >= count) resolve();
      else waiting.push({ count, resolve });
    });

  const logs: string[] = [];
  const notifier = new WebhookNotifier({
    address: () => `http://127.0.0.1:${port}/hook`,
    fetch,
    now: () => new Date('2026-11-18T14:05:00.000Z'),
    log: (entry) => logs.push(entry),
  });
  t.after(() => notifier.close());

  notifier.notify({
    kind: 'finished',
    title: 'Fix rounding',
    line: 'Fix rounding: reply finished',
  });
  await bodyCount(1);
  // The first try met the redirect and failed on it. The second reached the same address.
  assert.deepEqual(logs, ['Webhook post failed on try 1: TypeError.']);
  assert.deepEqual(hits, ['/hook', '/hook']);

  const key = 'sk-abcdef123456789012345678';
  notifier.notify({ kind: 'failed', title: `Fix ${key}`, line: `Fix ${key}: reply failed` });
  await bodyCount(2);
  assert.equal(bodies[1]?.includes(key), false);
  assert.equal(JSON.parse(bodies[1] ?? '{}').event, 'failed');
});
