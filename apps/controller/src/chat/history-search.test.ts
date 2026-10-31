import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type ChatSearchResult,
  type ChatThread,
  type Event,
  MAX_CHAT_SEARCH_BYTES,
  SearchChatHistoryPayloadSchema,
  type Task,
} from '@crewkite/contracts';
import { createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import { setup } from '../store/controller-fixture.ts';
import { Store } from '../store/index.ts';
import { readSnippet, searchHistory, searchTerms } from './history-search.ts';

const migrations = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const ulid = (n: number) => `0${String(n).padStart(25, '0')}`;
const taskId = (n: number) => `tsk_${ulid(n)}`;
const turnId = (n: number) => `trn_${ulid(n)}`;
const messageId = (n: number) => `msg_${ulid(n)}`;

// A store the way the controller writes it: tasks through the entity upsert, messages and events
// through the same insert-then-set-body sequence the service and the log use.
function openStore(t: TestContext, migrate = true) {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-search-'));
  const store = new Store(join(directory, 'controller.db'));
  if (migrate) store.applyMigrations(migrations);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, directory };
}

let eventCounter = 0;
const world = (store: Store) => ({
  task(n: number, title: string) {
    store.transaction(() =>
      store.put('task', taskId(n), 0, {
        id: taskId(n),
        projectId: 'prj_x',
        title,
        outcome: 'outcome',
        criteria: [],
      }),
    );
  },
  message(
    task: number,
    n: number,
    text: string,
    kind: 'user-message' | 'chat-assistant' = 'user-message',
    turn?: number,
  ) {
    const body = {
      kind,
      id: messageId(n),
      text,
      author:
        kind === 'user-message'
          ? { kind: 'user' }
          : { kind: 'assistant', turnId: turnId(turn ?? 0) },
    };
    store.transaction(() => {
      store.db
        .prepare('INSERT INTO conversation_entries(id,task_id,body) VALUES (?,?,?)')
        .run(messageId(n), taskId(task), '{}');
      store.db
        .prepare('UPDATE conversation_entries SET body=? WHERE id=?')
        .run(JSON.stringify(body), messageId(n));
    });
  },
  turn(task: number, n: number, userMessage: number, sequence: number) {
    store.transaction(() =>
      store.db
        .prepare('INSERT INTO chat_turns(id,task_id,sequence,body) VALUES (?,?,?,?)')
        .run(
          turnId(n),
          taskId(task),
          sequence,
          JSON.stringify({ id: turnId(n), userMessageId: messageId(userMessage) }),
        ),
    );
  },
  agent(task: number, payload: Record<string, unknown>) {
    store.transaction(() =>
      store.append({
        protocol: 1,
        id: `evt_${ulid(++eventCounter)}`,
        at: '2026-10-31T00:00:00.000Z',
        taskId: taskId(task),
        revision: 0,
        type: 'agent.event',
        payload,
      } as unknown as Omit<Event, 'cursor'>),
    );
  },
});

const search = (store: Store, query: string, extra: object = {}): ChatSearchResult =>
  searchHistory(store.db, SearchChatHistoryPayloadSchema.parse({ query, ...extra }));
const found = (result: ChatSearchResult) =>
  result.groups.map((group) => [group.taskId, group.hits.map((hit) => hit.kind)] as const);

test('a title hit outranks the same word inside a message, and each thread appears once', (t) => {
  const { store } = openStore(t);
  const w = world(store);
  w.task(1, 'Weekly planning');
  w.message(1, 1, 'The rounding of totals is wrong in the checkout');
  w.task(2, 'Fix rounding');
  w.message(2, 2, 'please fix the rounding');
  const result = search(store, 'rounding');
  assert.deepEqual(found(result), [
    [taskId(2), ['title', 'message']],
    [taskId(1), ['message']],
  ]);
  assert.equal(result.groups[0].title, 'Fix rounding');
});

test('each source of text answers a search and names the turn and message to open', (t) => {
  const { store } = openStore(t);
  const w = world(store);
  w.task(1, 'Checkout work');
  w.message(1, 1, 'Please tidy the invoice module');
  w.turn(1, 1, 1, 0);
  w.message(1, 2, 'All tidy now, nothing else to report', 'chat-assistant', 1);
  w.agent(1, {
    type: 'tool.started',
    turnId: turnId(1),
    callId: 'c1',
    kind: 'command',
    title: 'Run npm run lint-everything',
  });
  w.agent(1, {
    type: 'tool.completed',
    turnId: turnId(1),
    callId: 'c1',
    status: 'ok',
    summary: 'Linted 41 modules, no warnings',
  });
  w.agent(1, {
    type: 'tool.started',
    turnId: turnId(1),
    callId: 'c2',
    kind: 'edit',
    title: 'Edit',
    input: { file_path: 'src/invoice/totals.ts' },
  });
  w.agent(1, {
    type: 'tool.started',
    turnId: turnId(1),
    callId: 'c3',
    kind: 'read',
    title: 'Read',
    input: { paths: ['docs/billing/tax-rules.md', 'docs/billing/vat.md'] },
  });
  w.agent(1, {
    type: 'tool.completed',
    turnId: turnId(1),
    callId: 'c2',
    status: 'ok',
    diff: { path: 'src/invoice/totals.ts', additions: 1, deletions: 0, patch: null },
  });
  // Output chunks and text deltas are not searchable.
  w.agent(1, {
    type: 'tool.output',
    turnId: turnId(1),
    callId: 'c1',
    chunk: 'secretive-output-chunk',
  });
  const userMessageCursor = String(
    store.db.prepare('SELECT sequence FROM conversation_entries WHERE id=?').get(messageId(1))
      ?.sequence,
  );
  const rows: [string, string, string | null, boolean][] = [
    // query, expected kind, expected turn, expected message is the user message that started it
    ['invoice module', 'message', turnId(1), true],
    ['nothing else', 'message', turnId(1), false],
    ['lint-everything', 'tool', turnId(1), true],
    ['41 modules', 'tool', turnId(1), true],
    ['invoice/totals', 'path', turnId(1), true],
    ['tax-rules.md', 'path', turnId(1), true],
    ['billing/vat', 'path', turnId(1), true],
  ];
  for (const [query, kind, turn, startedIt] of rows) {
    const [group] = search(store, query).groups;
    assert.ok(group, `${query} finds the thread`);
    const hit = group.hits.find((value) => value.kind === kind);
    assert.ok(hit, `${query} has a ${kind} hit`);
    assert.equal(hit.turnId, turn, `${query} names its turn`);
    if (startedIt) {
      assert.equal(hit.messageId, messageId(1), `${query} names the message that started the turn`);
      assert.equal(hit.messageCursor, userMessageCursor);
    }
  }
  assert.deepEqual(search(store, 'secretive-output-chunk').groups, []);
});

test('a match is cut from its text with offsets that cover exactly the matched characters', (t) => {
  const { store } = openStore(t);
  const w = world(store);
  w.task(1, 'Notes');
  w.message(
    1,
    1,
    `${'lead in words '.repeat(30)}the Rounding bug is here${' trailing words'.repeat(30)}`,
  );
  const [hit] = search(store, 'rounding BUG').groups[0].hits;
  assert.ok(hit.snippet.length <= 240);
  assert.ok(hit.marks.length >= 1);
  const marked = hit.marks.map((mark) => hit.snippet.slice(mark.start, mark.end).toLowerCase());
  assert.ok(
    marked.some((text) => text.includes('rounding')),
    marked.join('|'),
  );
  assert.ok(
    marked.some((text) => text.includes('bug')),
    marked.join('|'),
  );
});

test('search folds case and accents and matches Thai, Japanese and path fragments', (t) => {
  const { store } = openStore(t);
  const w = world(store);
  w.task(1, 'Café menu');
  w.message(1, 1, 'สวัสดีครับ วันนี้อากาศดีมาก');
  w.message(1, 2, '東京タワーの近くにあるカフェ');
  w.message(1, 3, 'Open apps/desktop/src/renderer/rail.tsx now');
  const rows: [string, string][] = [
    ['CAFE', 'title'],
    ['cafÉ', 'title'],
    ['อากาศ', 'message'],
    ['東京タ', 'message'],
    ['renderer/rail', 'message'],
    ['rail.tsx', 'message'],
  ];
  for (const [query, kind] of rows) {
    const result = search(store, query);
    assert.equal(result.groups.length, 1, query);
    assert.equal(result.groups[0].hits[0].kind, kind, query);
  }
  assert.deepEqual(search(store, 'absent term').groups, []);
});

test('words under three characters are ignored, and a query of only those finds nothing', (t) => {
  const { store } = openStore(t);
  const w = world(store);
  w.task(1, 'Notes');
  w.message(1, 1, 'fix the rounding');
  assert.deepEqual(searchTerms('a  go rounding rounding'), ['rounding']);
  const short = search(store, 'go to');
  assert.equal(short.tooShort, true);
  assert.deepEqual(short.groups, []);
  assert.equal(search(store, 'to rounding').groups.length, 1, 'the short word is dropped');
  assert.equal(search(store, 'rounding').tooShort, false);
});

test('query syntax is text: quotes, operators and wildcards never reach the index as syntax', (t) => {
  const { store } = openStore(t);
  const w = world(store);
  w.task(1, 'Notes');
  w.message(1, 1, 'say "hello" OR goodbye, NEAR(x) and star* too');
  for (const query of [
    '"hello" OR',
    'NEAR(x',
    'star*',
    'AND OR NOT',
    '") DROP TABLE',
    'col:hello',
    '-hello',
  ]) {
    assert.doesNotThrow(() => search(store, query), query);
  }
  assert.equal(search(store, '"hello" OR').groups.length, 1);
  assert.equal(search(store, 'star*').groups.length, 1);
  assert.equal(search(store, 'hello AND nothingmatches').groups.length, 0);
});

test('a page is bounded in threads, hits per thread and bytes, and says when it left matches out', (t) => {
  const { store } = openStore(t);
  const w = world(store);
  for (let thread = 1; thread <= 30; thread++) {
    w.task(thread, thread === 7 ? 'Thread zanzibar' : `Thread ${thread}`);
    for (let n = 1; n <= 8; n++)
      w.message(thread, thread * 100 + n, `common phrase number ${n} ${'filler '.repeat(60)}`);
  }
  const rows: [{ limit?: number; perThread?: number }, number, number, boolean][] = [
    [{ limit: 5, perThread: 2 }, 5, 2, true],
    [{ limit: 50, perThread: 5 }, 30, 5, true],
    [{ limit: 1, perThread: 1 }, 1, 1, true],
  ];
  for (const [bounds, threads, hits, more] of rows) {
    const result = search(store, 'common phrase', bounds);
    assert.equal(result.groups.length, threads, JSON.stringify(bounds));
    for (const group of result.groups) assert.ok(group.hits.length <= hits);
    assert.equal(result.more, more);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_CHAT_SEARCH_BYTES);
  }
  const few = search(store, 'zanzibar');
  assert.equal(few.groups[0].taskId, taskId(7), 'the best title is first');
});

test('a very large number of matches is cut at the best ones', (t) => {
  const { store } = openStore(t);
  const w = world(store);
  w.task(1, 'Bulk');
  for (let n = 1; n <= 600; n++) w.message(1, n, `needle number ${n}`);
  const result = search(store, 'needle', { perThread: 5 });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].hits.length, 5);
  assert.equal(result.more, true);
});

test('one busy thread cannot fill the page, so quieter threads still appear', (t) => {
  const { store } = openStore(t);
  const w = world(store);
  // Thread 1 holds 450 short, strong matches. Threads 2 and 3 each hold one weaker match.
  w.task(1, 'Busy thread');
  for (let n = 1; n <= 450; n++) w.message(1, n, 'needle');
  w.task(2, 'Quiet thread');
  w.message(2, 1000, `a long message that mentions the needle once ${'filler '.repeat(80)}`);
  w.task(3, 'Other thread');
  w.message(3, 1001, `another long message about the needle ${'filler '.repeat(80)}`);
  const result = search(store, 'needle', { limit: 10, perThread: 3 });
  assert.deepEqual(
    result.groups.map((group) => group.taskId).sort(),
    [taskId(1), taskId(2), taskId(3)],
    'all three threads are on the page',
  );
  const busy = result.groups.find((group) => group.taskId === taskId(1));
  assert.equal(busy?.hits.length, 3, 'the busy thread keeps only its best few');
  assert.equal(result.groups[0].taskId, taskId(1), 'the busy thread still ranks first');
  assert.equal(result.more, true);
});

test('user messages get their turns from one read per thread', (t) => {
  const { store } = openStore(t);
  const w = world(store);
  w.task(1, 'Turns');
  for (let n = 1; n <= 4; n++) {
    w.message(1, n, `question zebra ${n}`);
    w.turn(1, n, n, n - 1);
  }
  const result = search(store, 'zebra', { perThread: 5 });
  const turns = result.groups[0].hits.map((hit) => hit.turnId).sort();
  assert.deepEqual(turns, [1, 2, 3, 4].map(turnId));
});

test('a message that holds the marker characters is shown without marks, not with false ones', (t) => {
  const { store } = openStore(t);
  const w = world(store);
  w.task(1, 'Markers');
  w.message(1, 1, 'before \u0001 the zebra \u0002 after');
  w.task(2, 'Plain');
  w.message(2, 2, 'a plain zebra here');
  const result = search(store, 'zebra');
  const byTask = (id: string) => result.groups.find((group) => group.taskId === id)?.hits[0];
  const odd = byTask(taskId(1));
  assert.ok(odd);
  assert.equal(odd.marks.length, 0);
  assert.ok(!odd.snippet.includes('\u0001') && !odd.snippet.includes('\u0002'));
  assert.equal(byTask(taskId(2))?.marks.length, 1, 'other messages keep their marks');
});

const populate = (w: ReturnType<typeof world>) => {
  w.task(1, 'Old thread about rounding');
  w.message(1, 1, 'first question about totals');
  w.turn(1, 1, 1, 0);
  w.message(1, 2, 'an answer about totals', 'chat-assistant', 1);
  w.agent(1, {
    type: 'tool.started',
    turnId: turnId(1),
    callId: 'a',
    kind: 'edit',
    title: 'Edit',
    input: { file_path: 'src/totals.ts' },
  });
  w.agent(1, {
    type: 'tool.completed',
    turnId: turnId(1),
    callId: 'a',
    status: 'ok',
    summary: 'Changed one line',
    diff: { path: 'src/totals.ts', additions: 1, deletions: 1, patch: null },
  });
};
const docs = (store: Store) =>
  store.db
    .prepare(
      'SELECT task_id,kind,ref,turn_id,message_id,body FROM chat_search_docs ORDER BY kind,ref',
    )
    .all()
    .map((row) => ({ ...row }));

test('the migration indexes threads that exist before it, the way live writes index them', (t) => {
  // A database at version 17 with a thread in it, written without any index.
  const old = mkdtempSync(join(tmpdir(), 'crewkite-search-old-'));
  t.after(() => rmSync(old, { recursive: true, force: true }));
  for (const file of readdirSync(migrations).filter((name) => Number(name.slice(0, 3)) <= 17))
    copyFileSync(join(migrations, file), join(old, file));
  const { store } = openStore(t, false);
  store.applyMigrations(old);
  assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 17);
  store.transaction(() => {
    store.put('task', taskId(1), 0, {
      id: taskId(1),
      projectId: 'prj_x',
      title: 'Old thread about rounding',
      outcome: 'outcome',
      criteria: [],
    });
    const entry = store.db.prepare(
      'INSERT INTO conversation_entries(id,task_id,body) VALUES (?,?,?)',
    );
    entry.run(
      messageId(1),
      taskId(1),
      JSON.stringify({
        kind: 'user-message',
        id: messageId(1),
        text: 'first question about totals',
        author: { kind: 'user' },
      }),
    );
    entry.run(
      messageId(2),
      taskId(1),
      JSON.stringify({
        kind: 'chat-assistant',
        id: messageId(2),
        text: 'an answer about totals',
        author: { kind: 'assistant', turnId: turnId(1) },
      }),
    );
    const event = store.db.prepare('INSERT INTO events(event_id,task_id,body) VALUES (?,?,?)');
    for (const payload of [
      {
        type: 'tool.started',
        turnId: turnId(1),
        callId: 'a',
        kind: 'edit',
        title: 'Edit',
        input: { file_path: 'src/totals.ts' },
      },
      { type: 'tool.output', turnId: turnId(1), callId: 'a', chunk: 'unindexed-output' },
      {
        type: 'tool.completed',
        turnId: turnId(1),
        callId: 'a',
        status: 'ok',
        summary: 'Changed one line',
        diff: { path: 'src/totals.ts', additions: 1, deletions: 1, patch: null },
      },
    ])
      event.run(
        `evt_${ulid(++eventCounter)}`,
        taskId(1),
        JSON.stringify({ type: 'agent.event', payload }),
      );
  });
  store.applyMigrations(migrations);
  const applied = readdirSync(migrations).filter((name) => /^\d{3}-[a-z0-9-]+\.sql$/.test(name));
  assert.ok(applied.length >= 18);
  assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, applied.length);
  const migrated = docs(store);
  assert.deepEqual(found(search(store, 'src/totals')), [[taskId(1), ['path']]]);
  assert.deepEqual(found(search(store, 'changed one line')), [[taskId(1), ['tool']]]);
  assert.deepEqual(found(search(store, 'first question')), [[taskId(1), ['message']]]);
  assert.deepEqual(found(search(store, 'unindexed-output')), []);

  // The same thread written through the triggers gives the same rows.
  const live = openStore(t);
  populate(world(live.store));
  assert.deepEqual(migrated, docs(live.store));
});

test('rebuilding from the migration backfill gives the index live writes made', (t) => {
  const { store } = openStore(t);
  populate(world(store));
  const expected = docs(store);
  assert.ok(expected.length >= 6);
  const sql = readFileSync(join(migrations, '018-chat-search.sql'), 'utf8');
  const backfill = sql.slice(sql.indexOf('UPDATE entities SET body = body'));
  assert.ok(backfill.includes('UPDATE events'));
  store.db.exec('DELETE FROM chat_search_docs');
  assert.equal(docs(store).length, 0);
  store.transaction(() => store.db.exec(backfill));
  assert.deepEqual(docs(store), expected);
  assert.deepEqual(found(search(store, 'src/totals')), [[taskId(1), ['path']]]);
});

// Controller layer: the writes a real turn makes keep the index in step, and deleting the thread
// takes its rows with it.
test('the index follows a new turn, a rename and a delete in the same commit', {
  timeout: 30_000,
}, async (t) => {
  const selection = { family: 'openai', model: 'fixture-model', effort: 'default' } as const;
  const adapter = createScriptedChatAdapter({
    family: 'openai',
    turns: [
      [
        { kind: 'tool', callId: 't1', toolKind: 'command', title: 'Run zebra-checks' },
        { kind: 'text', itemId: 'r', chunks: ['The giraffe ', 'fix is in.'] },
      ],
    ],
  });
  const { controller, command, draft } = await setup(t, {
    chatAdapters: new Map([['openai', adapter]]),
    identity: { name: 'Fixture owner', email: 'owner@example.invalid' },
  });
  const task = (await controller.execute(draft, 'local-owner')).entity as Task;
  const query = async (text: string) =>
    ((await controller.execute(command('SearchChatHistory', { query: text }), 'local-owner'))
      .data ?? { groups: [] }) as ChatSearchResult & { kind: string };
  assert.equal((await query('Fixture')).groups.length, 0, 'the fixture title is not a search word');
  assert.deepEqual(
    (await query(task.title)).groups.map((group) => group.taskId),
    [task.id],
    'a new task is searchable by its title',
  );
  assert.equal((await query('walrus')).kind, 'chat-search');

  const done = new Promise<void>((resolve) => {
    const stop = controller.store.subscribe((event) => {
      if (
        event.type === 'chat.thread' &&
        (event.payload as ChatThread).activeTurnId === null &&
        (event.payload as ChatThread).queued.length === 0
      ) {
        stop();
        resolve();
      }
    });
  });
  const sent = await controller.execute(
    command(
      'SendChatMessage',
      { taskId: task.id, text: 'Find the walrus bug', selection },
      task.revision,
    ),
    'local-owner',
  );
  assert.equal(sent.outcome, 'applied');
  await done;
  const kinds = async (text: string) =>
    (await query(text)).groups.flatMap((group) => group.hits.map((hit) => hit.kind));
  assert.deepEqual(await kinds('walrus bug'), ['message']);
  assert.deepEqual(await kinds('giraffe fix'), ['message']);
  assert.deepEqual(await kinds('zebra-checks'), ['tool']);
  const [hit] = (await query('zebra-checks')).groups[0].hits;
  assert.ok(hit.turnId && hit.messageId && hit.messageCursor, 'a tool hit opens its turn');

  const renamed = await controller.execute(
    command('RenameChatThread', { taskId: task.id, title: 'Quokka investigation' }, 0),
    'local-owner',
  );
  assert.equal(renamed.outcome, 'applied');
  assert.deepEqual(await kinds('quokka'), ['title']);
  assert.deepEqual(await kinds(task.title), [], 'the old title is gone');

  const removed = await controller.execute(
    command('DeleteChatThread', { taskId: task.id }, 0),
    'local-owner',
  );
  assert.equal(removed.outcome, 'applied');
  for (const word of ['quokka', 'walrus bug', 'giraffe fix', 'zebra-checks'])
    assert.deepEqual((await query(word)).groups, [], `${word} is gone with the thread`);
  const left = controller.store.db.prepare('SELECT count(*) AS n FROM chat_search_docs').get();
  assert.equal(left?.n, 0, 'no index row outlives its thread');
});

test('a snippet reads its markers into offsets and flattens line breaks', () => {
  const rows: [string, string, [number, number][]][] = [
    ['\u0001ab\u0002 cd', 'ab cd', [[0, 2]]],
    [
      'x \u0001one\u0002 y \u0001two\u0002',
      'x one y two',
      [
        [2, 5],
        [8, 11],
      ],
    ],
    ['line one\nline\u0001 two\u0002', 'line one line two', [[13, 17]]],
    ['a\u0001 stray open', 'a stray open', []],
    ['a stray close\u0002 and \u0001ab\u0002', 'a stray close and ab', [[18, 20]]],
    ['\u0001one \u0001two\u0002', 'one two', [[0, 7]]],
    ['no marks at all', 'no marks at all', []],
  ];
  assert.deepEqual(readSnippet('\u0001ab\u0002 cd', true), { snippet: 'ab cd', marks: [] });
  for (const [raw, text, marks] of rows) {
    const read = readSnippet(raw);
    assert.equal(read.snippet, text, raw);
    assert.deepEqual(
      read.marks.map(({ start, end }) => [start, end]),
      marks,
      raw,
    );
  }
});
