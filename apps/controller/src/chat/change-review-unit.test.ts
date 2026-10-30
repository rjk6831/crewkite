import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { acceptedTree, blobOid, commentMessage, writeScratchFile } from './change-review.ts';
import { fileHunks, listChanges } from './changes.ts';

const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

function folder(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'change-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a quoted hunk sits in a fence longer than any backtick run it holds', () => {
  const table: [string, string, string][] = [
    ['plain lines take three backticks', 'const a = 1;', '```'],
    ['a line with three backticks takes four', 'const fence = "```";', '````'],
    ['a line with five backticks takes six', 'x = "`````";', '``````'],
  ];
  for (const [claim, line, fence] of table) {
    const old = { content: Buffer.from('keep\nold\n'), mode: '100644' };
    const next = { content: Buffer.from(`keep\n${line}\n`), mode: '100644' };
    const diff = fileHunks('a.ts', old, next);
    assert.ok(diff, claim);
    const text = commentMessage(
      {
        entry: { path: 'a.ts' } as never,
        ops: diff.ops,
        hunks: diff.hunks,
        index: 0,
        listing: {} as never,
      },
      { text: 'Why?' },
    );
    assert.equal(typeof text, 'string', claim);
    const lines = (text as string).split('\n');
    assert.equal(lines[2], `${fence}diff`, claim);
    assert.equal(lines.at(-3), fence, claim);
  }
});

test('a hunk write refuses a folder the copy turned into a link', (t) => {
  const root = folder(t);
  const scratch = join(root, 'scratch');
  const outside = join(root, 'outside');
  mkdirSync(scratch);
  mkdirSync(outside);
  writeFileSync(join(outside, 'a.txt'), 'outside\n');
  symlinkSync(outside, join(scratch, 'src'));
  const expected = { path: 'src/a.txt', mode: '100644' as const, oid: '', bytes: 8 };
  assert.throws(() => writeScratchFile(scratch, 'src/a.txt', Buffer.from('x\n'), expected));
  assert.equal(readFileSync(join(outside, 'a.txt'), 'utf8'), 'outside\n');
});

test('accept refuses a file whose bytes changed after the listing hashed it', (t) => {
  const root = folder(t);
  const repository = join(root, 'repository');
  const scratch = join(root, 'scratch');
  const numbered = Array.from({ length: 20 }, (_, index) => `line ${index + 1}\n`).join('');
  mkdirSync(repository);
  git(repository, 'init', '-q');
  writeFileSync(join(repository, 'a.txt'), numbered);
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'fixture');
  const base = git(repository, 'rev-parse', 'HEAD');
  mkdirSync(scratch);
  const copy = numbered.replace('line 2\n', 'two\n').replace('line 18\n', 'eighteen\n');
  writeFileSync(join(scratch, 'a.txt'), copy);
  const listing = listChanges(repository, scratch, base);
  const entry = listing.entries[0];
  const diff = fileHunks(
    'a.txt',
    { content: Buffer.from(numbered), mode: '100644' },
    {
      content: Buffer.from(copy),
      mode: '100644',
    },
  );
  const decisions = new Map([['a.txt', new Set([diff?.hunks[0].key ?? ''])]]);
  assert.equal(entry.next?.oid, blobOid(Buffer.from(copy), false));
  const kept = acceptedTree(repository, scratch, listing, decisions);
  assert.deepEqual(kept.partial, [{ path: 'a.txt', accepted: 1, hunks: 2 }]);
  writeFileSync(join(scratch, 'a.txt'), copy.replace('eighteen', 'changed'));
  assert.throws(
    () => acceptedTree(repository, scratch, listing, decisions),
    /A scratch file changed while it was read\./,
  );
});
