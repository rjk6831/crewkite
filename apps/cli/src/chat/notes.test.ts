import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli } from '../main.ts';
import { startScriptedController } from '../scripted-controller.ts';

function capture() {
  const seen = { out: '', err: '' };
  return {
    seen,
    output: {
      out: (text: string) => {
        seen.out += text;
      },
      err: (text: string) => {
        seen.err += text;
      },
    },
  };
}

test('notes list, add and remove go through the controller and refuse what it refuses', {
  timeout: 60_000,
}, async (t) => {
  const { home, repository } = await startScriptedController(t, [[]]);
  const run = async (...args: string[]) => {
    const { seen, output } = capture();
    const code = await runCli([...args, '--home', home], output);
    return { code, ...seen };
  };
  const added = await run('project', 'add', repository);
  const project = /Project (prj_[0-9A-Z]{26})/.exec(added.out)?.[1] ?? '';
  assert.ok(project);

  const empty = await run('notes', 'list', project);
  assert.equal(empty.code, 0);
  assert.match(empty.out, /shop: 0 notes, 0 of 16384 bytes\./);

  const first = await run('notes', 'add', project, 'Use pnpm, not npm.');
  assert.equal(first.code, 0);
  assert.match(first.out, /^Added\./);
  assert.match(first.out, /shop: 1 note, 36 of 16384 bytes\./);
  const second = await run('notes', 'add', project, 'Line one\nline two');
  assert.equal(second.code, 0);

  const listed = await run('notes', 'list', project, '--json');
  const read = JSON.parse(listed.out).read;
  assert.deepEqual(
    read.notes.map((note: { text: string }) => note.text),
    ['Use pnpm, not npm.', 'Line one\nline two'],
  );
  assert.equal(read.capBytes, 16384);

  const removed = await run('notes', 'remove', project, read.notes[0].id);
  assert.equal(removed.code, 0);
  assert.match(removed.out, /Removed\./);
  assert.match(removed.out, /1 note,/);

  // Rows: what each refusal says and the exit status that means nothing was done.
  const unregistered = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const refusals: { name: string; args: string[]; says: RegExp }[] = [
    {
      name: 'a note that is gone',
      args: ['remove', project, read.notes[0].id],
      says: /no longer exists/,
    },
    {
      name: 'an unregistered project',
      args: ['add', unregistered, 'x'],
      says: /registered project/,
    },
    { name: 'a blank note', args: ['add', project, '   '], says: /1 to 1,000 characters/ },
    {
      name: 'a note over the limit',
      args: ['add', project, 'x'.repeat(1001)],
      says: /1 to 1,000 characters/,
    },
    { name: 'a project that is not an ID', args: ['list', 'shop'], says: /not a project ID/ },
    { name: 'an unknown action', args: ['edit', project], says: /Unknown notes command/ },
    { name: 'an unquoted note', args: ['add', project, 'two', 'words'], says: /Quote a note/ },
  ];
  for (const row of refusals) {
    const result = await run('notes', ...row.args);
    assert.equal(result.code, 2, row.name);
    assert.match(result.err, row.says, row.name);
  }
});
