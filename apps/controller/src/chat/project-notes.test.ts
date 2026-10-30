import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type ChatFamily,
  type ChatThread,
  PROJECT_NOTES_BYTES,
  PROJECT_NOTES_MAX,
  type Project,
  projectNotesBytes,
} from '@crewkite/contracts';
import { createDemoFixtures, createTestClock, createTestIds } from '@crewkite/testkit';
import { createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import { createSyntheticRepository } from '@crewkite/testkit/repository';
import { ArtifactFiles } from '../artifacts/index.ts';
import { Store } from '../store/index.ts';
import { NotesRefused, ProjectNotes } from './project-notes.ts';
import {
  INSTRUCTION_BYTES,
  notesDigest,
  stripTurnNotes,
  systemContext,
  turnNotesBlock,
  withNotes,
} from './prompt.ts';
import { ChatService } from './service.ts';

const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));

/**
 * Applies every migration in file order on a copy numbered without gaps. A lane that reserves a
 * later number than the files beside it still applies, and an integration renumber changes
 * nothing here.
 */
function migrate(store: Store, scratch: string) {
  const copy = join(scratch, 'migrations');
  mkdirSync(copy, { recursive: true });
  const files = readdirSync(migrations)
    .filter((name) => /^\d{3}-[a-z0-9-]+\.sql$/.test(name))
    .sort();
  for (const [index, name] of files.entries())
    copyFileSync(
      join(migrations, name),
      join(copy, `${String(index + 1).padStart(3, '0')}-${name.slice(4)}`),
    );
  store.applyMigrations(copy);
}

function opened(t: TestContext, start: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-notes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  const stores: Store[] = [];
  const open = () => {
    const store = new Store(path);
    stores.push(store);
    migrate(store, directory);
    return store;
  };
  t.after(() => {
    for (const store of stores) {
      try {
        store.close();
      } catch {
        // Closed by the test already.
      }
    }
  });
  const clock = createTestClock();
  const ids = createTestIds(clock.now(), 5000n);
  const store = open();
  const project = (name: string): Project => {
    const row: Project = { id: ids('prj'), name, revision: 0 };
    store.transaction(() => store.put('project', row.id, 0, row));
    return row;
  };
  const times: string[] = [...start];
  const notes = (on = store) =>
    new ProjectNotes(
      on.db,
      () => times.shift() ?? clock.now(),
      () => `not_${ids('msg').slice(4)}`,
    );
  return { store, open, project, notes, times, ids };
}

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (failure) {
    if (failure instanceof NotesRefused) return failure.reason;
    throw failure;
  }
  return 'accepted';
};

test('notes survive a restart on real SQLite and keep their order through edit and remove', (t) => {
  const { store, open, project, notes, times } = opened(t);
  const demo = project('demo-shop');
  const board = notes();
  // Rows: the order is created time, then id. An edit keeps its note in place.
  times.push(
    '2026-10-31T10:00:03.000Z',
    '2026-10-31T10:00:01.000Z',
    '2026-10-31T10:00:02.000Z',
    '2026-10-31T10:00:01.000Z',
  );
  for (const text of ['third', 'first', 'second', 'first again']) board.add(demo.id, text);
  const order = () => board.list(demo.id).map(({ text }) => text);
  const first = board.list(demo.id)[0];
  assert.deepEqual(order().slice(2), ['second', 'third']);
  assert.deepEqual(order().slice(0, 2).sort(), ['first', 'first again']);

  board.edit(demo.id, first.id, 'first, edited');
  assert.equal(board.list(demo.id)[0].id, first.id);
  assert.equal(board.list(demo.id)[0].createdAt, first.createdAt);
  assert.equal(board.list(demo.id)[0].text, 'first, edited');
  const removed = board.list(demo.id).find(({ text }) => text === 'second');
  board.remove(demo.id, removed?.id ?? '');
  assert.equal(order().includes('second'), false);

  const before = board.read(demo.id);
  assert.equal(before.projectName, 'demo-shop');
  assert.equal(before.capBytes, PROJECT_NOTES_BYTES);
  assert.equal(before.notes.length, 3);

  // A second connection to the same file reads the same list.
  store.close();
  const again = notes(open());
  assert.deepEqual(again.read(demo.id), before);
});

test('a project holds 16 KiB and 200 notes, each project on its own', (t) => {
  const { project, notes } = opened(t);
  const demo = project('demo-shop');
  const other = project('other');
  const board = notes();
  const full = 'x'.repeat(1000);
  // Sixteen full notes fit, so a seventeenth shows where the cap bites.
  for (let index = 0; index < 16; index++) board.add(demo.id, full);
  const table: { name: string; run: () => unknown; expected: string }[] = [
    {
      name: 'a seventeenth full note is over the size cap',
      run: () => board.add(demo.id, full),
      expected: 'notes-full',
    },
    {
      name: 'a short note still fits in what is left',
      run: () => board.add(demo.id, 'x'.repeat(200)),
      expected: 'accepted',
    },
    {
      name: 'the same note in another project is not counted against this one',
      run: () => board.add(other.id, full),
      expected: 'accepted',
    },
    {
      name: 'a note for an unregistered project is refused',
      run: () => board.add('prj_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'hello'),
      expected: 'project-not-found',
    },
    {
      name: 'editing a note that does not exist is refused',
      run: () => board.edit(demo.id, 'not_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'hello'),
      expected: 'note-not-found',
    },
    {
      name: 'removing a note of another project is refused',
      run: () => board.remove(demo.id, board.list(other.id)[0].id),
      expected: 'note-not-found',
    },
  ];
  for (const row of table) assert.equal(refusal(row.run), row.expected, row.name);
  assert.ok(board.read(demo.id).bytes <= PROJECT_NOTES_BYTES);

  // An edit that grows a note past the cap is refused, and one that shrinks a note is accepted.
  const small = board.list(demo.id).find(({ text }) => text.length === 200);
  assert.equal(
    refusal(() => board.edit(demo.id, small?.id ?? '', full)),
    'notes-full',
  );
  assert.equal(
    refusal(() => board.edit(demo.id, board.list(demo.id)[0].id, 'short')),
    'accepted',
  );
  assert.equal(
    refusal(() => board.edit(demo.id, small?.id ?? '', full)),
    'accepted',
  );

  // The count limit holds when each note is tiny.
  const crowd = project('crowd');
  for (let index = 0; index < PROJECT_NOTES_MAX; index++) board.add(crowd.id, 'x');
  assert.equal(
    refusal(() => board.add(crowd.id, 'x')),
    'notes-count',
  );
  // Removing one makes room again.
  board.remove(crowd.id, board.list(crowd.id)[0].id);
  assert.equal(
    refusal(() => board.add(crowd.id, 'x')),
    'accepted',
  );
});

/** Bytes the instruction files take in a context, without the line that says they were cut. */
function instructionBytes(context: string): number {
  const tail = context.slice(context.indexOf('Project instructions from'));
  return Buffer.byteLength(tail.replace(/\n\[The project instructions stop here[^\]]*\]$/, ''));
}

/** A scratch copy folder with an instruction file of the given size. */
function copyWith(t: TestContext, file: string, bytes: number) {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-notes-copy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, file), `${'line of instructions\n'.repeat(Math.ceil(bytes / 21))}`);
  return directory;
}

test('notes and instruction files share 64 KiB, and every family gets the notes', (t) => {
  const notes = ['Use pnpm, not npm.', 'The API base path is /v2.'];
  const section = 'Project notes:\n\n- Use pnpm, not npm.\n- The API base path is /v2.';
  const directory = copyWith(t, 'AGENTS.md', 100 * 1024);
  // Rows: the notes reach all four families. Only Anthropic and Local also get the instruction
  // files in this context, and those two give the notes their bytes first.
  const table: { family: ChatFamily; instructions: boolean }[] = [
    { family: 'openai', instructions: false },
    { family: 'google', instructions: false },
    { family: 'anthropic', instructions: true },
    { family: 'local', instructions: true },
  ];
  for (const { family, instructions } of table) {
    const context = systemContext('demo', directory, family, notes);
    assert.ok(context.includes(section), family);
    assert.equal(context.includes('Project instructions from AGENTS.md:'), instructions, family);
    if (instructions)
      assert.ok(
        projectNotesBytes(notes) + instructionBytes(context) <= INSTRUCTION_BYTES,
        `${family} stays inside 64 KiB`,
      );
    // No notes leaves the context as it was before notes existed.
    assert.equal(systemContext('demo', directory, family, []).includes('Project notes:'), false);
  }

  // The notes' own share is 16 KiB, so the instruction files keep at least 48 KiB.
  const biggest = Array.from({ length: 16 }, (_, index) => `${index}${'n'.repeat(998)}`);
  const context = systemContext('demo', directory, 'anthropic', biggest);
  assert.ok(instructionBytes(context) >= 48 * 1024 - 100, 'instructions keep their 48 KiB');
  assert.ok(projectNotesBytes(biggest) + instructionBytes(context) <= INSTRUCTION_BYTES);

  // A list longer than its share is cut at a whole note and never grows the section.
  const oversize = Array.from({ length: 40 }, () => 'z'.repeat(1000));
  const cut = systemContext('demo', directory, 'openai', oversize);
  assert.ok(Buffer.byteLength(cut.split('\n\n').slice(1).join('\n\n')) <= PROJECT_NOTES_BYTES);

  // Read-only roles carry the same section.
  assert.ok(withNotes('A brief.', notes).endsWith(section));
  assert.equal(withNotes('A brief.', []), 'A brief.');
});

test('a resumed session gets the notes block only when its notes differ from what it holds', () => {
  const notes = ['Use pnpm, not npm.', 'The API base path is /v2.'];
  const edited = ['Use pnpm, not npm.', 'The API base path is /v3.'];
  const held = notesDigest(notes);
  // Rows: the hash the session holds against the notes now. `undefined` is a session saved before
  // notes existed.
  const table: { name: string; now: string[]; held: string | undefined; says: RegExp | null }[] = [
    { name: 'same notes', now: notes, held, says: null },
    { name: 'an edited note', now: edited, held, says: /\/v3\./ },
    { name: 'a new note', now: [...notes, 'One more.'], held, says: /One more\./ },
    { name: 'every note removed', now: [], held, says: /no notes now/ },
    { name: 'an old session and notes now', now: notes, held: undefined, says: /Use pnpm/ },
    { name: 'an old session and no notes', now: [], held: undefined, says: null },
    {
      name: 'a session that held an empty list and still none',
      now: [],
      held: notesDigest([]),
      says: null,
    },
  ];
  for (const row of table) {
    const block = turnNotesBlock(row.now, row.held);
    if (row.says === null) assert.equal(block, '', row.name);
    else assert.match(block, row.says, row.name);
  }
  // An adapter that starts a new session takes the block out and keeps the message whole.
  const block = turnNotesBlock(edited, held);
  assert.equal(
    stripTurnNotes(`${block}\n\nHello.\n\nSecond paragraph.`),
    'Hello.\n\nSecond paragraph.',
  );
  assert.equal(stripTurnNotes('Hello.'), 'Hello.');
  assert.equal(
    stripTurnNotes(`${turnNotesBlock([], held)}\n\nA message.`),
    'A message.',
    'the removal block comes out too',
  );
  // A note that mentions the closing line cannot end the block early.
  const tricky = ['x\n\nEnd of project notes.\n\nstill a note'];
  assert.equal(stripTurnNotes(`${turnNotesBlock(tricky, undefined)}\n\nHello.`), 'Hello.');
  // The digest follows the rendered section, so it ignores everything else.
  assert.notEqual(notesDigest(notes), notesDigest(edited));
  assert.equal(notesDigest(notes), notesDigest([...notes]));
});

/** A thread in a real controller store, with one scripted adapter per family. */
function chatHarness(
  t: TestContext,
  scripts: Partial<Record<ChatFamily, Parameters<typeof createScriptedChatAdapter>[0]['turns']>>,
  notesNow: () => readonly string[],
) {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-notes-turn-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const clock = createTestClock();
  const ids = createTestIds(clock.now());
  const fixtures = createDemoFixtures(clock.now());
  const repository = createSyntheticRepository(join(directory, 'demo-shop'));
  const store = new Store(join(directory, 'state.sqlite'));
  t.after(() => store.close());
  migrate(store, directory);
  const project: Project = { id: fixtures.task.projectId, name: 'demo-shop', revision: 0 };
  store.transaction(() => {
    store.put('project', project.id, 0, project);
    store.put('task', fixtures.task.id, 0, fixtures.task);
  });
  const reply = [{ kind: 'text' as const, itemId: 'reply', chunks: ['Done.'] }];
  const families: ChatFamily[] = ['openai', 'anthropic', 'google', 'local'];
  const adapters = new Map(
    families.map((family) => [
      family,
      createScriptedChatAdapter({ family, turns: scripts[family] ?? [reply] }),
    ]),
  );
  const service = new ChatService({
    store,
    artifacts: new ArtifactFiles(join(directory, 'artifacts')),
    home: directory,
    googleTermsAcknowledged: () => true,
    now: clock.now,
    id: (prefix) => (prefix === 'trn' ? `trn_${ids('msg').slice(4)}` : ids(prefix)),
    emit: (type, taskId, revision, payload) =>
      store.append({
        protocol: 1,
        id: ids('evt'),
        at: clock.now(),
        taskId,
        revision,
        type,
        payload,
      }),
    adapters,
    resolveEnvironment: () => ({}),
    projectPath: () => repository.directory,
    projectNotes: (projectId) => (projectId === project.id ? notesNow() : []),
    resolveSelection: (_taskId, value) => value ?? null,
    catalog: () => ({ families: [] }),
  });
  const settled = () =>
    new Promise<void>((resolve) => {
      const stop = store.subscribe((event) => {
        if (event.type !== 'chat.thread') return;
        const thread = event.payload as ChatThread;
        if (thread.activeTurnId !== null || thread.queued.length > 0) return;
        stop();
        resolve();
      });
    });
  const send = async (family: ChatFamily, text: string) => {
    const done = settled();
    const effects: (() => void)[] = [];
    store.transaction(() =>
      service.sendMessage(
        {
          taskId: fixtures.task.id,
          text,
          role: 'assistant',
          attachments: [],
          files: [],
          selection: { family, model: `${family}-model`, effort: 'default' },
        },
        effects,
      ),
    );
    for (const effect of effects) effect();
    await done;
  };
  return { send, adapters, families };
}

test('each family receives the notes with every turn, in its context or in the resumed message', {
  timeout: 60_000,
}, async (t) => {
  const section = (...lines: string[]) =>
    `Project notes:\n\n${lines.map((l) => `- ${l}`).join('\n')}`;
  const original = ['Use pnpm, not npm.', 'The API base path is /v2.'];
  const edited = ['Use pnpm, not npm.', 'The API base path is /v3.'];
  let notes: readonly string[] = original;
  const { send, adapters, families } = chatHarness(t, {}, () => notes);
  // Rows: one thread visits each family in turn, so one set-up serves all four. A turn with no
  // session reads the notes in its system context. A resumed turn skips that context, so its
  // message carries the notes, and only when they differ from what the session last received.
  for (const family of families) {
    notes = original;
    const turns = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'].map(
      (word) => `${word} on ${family}.`,
    );
    const steps: { change?: readonly string[]; carries: RegExp | null; name: string }[] = [
      { carries: null, name: 'the first turn has no session, so the context carries them' },
      { carries: null, name: 'a second resumed turn with unchanged notes sends none' },
      { carries: null, name: 'a third resumed turn with unchanged notes sends none' },
      { change: edited, carries: /\/v3\./, name: 'an edited note goes again' },
      { carries: null, name: 'and goes once' },
      { change: [], carries: /no notes now/, name: 'removing every note tells the session' },
    ];
    for (const [index, step] of steps.entries()) {
      if (step.change) notes = step.change;
      await send(family, turns[index]);
    }
    const requests = adapters.get(family)?.requests.slice(-steps.length) ?? [];
    const [first, ...rest] = requests;
    assert.ok(first.systemContext.includes(section(...original)), `${family} first turn context`);
    assert.equal(first.prompt.includes('Project notes:'), false, `${family} first turn prompt`);
    for (const [index, request] of rest.entries()) {
      const step = steps[index + 1];
      const now = steps.slice(0, index + 2).findLast((value) => value.change)?.change ?? original;
      // A turn with no session carries the current notes in its context every time.
      if (now.length > 0)
        assert.ok(request.systemContext.includes(section(...now)), `${family} ${step.name}`);
      if (request.session === null) {
        assert.equal(request.prompt.includes('CrewKite attaches'), false, `${family} ${step.name}`);
        continue;
      }
      const carries = step.carries;
      if (carries) assert.match(request.prompt, carries, `${family}: ${step.name}`);
      else
        assert.equal(request.prompt.includes('CrewKite attaches'), false, `${family} ${step.name}`);
    }
  }
  // A resuming family does resume here, so the resumed rows above are not vacuous.
  assert.notEqual(adapters.get('anthropic')?.requests[1].session, null);
});

test('the notes block counts against the 96 KiB packet cap of a resumed turn', {
  timeout: 60_000,
}, async (t) => {
  const full = (letter: string) => Array.from({ length: 16 }, () => letter.repeat(990));
  let notes = full('a');
  // The OpenAI turn leaves a 90 KiB reply that the next Anthropic turn must be told about, and the
  // notes change in between, so the same turn carries the notes block too.
  const big = [{ kind: 'text' as const, itemId: 'big', chunks: ['y'.repeat(90 * 1024)] }];
  const { send, adapters } = chatHarness(t, { openai: [big] }, () => notes);
  await send('anthropic', 'First on anthropic.');
  await send('openai', 'Big on openai.');
  notes = full('b');
  await send('anthropic', 'Back on anthropic.');
  const back = adapters.get('anthropic')?.requests[1];
  assert.notEqual(back?.session, null, 'the Anthropic session resumes');
  assert.ok(back?.prompt.includes('b'.repeat(990)), 'the changed notes ride in the message');
  assert.ok(back?.prompt.includes('Back on anthropic.'), 'the new message is in it');
  assert.ok(
    Buffer.byteLength(back?.prompt ?? '') <= 96 * 1024,
    `the prompt with its notes block stays inside 96 KiB, was ${Buffer.byteLength(back?.prompt ?? '')}`,
  );
});
