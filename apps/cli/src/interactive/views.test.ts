import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import type { ChatPlanState, Event } from '@crewkite/contracts';
import { createElement as h, type ReactElement } from 'react';
import {
  initialThreadState,
  reduceThread,
  threadItems,
} from '../../../desktop/src/renderer/thread/thread-state.ts';
import { connectChat } from '../chat/connect.ts';
import { startScriptedController } from '../scripted-controller.ts';
import { defaultSettings } from '../settings.ts';

// Ink picks its colour level when it loads. The views decide colour through the palette, so the
// test asks for full colour and checks that NO_COLOR leaves none.
process.env.FORCE_COLOR = '3';
const { renderToString } = await import('ink');
const views = await import('./views.ts');
const { gaugeHex, palette } = await import('./theme.ts');

const esc = String.fromCharCode(27);
const plain = (text: string) => stripVTControlCharacters(text).replace(/[ \t]+$/gm, '');
const rgb = (hex: string) =>
  `38;2;${[1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(';')}m`;

const plan: ChatPlanState = {
  planId: 'plan-1',
  orchestratorTurnId: 'trn_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  goal: 'Clamp the discount and cover it with tests',
  phase: 'proposed',
  slices: [
    {
      id: 1,
      title: 'Clamp the discount',
      difficulty: 'medium',
      depends: [],
      readOnly: false,
      status: 'queued',
      assignment: { family: 'anthropic', model: 'fixture-model', reason: 'Builder model.' },
      candidates: [
        { family: 'anthropic', model: 'fixture-model', reason: 'Builder model.' },
        { family: 'local', model: 'fixture-local', reason: 'Fits the Local room.' },
      ],
      turnId: null,
    },
    {
      id: 2,
      title: 'Add the tests',
      difficulty: 'easy',
      depends: [1],
      readOnly: false,
      status: 'not-run',
      assignment: null,
      candidates: [],
      turnId: null,
    },
  ],
};

test('each interactive view draws a scripted thread in colour and without it under NO_COLOR', {
  timeout: 60_000,
}, async (t) => {
  const { home, repository } = await startScriptedController(t, [
    [
      { kind: 'tool', callId: 'read-1', toolKind: 'read', title: 'Read net.mjs' },
      { kind: 'tool', callId: 'read-2', toolKind: 'read', title: 'Read net.test.mjs' },
      { kind: 'text', itemId: 'plan', chunks: ['## Plan\n\n', '- clamp **the discount**\n'] },
      { kind: 'permission', requestId: 'edit-1', question: 'Edit net.mjs?' },
      {
        kind: 'tool',
        callId: 'edit-1',
        toolKind: 'edit',
        title: 'Edit net.mjs',
        write: { path: 'net.mjs', content: 'export const net = 1;\n' },
      },
      { kind: 'text', itemId: 'done', chunks: ['Done.'] },
    ],
  ]);
  const client = await connectChat(home);
  t.after(() => client.transport.close());
  const project = await client.send('RegisterProject', { path: repository });
  const task = await client.createThread((project.entity as { id: string }).id, 'Clamp it');
  const catalog = await client.readCatalog();
  const before = await client.readThread(task.id);

  // Follow the stream into the renderer's thread state until the edit asks.
  let state = reduceThread(initialThreadState(task.id), { type: 'loaded', read: before });
  const asked = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  await client.transport.subscribe(before.cursor, (event: Event) => {
    state = reduceThread(state, { type: 'events', events: [event] });
    if (event.type === 'agent.event' && event.payload.type === 'permission.requested')
      asked.resolve();
    if (event.type === 'chat.thread' && state.turnMeta && event.payload.activeTurnId === null)
      if (Object.values(state.turnMeta).some((turn) => turn.state === 'done')) settled.resolve();
  });
  await client.sendMessage({
    taskId: task.id,
    text: 'Clamp it',
    selection: {
      family: 'anthropic',
      model: catalog.families[1].defaultModel ?? '',
      effort: 'default',
    },
  });
  await asked.promise;
  const waiting = threadItems(state);
  await client.resolvePermission(task.id, Object.keys(state.turns)[0], 'edit-1', 'allow-once');
  await settled.promise;
  const done = threadItems(state);
  const changes = await client.readChanges(task.id);
  assert.equal((await client.accept(task.id, 'cli/clamp')).outcome, 'applied');
  const accepted = (await client.readThread(task.id)).thread;
  const crew = {
    name: 'Pair',
    members: [
      {
        role: 'builder' as const,
        selection: {
          family: 'anthropic' as const,
          model: 'fixture-model',
          effort: 'default' as const,
        },
      },
      {
        role: 'reviewer' as const,
        selection: { family: 'local' as const, model: 'fixture-local', effort: 'default' as const },
      },
    ],
  };
  const now = Date.parse('2026-10-28T12:00:00.000Z');
  const stale = {
    families: catalog.families.map((entry) =>
      entry.family === 'anthropic'
        ? {
            ...entry,
            readAt: '2026-10-28T10:00:00.000Z',
            remaining: entry.remaining.map((window) => ({ ...window, percent: 30 })),
          }
        : entry,
    ),
  };
  const rows = (items: typeof done, colors: ReturnType<typeof palette>) =>
    h(views.ThreadRows, {
      items,
      thread: accepted,
      colors,
      width: 96,
      frame: 0,
      animation: 'off',
      showThinking: false,
      tryWith: () => [],
    });

  const cases: {
    name: string;
    view: (colors: ReturnType<typeof palette>) => ReactElement;
    shows: (string | RegExp)[];
    columns?: number;
  }[] = [
    {
      name: 'large wordmark',
      view: (colors) => h(views.Wordmark, { columns: 100, colors }),
      shows: ['◢█ █◣', '████'],
    },
    {
      name: 'small wordmark',
      view: (colors) => h(views.Wordmark, { columns: 50, colors }),
      shows: ['◢◣ CrewKite'],
      columns: 50,
    },
    {
      name: 'thread with a fold, Markdown and an open permission',
      view: (colors) => rows(waiting, colors),
      shows: [
        '› Clamp it',
        'Read 2 files',
        'Plan',
        '• clamp the discount',
        '[1] Allow once',
        '[2] Deny',
        'Thread policy: Ask each time',
      ],
    },
    {
      name: 'thread after the answer',
      view: (colors) => rows(done, colors),
      shows: ['Answered: Allow once', '✓ Edit net.mjs', 'Done.'],
    },
    {
      name: 'changes with the diff and the accepted branch',
      view: (colors) =>
        h(views.ChangesView, {
          changes,
          selected: 0,
          thread: accepted,
          status: null,
          message: null,
          colors,
          width: 96,
        }),
      shows: [
        'Changes (1 file)',
        'net.mjs',
        '+export const net = 1;',
        'Accepted on cli/clamp',
        'P Push',
      ],
    },
    {
      name: 'crew',
      view: (colors) =>
        h(views.CrewView, { thread: { ...accepted, crew, flightMode: 'balanced' }, colors }),
      shows: [
        'Crew: Pair',
        /builder\s+A fixture-model/,
        /reviewer\s+L fixture-local/,
        'Flight mode: Balanced',
      ],
    },
    {
      name: 'plan card in Balanced',
      view: (colors) => h(views.PlanCardView, { plan, flight: 'balanced', colors }),
      shows: [
        'Plan ready. Check where each slice goes',
        '1. Queued',
        '2. Not run',
        'Local fixture-local (Fits',
        'R Run plan',
        'C Cancel',
      ],
    },
    {
      name: 'plan card after a stop',
      view: (colors) =>
        h(views.PlanCardView, { plan: { ...plan, phase: 'stopped' }, flight: 'manual', colors }),
      shows: ['Plan stopped: 0 of 2 slices done.', 'Runs after slice 1', '1-8 Run one slice'],
    },
    {
      name: 'settings with provider cards and a dotted stale gauge',
      view: (colors) =>
        h(views.SettingsView, {
          catalog: stale,
          settings: defaultSettings(),
          field: 0,
          status: null,
          nowMs: now,
          colors,
        }),
      shows: ['Theme', 'A Anthropic  Connected', '┅┅', '30% left', 'Not configured'],
    },
    {
      name: 'thread list',
      view: (colors) =>
        h(views.ThreadListView, {
          threads: [
            {
              id: task.id,
              projectId: task.projectId,
              title: 'Clamp it',
              state: 'draft',
              waitingReason: null,
              revision: 0,
              runId: null,
              next: null,
              chatActivity: 'waiting',
            },
          ],
          selected: 0,
          colors,
          complete: true,
        }),
      shows: ['Threads', '? Clamp it'],
    },
    {
      name: 'help',
      view: (colors) => h(views.HelpView, { settings: defaultSettings(), colors }),
      shows: ['Ctrl+T', '/accept branch', '/prompt name'],
    },
  ];
  for (const row of cases) {
    const colored = renderToString(row.view(palette('dark', true)), {
      columns: row.columns ?? 100,
    });
    const bare = renderToString(row.view(palette('dark', false)), { columns: row.columns ?? 100 });
    for (const expected of row.shows) {
      if (typeof expected === 'string')
        assert.ok(plain(colored).includes(expected), `${row.name}: ${expected}\n${plain(colored)}`);
      else assert.match(plain(colored), expected, row.name);
    }
    assert.equal(plain(bare), plain(colored), `${row.name}: NO_COLOR keeps the shape`);
    assert.ok(
      !bare.includes(`${esc}[38;`) && !bare.includes(`${esc}[48;`),
      `${row.name}: NO_COLOR draws no colour`,
    );
  }

  // The kite panels and the gauge take the desktop's colours: yellow at 40 percent, red at empty.
  const wordmark = renderToString(
    h(views.Wordmark, { columns: 100, colors: palette('dark', true) }),
    { columns: 100 },
  );
  for (const panel of ['#40b0a8', '#e87860', '#4850a8', '#e0b860'])
    assert.ok(wordmark.includes(rgb(panel)));
  assert.equal(gaugeHex(40), '#caca21');
  assert.equal(gaugeHex(0), '#ca2121');
  const fresh = renderToString(
    h(views.UsageLine, {
      catalog: { families: [{ ...stale.families[1], readAt: '2026-10-28T11:30:00.000Z' }] },
      nowMs: now,
      colors: palette('dark', true),
    }),
    { columns: 100 },
  );
  assert.ok(fresh.includes(rgb(gaugeHex(30))) && plain(fresh).includes('██░░░░░░'));

  // The spinner turns with full animation and stays still when reduced or off.
  const spin = (frame: number, animation: 'full' | 'reduced' | 'off') =>
    renderToString(
      h(views.Spinner, { frame, animation, colors: palette('dark', true), label: 'Working' }),
    );
  assert.notEqual(spin(0, 'full'), spin(1, 'full'));
  assert.equal(spin(0, 'reduced'), spin(1, 'reduced'));
  assert.equal(spin(2, 'off'), spin(3, 'off'));
});
