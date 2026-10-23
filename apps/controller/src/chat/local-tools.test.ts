import assert from 'node:assert/strict';
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

test('tools refuse paths that leave the scratch copy', async () => {
  const { root, scratch, outside, context } = fixture();
  try {
    symlinkSync(outside, join(scratch, 'link'));
    // A link whose target does not exist yet would create the file wherever it points.
    symlinkSync(join(outside, 'later.txt'), join(scratch, 'dangling.txt'));
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
      ['write', { path: 'link/new.txt', content: 'x' }, /through a link/],
      ['write', { path: 'dangling.txt', content: 'x' }, /through a link/],
      ['edit', { path: '.git/config', old: '[core]', new: '[hooks]' }, /inside \.git/],
    ] as const) {
      const outcome = await runTool(name, args, context);
      assert.equal(outcome.status, 'error', `${name} ${args.path}`);
      assert.match(outcome.output, reason);
    }
    assert.equal(existsSync(join(outside, 'new.txt')), false);
    assert.equal(existsSync(join(outside, 'later.txt')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
