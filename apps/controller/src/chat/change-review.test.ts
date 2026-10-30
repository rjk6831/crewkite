import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type {
  ChatChangesRead,
  ChatThreadRead,
  ChatTurn,
  CommandResult,
  Event,
  Task,
} from '@crewkite/contracts';
import { createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import type { Controller } from '../commands/controller.ts';
import { git } from '../host/source.ts';
import { setup } from '../store/controller-fixture.ts';

const selection = { family: 'openai', model: 'model-a', effort: 'default' } as const;

// Twenty numbered lines, so edits seven lines apart land in separate hunks.
const numbered = Array.from({ length: 20 }, (_, index) => `line ${index + 1}\n`).join('');
const edit = (text: string, changes: Record<number, string>) =>
  text
    .split('\n')
    .slice(0, -1)
    .map((line, index) => `${changes[index + 1] ?? line}\n`)
    .join('');

function next(controller: Pick<Controller, 'store'>, match: (event: Event) => boolean) {
  return new Promise<Event>((resolve) => {
    const stop = controller.store.subscribe((event) => {
      if (!match(event)) return;
      stop();
      resolve(event);
    });
  });
}
const turnDone = (controller: Pick<Controller, 'store'>) =>
  next(
    controller,
    (event) => event.type === 'chat.turn' && (event.payload as ChatTurn).state === 'done',
  );

/**
 * A thread whose base holds `files`, after one turn that left the scratch copy as the base has
 * it. Tests then write the copy the way a provider edit would.
 */
async function thread(t: TestContext, files: Record<string, string>, turns = 1) {
  const adapter = createScriptedChatAdapter({
    family: 'openai',
    turns: Array.from({ length: turns }, () => [
      { kind: 'text' as const, itemId: 'reply', chunks: ['Done.'] },
    ]),
  });
  const context = await setup(t, {
    chatAdapters: new Map([['openai', adapter]]),
    identity: { name: 'Fixture owner', email: 'owner@example.invalid' },
  });
  const { controller, command, source } = context;
  const repo = (...args: string[]) => git(source.directory, args).toString('utf8').trim();
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(source.directory, path, '..'), { recursive: true });
    writeFileSync(join(source.directory, path), content);
  }
  repo('add', '-A');
  git(source.directory, ['commit', '-qm', 'fixture'], undefined, {
    name: 'Fixture',
    email: 'fixture@example.invalid',
    at: '2026-10-15T18:00:00Z',
  });
  const task = (await controller.execute(context.draft, 'local-owner')).entity as Task;
  const run = (name: string, payload: object) =>
    controller.execute(
      command(name, { taskId: task.id, ...payload }, task.revision),
      'local-owner',
    ) as Promise<CommandResult>;
  const read = (name: string, payload: object = {}) =>
    controller.execute(command(name, { taskId: task.id, ...payload }), 'local-owner');
  const done = turnDone(controller);
  await run('SendChatMessage', { text: 'Edit the files.', selection });
  await done;
  const scratch = adapter.requests[0].scratch.directory;
  const page = async (payload: object = {}) => {
    const result = await read('ReadChatChanges', payload);
    assert.equal(result.outcome, 'applied', result.next);
    const { kind: _kind, ...rest } = result.data as ChatChangesRead & { kind: string };
    return rest as ChatChangesRead;
  };
  const thread = async () =>
    (await read('ReadChatThread')).data as ChatThreadRead & { kind: 'chat-thread' };
  return { controller, task, run, read, page, thread, scratch, repo, source, adapter };
}

const blob = (content: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest('hex');

test('accept to branch publishes only accepted hunks, and the branch tree matches by blob id', {
  timeout: 60000,
}, async (t) => {
  const copyA = edit(numbered, { 2: 'line two', 10: 'line ten', 18: 'line eighteen' });
  const copyB = edit(numbered, { 3: 'line three' });
  const cases: {
    name: string;
    accept: Record<string, number[]>;
    discard?: Record<string, number[]>;
    branch: Record<string, string>;
    left: Record<string, string>;
  }[] = [
    {
      name: 'no decisions keep whole-file accept',
      accept: {},
      branch: { 'a.txt': copyA, 'b.txt': copyB },
      left: {},
    },
    {
      name: 'accepted hunks reach the branch and undecided ones stay in the copy',
      accept: { 'a.txt': [0, 2] },
      branch: {
        'a.txt': edit(numbered, { 2: 'line two', 18: 'line eighteen' }),
        'b.txt': copyB,
      },
      left: { 'a.txt': copyA },
    },
    {
      name: 'a discarded hunk never reaches the branch and an accepted one keeps its mark',
      accept: { 'a.txt': [2] },
      discard: { 'a.txt': [0] },
      branch: { 'a.txt': edit(numbered, { 18: 'line eighteen' }), 'b.txt': copyB },
      left: { 'a.txt': edit(numbered, { 10: 'line ten', 18: 'line eighteen' }) },
    },
  ];
  for (const row of cases) {
    const at = await thread(t, { 'a.txt': numbered, 'b.txt': numbered });
    writeFileSync(join(at.scratch, 'a.txt'), copyA);
    writeFileSync(join(at.scratch, 'b.txt'), copyB);
    const before = await at.page();
    const hunks = (path: string) =>
      before.files.find((file) => file.path === path)?.hunks.map((hunk) => hunk.key) ?? [];
    assert.equal(hunks('a.txt').length, 3, row.name);
    for (const [path, indexes] of Object.entries(row.accept))
      for (const index of indexes) {
        const decided = await at.run('DecideChatHunk', {
          path,
          hunk: hunks(path)[index],
          decision: 'accepted',
        });
        assert.equal(decided.outcome, 'applied', `${row.name}: ${decided.next}`);
      }
    for (const [path, indexes] of Object.entries(row.discard ?? {}))
      for (const index of indexes) {
        const dropped = await at.run('DiscardChatHunk', { path, hunk: hunks(path)[index] });
        assert.equal(dropped.outcome, 'applied', `${row.name}: ${dropped.next}`);
      }
    const listing = (await at.page()).listing;
    const base = at.repo('rev-parse', 'HEAD');
    const accepted = await at.run('AcceptChatChanges', { branch: 'crewkite/partial', listing });
    assert.equal(accepted.outcome, 'applied', `${row.name}: ${accepted.next}`);
    // The branch tree differs from the base exactly by these blob ids.
    const changed = at
      .repo('diff-tree', '-r', '--no-renames', base, 'refs/heads/crewkite/partial')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split('\t');
        return [path, meta.split(' ')[3]];
      });
    assert.deepEqual(
      Object.fromEntries(changed),
      Object.fromEntries(
        Object.entries(row.branch).map(([path, content]) => [path, blob(content)]),
      ),
      row.name,
    );
    // The copy keeps what Accept left out, so Changes lists it against the new base.
    for (const [path, content] of Object.entries(row.left))
      assert.equal(readFileSync(join(at.scratch, path), 'utf8'), content, row.name);
    const after = await at.page();
    assert.deepEqual(
      after.files.map((file) => [file.path, file.decided]),
      Object.keys(row.left).map((path) => [path, false]),
      `${row.name}: decisions end with the accept`,
    );
  }
});

test('a hunk decision drops when the file changes, and binary files stay whole-file', {
  timeout: 30000,
}, async (t) => {
  const at = await thread(t, { 'a.txt': numbered, 'data.bin': '\0\x01' });
  writeFileSync(join(at.scratch, 'a.txt'), edit(numbered, { 2: 'two', 18: 'eighteen' }));
  writeFileSync(join(at.scratch, 'data.bin'), '\0\x02');
  const first = await at.page();
  const binary = first.files.find((file) => file.path === 'data.bin');
  assert.deepEqual([binary?.hunkControls, binary?.hunks], [false, []]);
  const [one, two] = first.files.find((file) => file.path === 'a.txt')?.hunks ?? [];
  const refused = await at.run('DecideChatHunk', {
    path: 'data.bin',
    hunk: one.key,
    decision: 'accepted',
  });
  assert.equal(refused.reason, 'hunks-unavailable');
  await at.run('DecideChatHunk', { path: 'a.txt', hunk: one.key, decision: 'accepted' });
  assert.equal((await at.page()).files.find((file) => file.path === 'a.txt')?.decided, true);
  // A later edit to the file gives it a new blob, so the mark goes and Accept takes the whole file.
  writeFileSync(join(at.scratch, 'a.txt'), edit(numbered, { 2: 'two', 18: 'eighteen', 19: 'x' }));
  const changed = (await at.page()).files.find((file) => file.path === 'a.txt');
  assert.equal(changed?.decided, false);
  assert.ok(changed?.hunks.every((hunk) => hunk.decision === 'undecided'));
  assert.notEqual(changed?.hunks[1].key, two.key);
});

test('paging over more than 2,000 entries reaches every entry once, and accept takes them all', {
  timeout: 120000,
}, async (t) => {
  const at = await thread(t, { 'keep.txt': 'kept\n' });
  const crowd = join(at.scratch, 'crowd');
  mkdirSync(crowd);
  const count = 2105;
  for (let index = 0; index < count; index++)
    writeFileSync(join(crowd, `f${String(index).padStart(4, '0')}`), `${index}\n`);
  // Each page lists the copy again, so the table keeps to two sizes on either side of the old cap.
  const table = [
    { name: 'pages of 2,000', limit: 2000 },
    { name: 'pages of 700', limit: 700 },
  ];
  let listing: string | null = null;
  for (const row of table) {
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    let first: string | null = null;
    do {
      const page = await at.page({
        ...(after ? { after } : {}),
        ...(first ? { listing: first } : {}),
        ...(row.limit ? { limit: row.limit } : {}),
      });
      first ??= page.listing;
      assert.equal(page.total, count, row.name);
      seen.push(...page.files.map((file) => file.path));
      after = page.next ?? undefined;
      pages++;
    } while (after);
    assert.equal(seen.length, count, row.name);
    assert.equal(new Set(seen).size, count, `${row.name}: no entry twice`);
    assert.deepEqual(seen, [...seen].sort(), `${row.name}: stable path order`);
    assert.ok(pages > 1, row.name);
    listing = first;
  }
  // A change between pages refuses the next page with the old listing.
  writeFileSync(join(crowd, 'late'), 'late\n');
  const stale = await at.read('ReadChatChanges', { after: 'crowd/f0100', listing });
  assert.deepEqual([stale.outcome, stale.reason], ['blocked', 'listing-changed']);
  const refused = await at.run('AcceptChatChanges', { branch: 'crewkite/crowd', listing });
  assert.equal(refused.reason, 'listing-changed');
  const fresh = (await at.page()).listing;
  const accepted = await at.run('AcceptChatChanges', { branch: 'crewkite/crowd', listing: fresh });
  assert.equal(accepted.outcome, 'applied', accepted.next);
  assert.equal((accepted.data as { fileCount: number }).fileCount, count + 1);
  assert.equal(
    at.repo('ls-tree', '-r', '--name-only', 'refs/heads/crewkite/crowd', 'crowd').split('\n')
      .length,
    count + 1,
  );
});

test('a review comment queues a message that quotes the file, the lines and the hunk', {
  timeout: 30000,
}, async (t) => {
  const at = await thread(t, { 'a.txt': numbered }, 2);
  writeFileSync(join(at.scratch, 'a.txt'), edit(numbered, { 10: 'line ten' }));
  const [hunk] = (await at.page()).files[0].hunks;
  const hunkText = [
    '@@ -7,7 +7,7 @@',
    ' line 7',
    ' line 8',
    ' line 9',
    '-line 10',
    '+line ten',
    ' line 11',
    ' line 12',
    ' line 13',
  ];
  const cases = [
    {
      name: 'a comment on the hunk quotes every hunk line',
      payload: { text: 'Keep the number.' },
      expected: [
        'Review comment on a.txt, the hunk at old line 7, new line 7:',
        '',
        '```diff',
        ...hunkText,
        '```',
        '',
        'Keep the number.',
      ].join('\n'),
    },
    {
      name: 'a comment on copy lines quotes those lines and the lines removed between them',
      payload: { text: 'Why spell it out?', lines: { side: 'new', start: 9, end: 10 } },
      expected: [
        'Review comment on a.txt, copy lines 9 to 10:',
        '',
        '```diff',
        hunkText[0],
        ' line 9',
        '-line 10',
        '+line ten',
        '```',
        '',
        'Why spell it out?',
      ].join('\n'),
    },
  ];
  for (const row of cases) {
    const done = turnDone(at.controller);
    const sent = await at.run('CommentChatChange', {
      path: 'a.txt',
      hunk: hunk.key,
      ...row.payload,
    });
    assert.equal(sent.outcome, 'applied', `${row.name}: ${sent.next}`);
    await done;
    const asked = at.adapter.requests.at(-1)?.prompt ?? '';
    assert.ok(asked.includes(row.expected), `${row.name}:\n${asked}`);
    const user = (await at.thread()).messages.filter((m) => m.author.kind === 'user').at(-1);
    assert.equal(user?.text, row.expected, row.name);
  }
  const outside = await at.run('CommentChatChange', {
    path: 'a.txt',
    hunk: hunk.key,
    text: 'Here?',
    lines: { side: 'old', start: 1, end: 2 },
  });
  assert.equal(outside.reason, 'lines-outside-hunk');
});

test('hunk commands go through the same ownership and turn checks as discard', {
  timeout: 30000,
}, async (t) => {
  const adapter = createScriptedChatAdapter({
    family: 'openai',
    turns: [
      [{ kind: 'text', itemId: 'reply', chunks: ['Working'], complete: false }, { kind: 'wait' }],
    ],
  });
  const context = await setup(t, { chatAdapters: new Map([['openai', adapter]]) });
  const { controller, command } = context;
  const task = (await controller.execute(context.draft, 'local-owner')).entity as Task;
  const run = (name: string, payload: object) =>
    controller.execute(
      command(name, { taskId: task.id, ...payload }, task.revision),
      'local-owner',
    );
  const streaming = next(
    controller,
    (event) => event.type === 'agent.event' && event.payload.type === 'text.delta',
  );
  await run('SendChatMessage', { text: 'Edit.', selection });
  await streaming;
  const hunk = 'a'.repeat(64);
  const table: [string, object][] = [
    ['DecideChatHunk', { path: 'net.mjs', hunk, decision: 'accepted' }],
    ['DiscardChatHunk', { path: 'net.mjs', hunk }],
  ];
  for (const [name, payload] of table) {
    const result = await run(name, payload);
    assert.deepEqual([result.outcome, result.reason], ['blocked', 'turn-running'], name);
  }
  const missing = await controller.execute(
    command('DiscardChatHunk', { taskId: `tsk_${'1'.repeat(26)}`, path: 'a', hunk }, 0),
    'local-owner',
  );
  assert.deepEqual([missing.outcome, missing.reason], ['blocked', 'task-not-found']);
});
