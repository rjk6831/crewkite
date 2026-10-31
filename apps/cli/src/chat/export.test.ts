import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli } from '../main.ts';
import { startScriptedController } from '../scripted-controller.ts';

test('export writes a Markdown file and a share page to new files and replaces nothing', {
  timeout: 60_000,
}, async (t) => {
  const { home, repository, directory } = await startScriptedController(t, [
    [
      { kind: 'tool', callId: 'read-1', toolKind: 'read', title: 'Read net.mjs' },
      { kind: 'text', itemId: 'reply', chunks: ['Looks fine. Ask owner@example.invalid.'] },
    ],
  ]);
  const run = async (args: string[]) => {
    const io = { out: '', err: '' };
    const code = await runCli(args, {
      out: (text) => {
        io.out += text;
      },
      err: (text) => {
        io.err += text;
      },
    });
    return { code, io };
  };
  const added = await run(['project', 'add', repository, '--json', '--home', home]);
  const projectId = JSON.parse(added.io.out).result?.entity?.id;
  // The thread runs its turn to the end before the command returns.
  const made = await run([
    'thread',
    'new',
    projectId,
    'Review net.mjs',
    '--model',
    'anthropic/fixture-model',
    '--watch',
    '--json',
    '--home',
    home,
  ]);
  assert.equal(made.code, 0, made.io.err);
  const taskId = made.io.out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((line) => line.taskId)?.taskId;
  assert.ok(taskId, made.io.out);

  const notes = join(directory, 'notes.md');
  const page = join(directory, 'page.html');
  const first = await run(['export', taskId, '--markdown', notes, '--html', page, '--home', home]);
  assert.equal(first.code, 0, first.io.err);
  assert.match(readFileSync(notes, 'utf8'), /- read, ok: `Read net\.mjs`/);
  const html = readFileSync(page, 'utf8');
  assert.ok(html.includes('Ask [redacted].'));
  assert.ok(!html.includes('<script'));

  // A second run never replaces a file, and the file it names keeps its bytes. A taken path stops
  // the run before another file is made.
  const before = readFileSync(notes, 'utf8');
  const fresh = join(directory, 'fresh.md');
  const again = await run(['export', taskId, '--markdown', fresh, '--html', page, '--home', home]);
  assert.equal(again.code, 2);
  assert.match(again.io.err, /already exists/);
  assert.equal(readFileSync(page, 'utf8'), html);
  assert.ok(!existsSync(fresh));
  const taken = await run(['export', taskId, '--markdown', notes, '--home', home]);
  assert.equal(taken.code, 2);
  assert.equal(readFileSync(notes, 'utf8'), before);

  // A missing or malformed thread ID is a usage error that names the problem and prints no help.
  // Help is only for --help. Nothing is written for an unknown thread, and no file is left.
  const nameless = await run(['export', '--markdown', fresh, '--home', home]);
  assert.equal(nameless.code, 2);
  assert.match(nameless.io.err, /Give the thread ID/);
  assert.ok(!nameless.io.out.includes('Usage:'));
  const malformed = await run(['export', 'not-an-id', '--markdown', fresh, '--home', home]);
  assert.equal(malformed.code, 2);
  assert.match(malformed.io.err, /not a thread ID/);
  assert.equal((await run(['export', taskId, '--home', home])).code, 2);
  assert.match((await run(['export', '--help'])).io.out, /^Usage: crewkite export/);
  const none = await run([
    'export',
    'tsk_0000000000000000000000000A',
    '--markdown',
    fresh,
    '--home',
    home,
  ]);
  assert.equal(none.code, 2);
  assert.ok(!existsSync(fresh));
});
