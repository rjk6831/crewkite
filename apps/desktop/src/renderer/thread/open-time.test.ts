import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import {
  type ChatThread,
  type ChatThreadRead,
  ChatThreadReadSchema,
  type Task,
} from '@crewkite/contracts';
import { createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import { setup } from '../../../../controller/src/store/controller-fixture.ts';
import { initialThreadState, reduceThread, THREAD_PAGE_SIZE, threadItems } from './thread-state.ts';
import { layoutRows, rowWindow } from './virtual-window.ts';

// A synthetic thread of 2,000 turns, written the way the controller writes them, opened the way
// the view opens a thread: one controller page read, then the renderer state build and the first
// window. The numbers go to the test output and into docs/testing.md. The budgets are the
// product's, 300 ms warm and 1.5 s cold, on the reference Mac. This container is the check that
// the work is nowhere near them; the Mac measurement is a separate step.

const TURNS = 2000;
const WARM_BUDGET_MS = 300;
const COLD_BUDGET_MS = 1500;
const ulid = (n: number) => `0${String(n).padStart(25, '0')}`;
const selection = { family: 'openai', model: 'model-a', effort: 'default' } as const;

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];
const ms = (from: number) => performance.now() - from;

test('a 2,000 turn thread opens inside the warm and cold budgets', {
  timeout: 120_000,
}, async (t) => {
  const adapter = createScriptedChatAdapter({
    family: 'openai',
    turns: [[{ kind: 'text', itemId: 'r', chunks: ['A reply ', 'of some length.'] }]],
  });
  const { controller, command, draft } = await setup(t, {
    chatAdapters: new Map([['openai', adapter]]),
    identity: { name: 'Fixture owner', email: 'owner@example.invalid' },
  });
  const task = (await controller.execute(draft, 'local-owner')).entity as Task;
  const idle = new Promise<void>((resolve) => {
    const stop = controller.store.subscribe((event) => {
      const thread = event.payload as ChatThread;
      if (event.type === 'chat.thread' && thread.activeTurnId === null && !thread.queued.length) {
        stop();
        resolve();
      }
    });
  });
  const sent = await controller.execute(
    command(
      'SendChatMessage',
      { taskId: task.id, text: 'First question', selection },
      task.revision,
    ),
    'local-owner',
  );
  assert.equal(sent.outcome, 'applied');
  await idle;

  // One real exchange is the template. The other 1,999 copy its stored shape with new ids.
  const { db } = controller.store;
  const entries = db
    .prepare('SELECT body FROM conversation_entries WHERE task_id=? ORDER BY sequence')
    .all(task.id)
    .map((row) => JSON.parse(row.body as string) as Record<string, unknown>);
  const ask = entries.find((entry) => entry.kind === 'user-message');
  const reply = entries.find((entry) => entry.kind === 'chat-assistant');
  const turnRow = JSON.parse(
    db.prepare('SELECT body FROM chat_turns WHERE task_id=?').get(task.id)?.body as string,
  ) as Record<string, unknown>;
  assert.ok(ask && reply, 'the scripted exchange wrote a question and a reply');
  const insertEntry = db.prepare(
    'INSERT INTO conversation_entries(id,task_id,body) VALUES (?,?,?)',
  );
  const setEntry = db.prepare('UPDATE conversation_entries SET body=? WHERE id=?');
  const insertTurn = db.prepare(
    'INSERT INTO chat_turns(id,task_id,sequence,body) VALUES (?,?,?,?)',
  );
  const start = Date.parse(String(turnRow.startedAt));
  controller.store.transaction(() => {
    for (let n = 1; n < TURNS; n++) {
      const user = `msg_${ulid(10_000 + n * 2)}`;
      const answer = `msg_${ulid(10_001 + n * 2)}`;
      const turn = `trn_${ulid(10_000 + n)}`;
      const at = new Date(start + n * 60_000).toISOString();
      const author = reply.author as Record<string, unknown>;
      insertTurn.run(
        turn,
        task.id,
        n + 1,
        JSON.stringify({
          ...turnRow,
          id: turn,
          sequence: n + 1,
          userMessageId: user,
          assistantMessageId: answer,
          startedAt: at,
          endedAt: at,
        }),
      );
      const written: [string, object][] = [
        [
          user,
          { ...ask, id: user, at, text: `Question ${n}: how does the invoice rounding work?` },
        ],
        [
          answer,
          {
            ...reply,
            id: answer,
            at,
            author: { ...author, turnId: turn },
            text: `Answer ${n}: ${'The totals are rounded once, after tax. '.repeat(6)}`,
          },
        ],
      ];
      for (const [id, body] of written) {
        // A stored entry names its own position in the conversation, which is its row number.
        const { lastInsertRowid } = insertEntry.run(id, task.id, '{}');
        setEntry.run(JSON.stringify({ ...body, cursor: String(lastInsertRowid) }), id);
      }
    }
  });

  const readPage = async (before?: string): Promise<ChatThreadRead> => {
    const result = await controller.execute(
      command('ReadChatThread', {
        taskId: task.id,
        limit: THREAD_PAGE_SIZE,
        ...(before ? { beforeCursor: before } : {}),
      }),
      'local-owner',
    );
    const { kind: _kind, ...rest } = result.data as Record<string, unknown>;
    // The page crosses the process boundary as a structured clone and is parsed again on arrival.
    return ChatThreadReadSchema.parse(JSON.parse(JSON.stringify(rest)));
  };
  const open = async () => {
    const begin = performance.now();
    const read = await readPage();
    const controllerMs = ms(begin);
    const build = performance.now();
    const state = reduceThread(initialThreadState(task.id), { type: 'loaded', read });
    const items = threadItems(state);
    const layout = layoutRows(
      items.map((item) => item.key),
      new Map(),
    );
    const window = rowWindow(layout, Math.max(0, layout.total - 800), 800);
    return { controllerMs, stateMs: ms(build), totalMs: ms(begin), items, read, window };
  };

  const cold = await open();
  const warm = [];
  for (let run = 0; run < 7; run++) warm.push(await open());
  const warmTotal = median(warm.map((run) => run.totalMs));
  t.diagnostic(
    `open, cold: controller read ${cold.controllerMs.toFixed(1)} ms, state build ${cold.stateMs.toFixed(1)} ms, total ${cold.totalMs.toFixed(1)} ms`,
  );
  t.diagnostic(
    `open, warm median of ${warm.length}: controller read ${median(warm.map((run) => run.controllerMs)).toFixed(1)} ms, state build ${median(warm.map((run) => run.stateMs)).toFixed(1)} ms, total ${warmTotal.toFixed(1)} ms`,
  );
  t.diagnostic(
    `first page: ${cold.read.messages.length} messages, ${cold.read.turns.length} turn records, ${cold.items.length} rows, ${cold.window.end - cold.window.start} mounted`,
  );
  assert.ok(cold.totalMs < COLD_BUDGET_MS, `cold open ${cold.totalMs.toFixed(0)} ms`);
  assert.ok(warmTotal < WARM_BUDGET_MS, `warm open ${warmTotal.toFixed(0)} ms`);
  assert.equal(cold.read.messages.length, THREAD_PAGE_SIZE);
  assert.equal(cold.read.more, true, 'older messages exist behind the first page');

  // Paging the whole thread in is the worst case for the row list. Every row is in the state and
  // only a window of them is mounted.
  const begin = performance.now();
  let state = reduceThread(initialThreadState(task.id), { type: 'loaded', read: cold.read });
  let pages = 1;
  for (let more = cold.read.more === true; more; pages++) {
    const oldest = state.messages[0]?.cursor;
    assert.ok(oldest, 'a page has an oldest message to read before');
    const read = await readPage(oldest);
    state = reduceThread(state, { type: 'earlier', read });
    more = read.more === true && read.messages.length > 0;
    assert.ok(pages < 40, 'paging ends');
  }
  const items = threadItems(state);
  const layout = layoutRows(
    items.map((item) => item.key),
    new Map(),
  );
  const window = rowWindow(layout, layout.total - 800, 800);
  t.diagnostic(
    `all paged in: ${pages} pages, ${state.messages.length} messages, ${items.length} rows, ${window.end - window.start} mounted, ${ms(begin).toFixed(0)} ms`,
  );
  assert.equal(state.messages.length, TURNS * 2);
  assert.ok(items.length >= TURNS, 'every question is a row');
  assert.ok(window.end - window.start < 60, 'a long thread mounts a window of its rows');
  assert.equal(window.end, items.length, 'the window at the end reaches the last row');
});
