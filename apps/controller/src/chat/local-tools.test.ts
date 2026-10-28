import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runTool } from './local-tools.ts';
import type { ThreadReads } from './thread-reader.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'local-tools-'));
  const scratch = join(root, 'scratch');
  const outside = join(root, 'outside');
  mkdirSync(scratch);
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'outside\n');
  return { root, scratch, outside, context: { scratch, environment: { PATH: process.env.PATH } } };
}

test('edit refuses a missing or repeated match and applies a unique one with a diff', async () => {
  const { root, scratch, context } = fixture();
  try {
    const file = join(scratch, 'a.ts');
    const original = 'const a = 1;\nconst b = 1;\nconst c = 2;\n';
    writeFileSync(file, original);

    const repeated = await runTool('edit', { path: 'a.ts', old: '= 1;', new: '= 3;' }, context);
    assert.equal(repeated.status, 'error');
    assert.match(repeated.output, /appears 2 times/);
    const missing = await runTool('edit', { path: 'a.ts', old: 'const d', new: 'x' }, context);
    assert.equal(missing.status, 'error');
    assert.match(missing.output, /not found/);
    assert.equal(readFileSync(file, 'utf8'), original);

    const unique = await runTool(
      'edit',
      { path: 'a.ts', old: 'const c = 2;', new: 'const c = 4;' },
      context,
    );
    assert.equal(unique.status, 'ok');
    assert.equal(unique.kind, 'edit');
    assert.equal(readFileSync(file, 'utf8'), 'const a = 1;\nconst b = 1;\nconst c = 4;\n');
    assert.deepEqual(unique.diff, {
      path: 'a.ts',
      additions: 1,
      deletions: 1,
      patch: [
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,3 +1,3 @@',
        ' const a = 1;',
        ' const b = 1;',
        '-const c = 2;',
        '+const c = 4;',
        '',
      ].join('\n'),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('search lists a copy that sits in an ignored folder of another repository', async () => {
  const { root, scratch, context } = fixture();
  try {
    execFileSync('git', ['init', '--quiet', root]);
    writeFileSync(join(root, '.gitignore'), 'scratch/\n');
    writeFileSync(join(scratch, 'main.py'), 'import os\n\ndef main():\n    pass\n');
    const found = await runTool('search', { pattern: '^def ' }, context);
    assert.equal(found.output, 'main.py:3: def main():');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tools refuse paths that leave the scratch copy', async () => {
  const { root, scratch, outside, context } = fixture();
  try {
    symlinkSync(outside, join(scratch, 'link'));
    // A link whose target does not exist yet would create the file wherever it points.
    symlinkSync(join(outside, 'later.txt'), join(scratch, 'dangling.txt'));
    // `here` is the copy itself, so the kernel takes `here/..` to the folder above it. Read as
    // text, the same target names a decoy folder inside the copy.
    symlinkSync('.', join(scratch, 'here'));
    symlinkSync('here/../outside', join(scratch, 'escape'));
    mkdirSync(join(scratch, 'outside'));
    writeFileSync(join(scratch, 'outside', 'secret.txt'), 'decoy\n');
    mkdirSync(join(scratch, '.git'));
    writeFileSync(join(scratch, '.git', 'config'), '[core]\n');
    for (const [name, args, reason] of [
      ['read_range', { path: '../outside/secret.txt', start: 1, end: 1 }, /outside the project/],
      [
        'read_range',
        { path: join(outside, 'secret.txt'), start: 1, end: 1 },
        /outside the project/,
      ],
      ['read_range', { path: 'link/secret.txt', start: 1, end: 1 }, /through a link/],
      [
        'read_range',
        { path: join(scratch, '..', 'outside', 'secret.txt'), start: 1, end: 1 },
        /outside the project/,
      ],
      ['write', { path: 'link/new.txt', content: 'x' }, /through a link/],
      ['write', { path: 'dangling.txt', content: 'x' }, /through a link/],
      ['read_range', { path: 'escape/secret.txt', start: 1, end: 1 }, /through a link/],
      ['write', { path: 'escape/new.txt', content: 'x' }, /through a link/],
      ['edit', { path: '.git/config', old: '[core]', new: '[hooks]' }, /inside \.git/],
    ] as const) {
      const outcome = await runTool(name, args, context);
      assert.equal(outcome.status, 'error', `${name} ${args.path}`);
      assert.match(outcome.output, reason);
    }
    assert.equal(existsSync(join(outside, 'new.txt')), false);
    assert.equal(existsSync(join(outside, 'later.txt')), false);
    // A model copies the absolute path it was shown. Inside the copy, it is the same file.
    writeFileSync(join(scratch, 'inside.txt'), 'kept\n');
    const absolute = await runTool(
      'read_range',
      { path: join(scratch, 'inside.txt'), start: 1, end: 1 },
      context,
    );
    assert.equal(absolute.status, 'ok', absolute.output);
    assert.match(absolute.output, /kept/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('thread tools read through the reader, are cut to the Local room and fail without one', async () => {
  const { root, scratch, context } = fixture();
  try {
    const long = 'x'.repeat(5000);
    const seen: unknown[] = [];
    const threads: ThreadReads = {
      turns: (args) => {
        seen.push(args);
        return {
          turns: [
            {
              id: 'trn_01J00000000000000000000001',
              sequence: 1,
              family: 'anthropic',
              model: 'sonnet',
              role: 'assistant',
              status: 'done',
              startedAt: '2026-10-28T00:00:00.000Z',
              endedAt: null,
              reply: 'Renamed n.',
              changedFiles: 2,
            },
          ],
        };
      },
      turn: () => ({
        id: 'trn_01J00000000000000000000001',
        reply: long,
        truncated: false,
        trace: [],
        files: ['a.ts'],
      }),
      diff: () => ({ diff: '--- a/a.ts', more: 'c1' }),
      checks: () => ({ lines: ['lint ok'] }),
      live: () => ({ state: 'none' }),
    };
    const run = (name: string, args: Record<string, unknown>, threadBytes = 4096) =>
      runTool(name, args, { ...context, threads, threadBytes });
    const turns = await run('thread_turns', { since: '0', limit: 5 });
    assert.equal(turns.status, 'ok', turns.output);
    assert.match(turns.output, /#1 trn_01J00000000000000000000001 anthropic sonnet assistant/);
    // Numbers sent as strings reach the reader as numbers, with the schema default applied.
    assert.deepEqual(seen, [{ since: 0, limit: 5 }]);
    const cut = await run('thread_turn', { id: 'trn_01J00000000000000000000001' }, 1024);
    assert.match(cut.output, /\[cut to fit the Local context/);
    assert(Buffer.byteLength(cut.output) <= 1024);
    assert.match((await run('thread_diff', {})).output, /cursor "c1"/);
    assert.match((await run('thread_checks', {})).output, /lint ok/);
    assert.equal((await run('thread_live', {})).output, 'No turn is running.');
    const bad = await run('thread_turn', { id: 'nope' });
    assert.equal(bad.status, 'error');
    const without = await runTool('thread_live', {}, context);
    assert.equal(without.status, 'error');
    assert.match(without.output, /not available/);
    assert.equal(existsSync(scratch), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
