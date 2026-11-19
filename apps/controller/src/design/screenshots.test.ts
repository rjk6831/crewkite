import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  ChatAttachment,
  ChatChecksAsk,
  ChatThread,
  ChatThreadRead,
  DesignPreview,
  DesignSystem,
  Event,
} from '@crewkite/contracts';
import { createTestClock } from '@crewkite/testkit';
import { type ChatScriptStep, createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import { ArtifactFiles } from '../artifacts/index.ts';
import { filesFolder } from '../chat/files.ts';
import { setup } from '../store/controller-fixture.ts';
import { Store } from '../store/index.ts';
import { designBrief } from './brief.ts';
import { captureFailure, ownedPreview } from './screenshots.ts';

const selection = { family: 'openai', model: 'fixture-model', effort: 'default' } as const;
const system: DesignSystem = {
  schema: 1,
  tokens: {
    color: { accent: { $type: 'color', $value: '#2f6feb' } },
    type: {},
    spacing: {},
    radius: {},
    shadow: {},
    motion: {},
  },
  components: [],
  rules: [],
};
const declaration: DesignPreview = {
  command: 'pnpm dev',
  url: 'http://127.0.0.1:5173',
  views: [
    { name: 'home', path: '/' },
    { name: 'settings', path: '/settings' },
  ],
};
// The first bytes of a PNG are all the controller reads to type the file.
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
// The scripted request type predates files. The controller sends them on the real request.
const filesOf = (request?: object) =>
  (request as { files?: { attachment: ChatAttachment }[] } | undefined)?.files ?? [];
const reply = (text: string): ChatScriptStep[] => [{ kind: 'text', itemId: 'r', chunks: [text] }];

/**
 * A project with a saved design system and a builder and reviewer crew, one preview host spy.
 * The thread runs in Glide with Allow all. The person answers each question from `answers`, and
 * with Allow for this thread once those run out.
 */
async function project(
  t: TestContext,
  turns: ChatScriptStep[][],
  preview: {
    declare?: boolean;
    startFails?: string;
    /** A file the preview writes into the copy as it starts. */
    startWrites?: string;
    /** The person's answer to each question, in order. */
    answers?: ('allow' | 'allow-thread' | 'deny')[];
    /** A check command the gate after each writing turn runs. */
    check?: string;
    /**
     * What the person does while the views are shot: Stop while the first one loads, or send a
     * message once the last one is shot.
     */
    during?: 'stop' | 'message';
    /** Glide unless a test needs the questions Balanced asks. */
    flightMode?: 'glide' | 'balanced';
  },
) {
  const adapter = createScriptedChatAdapter({ family: 'openai', turns });
  const calls = { starts: 0, stops: 0, captured: [] as string[], aborted: false };
  // What the webhook posts, by event kind.
  const posts: string[] = [];
  let signal: AbortSignal | undefined;
  let act = async () => {};
  const {
    controller,
    command,
    draft,
    directory: root,
  } = await setup(t, {
    webhookFetch: (async (_url: string, init: RequestInit) => {
      posts.push((JSON.parse(String(init.body)) as { event: string }).event);
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch,
    webhookLog: () => {},
    chatAdapters: new Map([['openai', adapter]]),
    identity: { name: 'Fixture owner', email: 'owner@example.invalid' },
    previews: {
      start: async ({ directory, signal: pass }) => {
        signal = pass;
        calls.starts += 1;
        if (preview.startFails) throw Error(preview.startFails);
        if (preview.startWrites) writeFileSync(join(directory, preview.startWrites), 'served\n');
        return {
          stop: async () => {
            calls.stops += 1;
          },
        };
      },
      capture: async (url) => {
        calls.captured.push(url);
        if (preview.during === 'stop') {
          await act();
          // A browser waits on a page that never loads. Only the pass's own stop ends it.
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          calls.aborted = true;
          throw Error('The page did not load.');
        }
        if (preview.during === 'message' && url.endsWith('/settings')) await act();
        return png;
      },
    },
  });
  const { projectId } = draft.payload as { projectId: string };
  const task = (await controller.execute(draft, 'local-owner')).entity as { id: string };
  const run = (name: string, payload: object) =>
    controller.execute(command(name, payload, 0), 'local-owner');
  const saved = await run('SaveDesignSystem', {
    projectId,
    path: 'design-system.json',
    body: system,
    expectedVersion: 0,
    confirm: 'explicit',
  });
  assert.equal(saved.outcome, 'applied');
  assert.equal(
    (await run('SetWebhook', { url: 'https://hooks.example.com/x' })).outcome,
    'applied',
  );
  if (preview.declare !== false)
    assert.equal(
      (await run('SetDesignPreview', { projectId, preview: declaration })).outcome,
      'applied',
    );
  await run('ConfigureChatThread', {
    taskId: task.id,
    crew: {
      name: 'Pair',
      members: [
        { role: 'builder', selection },
        { role: 'reviewer', selection },
      ],
    },
    flightMode: preview.flightMode ?? 'glide',
    permissionPolicy: 'allow-all',
  });
  if (preview.check)
    assert.equal(
      (await run('ConfigureChatThread', { taskId: task.id, checks: { add: preview.check } }))
        .outcome,
      'applied',
    );
  act = async () => {
    act = async () => {};
    if (preview.during === 'stop')
      await run('StopChatTurn', { taskId: task.id, turnId: adapter.requests[0]?.turnId });
    else await run('SendChatMessage', { taskId: task.id, text: 'One more thing.', selection });
  };
  // Each question, with how many times the preview had started when it was asked.
  const asks: { ask: ChatChecksAsk; starts: number }[] = [];
  const lines: string[] = [];
  // The images in the thread's files when the crew ended, before anything queued starts.
  let placed: string[] = [];
  const finished = new Promise<void>((resolve) => {
    const stop = controller.store.subscribe((event: Event) => {
      const ask = event.type === 'chat.thread' ? (event.payload as ChatThread).checks?.ask : null;
      if (ask && !asks.some((seen) => seen.ask.requestId === ask.requestId)) {
        const choice = preview.answers?.[asks.length] ?? 'allow-thread';
        asks.push({ ask, starts: calls.starts });
        setImmediate(() =>
          run('ResolveChatPermission', {
            taskId: task.id,
            turnId: adapter.requests[0]?.turnId,
            requestId: ask.requestId,
            choice,
          }),
        );
      }
      const text = (event.payload as { text?: string }).text ?? '';
      if (event.type !== 'conversation.entry') return;
      lines.push(text);
      if (!/^Crew (finished|stopped)/.test(text)) return;
      const files = filesFolder(join(root, 'home'), task.id);
      placed = existsSync(files)
        ? readdirSync(files, { recursive: true })
            .map(String)
            .filter((name) => name.endsWith('.png'))
        : [];
      stop();
      resolve();
    });
  });
  await run('SendChatMessage', { taskId: task.id, text: 'Style the card.', selection });
  await finished;
  const thread = async () =>
    (
      (await controller.execute(command('ReadChatThread', { taskId: task.id }), 'local-owner'))
        .data as ChatThreadRead
    ).thread;
  return { adapter, calls, thread, asks, lines, placed, posts, run, taskId: task.id };
}

test('the reviewer gets one image per named view and the design brief, and its finding reaches the fixer once', {
  timeout: 30000,
}, async (t) => {
  const { adapter, calls, asks } = await project(
    t,
    [
      reply('Built the card.'),
      reply('The card uses a raw blue.\nFindings: 1'),
      reply('Switched to the accent token.'),
      reply('Clean.\nFindings: 0'),
    ],
    {},
  );
  // Glide with Allow all still asks before the first start. That allow covers the second pass.
  assert.deepEqual(
    asks.map(({ starts }) => starts),
    [0],
  );
  const reviews = adapter.requests.filter((request) => request.role === 'reviewer');
  assert.equal(reviews.length, 2);
  assert.deepEqual(
    filesOf(reviews[0])?.map((file) => [file.attachment.name, file.attachment.mimeType]),
    [
      ['home.png', 'image/png'],
      ['settings.png', 'image/png'],
    ],
  );
  assert(reviews[0]?.prompt.includes(designBrief(system)));
  // The fixer takes the reviewer's finding through the chain's own path, once.
  const fixers = adapter.requests.filter((request) => request.role === 'fixer');
  assert.equal(fixers.length, 1);
  assert.equal(fixers[0]?.prompt.match(/The card uses a raw blue\./g)?.length, 1);
  // Each review pass starts the preview, shoots both views and stops it.
  assert.deepEqual(calls.captured, [
    'http://127.0.0.1:5173/',
    'http://127.0.0.1:5173/settings',
    'http://127.0.0.1:5173/',
    'http://127.0.0.1:5173/settings',
  ]);
  assert.deepEqual([calls.starts, calls.stops], [2, 2]);
});

test('a preview that fails records one failed step and starts no repair', {
  timeout: 30000,
}, async (t) => {
  const { adapter, calls, thread, posts } = await project(
    t,
    [reply('Built the card.'), reply('Reads fine.\nFindings: 0')],
    { startFails: 'The preview command ended with exit code 1 before it answered.' },
  );
  // The preview's question waited on the person. A failed preview is no gate: the checks
  // passed, so the finished crew posts finished.
  for (let n = 0; n < 5; n++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posts, ['approval-needed', 'finished']);
  assert.equal(calls.captured.length, 0);
  assert.equal(adapter.requests.filter((request) => request.role === 'fixer').length, 0);
  // The review still runs, with no images.
  assert.deepEqual(filesOf(adapter.requests.find((request) => request.role === 'reviewer')), []);
  // The gate after the builder read the copy against the saved system before the review.
  assert.deepEqual(
    (await thread()).checks?.runs.map(({ checkId, status, reason }) => ({
      checkId,
      status,
      reason,
    })),
    [
      { checkId: 'design-system', status: 'passed', reason: null },
      {
        checkId: 'design-screenshots',
        status: 'failed',
        reason: 'The preview command ended with exit code 1 before it answered.',
      },
    ],
  );
});

test('a project with no declared preview runs no preview', { timeout: 30000 }, async (t) => {
  const { adapter, calls, thread } = await project(
    t,
    [reply('Built the card.'), reply('Reads fine.\nFindings: 0')],
    { declare: false },
  );
  assert.deepEqual([calls.starts, calls.captured.length], [0, 0]);
  assert.deepEqual(filesOf(adapter.requests.find((request) => request.role === 'reviewer')), []);
  // Only the gate after the builder ran, and it read the copy against the saved system.
  assert.deepEqual(
    (await thread()).checks?.runs.map(({ checkId, trigger }) => [checkId, trigger]),
    [['design-system', 'after-write']],
  );
});

test('one allow for the thread covers the checks and the preview, and a changed script asks once', {
  timeout: 30000,
}, async (t) => {
  const script = JSON.stringify({ scripts: { dev: 'vite --host 0.0.0.0' } });
  const { adapter, calls, asks, lines, thread } = await project(
    t,
    [
      reply('Built the card.'),
      reply('The card uses a raw blue.\nFindings: 1'),
      reply('Switched to the accent token.'),
      reply('The border is a raw gray.\nFindings: 1'),
      [
        {
          kind: 'tool',
          callId: 'edit-1',
          toolKind: 'edit',
          title: 'Edit package.json',
          write: { path: 'package.json', content: script },
        },
        ...reply('Used the border token.'),
      ],
      reply('Clean.\nFindings: 0'),
    ],
    { answers: ['deny', 'allow-thread', 'allow-thread'], check: 'node --version' },
  );
  const check = { label: 'node --version', resolved: 'node --version' };
  const shots = (resolved: string) => ({ label: 'Design screenshots', resolved });
  // Glide with Allow all runs the check without a question, and the preview still asks. Each
  // question shows the check and the preview as one set and comes before the preview starts. A
  // denied preview leaves the check alone. After one allow for the thread, only the fixer's change
  // to the preview's script asks again, in Glide too, and its allow covers the last pass.
  assert.deepEqual(
    asks.map(({ ask, starts }) => ({
      trigger: ask.trigger,
      commands: ask.commands,
      changed: ask.changed,
      starts,
    })),
    [
      { trigger: 'after-write', commands: [check, shots('pnpm dev')], changed: [], starts: 0 },
      { trigger: 'after-write', commands: [check, shots('pnpm dev')], changed: [], starts: 0 },
      {
        trigger: 'after-write',
        commands: [check, shots('pnpm dev runs dev: vite --host 0.0.0.0')],
        changed: ['Design screenshots'],
        starts: 1,
      },
    ],
  );
  assert.equal(calls.starts, 2);
  assert.deepEqual(
    adapter.requests
      .filter((request) => request.role === 'reviewer')
      .map((review) => filesOf(review).length),
    [0, 2, 2],
  );
  assert(
    lines.includes('The design screenshots did not run. The preview command was not allowed.'),
  );
  // The gate after the builder and after each fix runs the check, then the design check.
  assert.deepEqual(
    (await thread()).checks?.runs.map(({ checkId, status }) => [checkId, status]),
    [
      ['custom:1', 'passed'],
      ['design-system', 'passed'],
      ['custom:1', 'passed'],
      ['design-system', 'passed'],
      ['custom:1', 'passed'],
      ['design-system', 'passed'],
    ],
  );
});

// Claim: one allow for the thread covers the checks wherever they run. The gate asks for the
// checks and the preview together, and Accept, which runs only the checks, takes that allow and
// asks nothing, so neither overwrites the other's approval.
test('an allow for the thread at the gate holds at Accept when a preview is declared', {
  timeout: 30000,
}, async (t) => {
  const { asks, run, taskId, thread } = await project(
    t,
    [
      [
        {
          kind: 'tool',
          callId: 'write-1',
          toolKind: 'edit',
          title: 'Write notes.txt',
          write: { path: 'notes.txt', content: 'The card has a title.\n' },
        },
        ...reply('Wrote the notes.'),
      ],
      reply('Clean.\nFindings: 0'),
    ],
    { check: 'node --version', flightMode: 'balanced' },
  );
  assert.deepEqual(
    asks.map(({ ask }) => ask.trigger),
    ['after-write'],
  );
  const accepted = await run('AcceptChatChanges', { taskId, branch: 'feat/card-notes' });
  assert.notEqual(accepted.outcome, 'blocked', JSON.stringify(accepted));
  assert.equal((await thread()).checks?.ask ?? null, null, 'Accept asks nothing again.');
});

// Claim: one Allow for one write covers the checks and the preview of that write, as the one
// question showed them together. The preview pass does not ask the same question again.
test('one Allow at the gate covers the preview pass of the same write', {
  timeout: 30000,
}, async (t) => {
  const { asks, calls } = await project(
    t,
    [reply('Built the card.'), reply('Clean.\nFindings: 0')],
    { check: 'node --version', flightMode: 'balanced', answers: ['allow', 'deny'] },
  );
  assert.deepEqual(
    asks.map(({ ask }) => ask.trigger),
    ['after-write'],
  );
  assert.equal(calls.starts, 1, 'The preview ran on the one allow.');
});

test('a preview that changes a file in the copy fails its pass, and the reviewer gets no images', {
  timeout: 30000,
}, async (t) => {
  const { adapter, thread } = await project(
    t,
    [reply('Built the card.'), reply('Reads fine.\nFindings: 0')],
    { startWrites: 'preview-cache.json' },
  );
  assert.deepEqual(filesOf(adapter.requests.find((request) => request.role === 'reviewer')), []);
  assert.deepEqual(
    (await thread()).checks?.runs.map(({ checkId, status, reason, changedPaths }) => ({
      checkId,
      status,
      reason,
      changedPaths,
    })),
    [
      { checkId: 'design-system', status: 'passed', reason: null, changedPaths: undefined },
      {
        checkId: 'design-screenshots',
        status: 'failed',
        reason:
          'The preview changed files in the copy. Review the changes before running it again.',
        changedPaths: ['preview-cache.json'],
      },
    ],
  );
});

test('Stop ends a running preview, and a pass the thread drops leaves no image in its files', {
  timeout: 30000,
}, async (t) => {
  const stopped = await project(t, [reply('Built the card.')], { during: 'stop' });
  assert(stopped.lines.includes('Crew stopped: you stopped the preview.'));
  assert.deepEqual([stopped.calls.aborted, stopped.calls.stops], [true, 1]);
  // A message sent while the views are shot drops the pass. Its images never reach the files.
  const dropped = await project(t, [reply('Built the card.')], { during: 'message' });
  assert(dropped.lines.includes('Crew stopped: you sent a new message.'));
  assert.equal(dropped.calls.captured.length, 2);
  assert.deepEqual(dropped.placed, []);
});

test('a preview refuses to start while something already answers at its address', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-preview-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'state.sqlite'));
  t.after(() => store.close());
  store.applyMigrations(fileURLToPath(new URL('../../migrations/', import.meta.url)));
  // Another project's server already listens on the port the preview declares. The readiness poll
  // would take it for the preview and shoot its pages.
  const server = createServer((_request, response) => response.end('another project'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const start = ownedPreview({
    store,
    artifacts: new ArtifactFiles(join(directory, 'artifacts')),
    home: directory,
    now: createTestClock().now,
    base: () => 'a'.repeat(40),
    taskRevision: () => 0,
    projectPath: () => directory,
    holdOwnership: () => {},
  });
  // No such program exists, so a guard that ran after the launch would fail with another reason.
  await assert.rejects(
    start({
      taskId: 'task',
      projectId: 'project',
      directory,
      declaration: {
        command: 'crewkite-absent-preview dev',
        url,
        views: [{ name: 'home', path: '/' }],
      },
      signal: new AbortController().signal,
    }),
    { message: `Something already answers at ${url}. Stop it or declare a free port.` },
  );
});

// Claim: only Playwright's own timeout reads as a page that did not load. A failure whose message
// holds the word in its URL keeps its own line.
test('a failed capture is called a load timeout only when Playwright timed out', () => {
  const url = 'http://127.0.0.1:5173/settings/session-timeout';
  const timedOut = Object.assign(new Error(`page.goto: Timeout 30000ms exceeded.`), {
    name: 'TimeoutError',
  });
  const moved = Error(`The page at ${url} moved to http://example.com, so it was not captured.`);
  assert.match(captureFailure(timedOut, url), /^The page at .* did not load in \d+ seconds\.$/);
  assert.equal(captureFailure(moved, url), moved.message);
});
