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
import { INSTRUCTION_BYTES, systemContext, withNotes, withTurnNotes } from './prompt.ts';
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

  // Read-only roles and resumed sessions carry the same section.
  assert.ok(withNotes('A brief.', notes).endsWith(section));
  assert.equal(withNotes('A brief.', []), 'A brief.');
  assert.ok(withTurnNotes('Hello.', notes).endsWith(`${section}\n\nHello.`));
  assert.equal(withTurnNotes('Hello.', []), 'Hello.');
});

test('each family receives the notes with every turn, in its context or in the resumed message', {
  timeout: 60_000,
}, async (t) => {
  const notes = ['Use pnpm, not npm.', 'The API base path is /v2.'];
  const section = 'Project notes:\n\n- Use pnpm, not npm.\n- The API base path is /v2.';
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
    families.map((family) => [family, createScriptedChatAdapter({ family, turns: [reply] })]),
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
    projectNotes: (projectId) => (projectId === project.id ? notes : []),
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
  // Rows: one thread per family would repeat the setup, so one thread visits each family in turn,
  // twice. The first visit has no session and reads the notes in its system context. The second
  // visit resumes, which skips that context, so the notes ride in front of the message.
  for (const family of families) {
    await send(family, `First on ${family}.`);
    await send(family, `Second on ${family}.`);
    const requests = adapters.get(family)?.requests ?? [];
    const [first, second] = requests;
    assert.ok(first.systemContext.includes(section), `${family} first turn context`);
    assert.equal(first.prompt.includes('Project notes:'), false, `${family} first turn prompt`);
    assert.ok(second.systemContext.includes(section), `${family} second turn context`);
    assert.equal(
      second.prompt.includes(section),
      second.session !== null,
      `${family} resumed message carries the notes iff the session resumes`,
    );
  }
  // A resuming family does resume here, so the resumed row above is not vacuous.
  assert.notEqual(adapters.get('anthropic')?.requests[1].session, null);
});
