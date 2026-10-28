import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMentionTrigger, foldersOf, insertMention, rankMentions } from './mentions.ts';

const files = [
  'src/composer/index.ts',
  'src/composer.ts',
  'src/main.ts',
  'docs/composer notes.md',
  'README.md',
  'a/b/c/deep-composer.ts',
];
const candidates = [
  ...files.map((path) => ({ path, kind: 'file' as const })),
  ...foldersOf(files).map((path) => ({ path, kind: 'folder' as const })),
];

test('mention completion ranks by name match, stays bounded, ignores input order and inserts openable paths', () => {
  const rank = (query: string, limit = 3, from = candidates) =>
    rankMentions(from, query, limit).map(({ path }) => path);
  // Exact and prefix name matches beat deeper or looser ones. Case does not matter.
  assert.deepEqual(rank('README'), ['README.md']);
  assert.deepEqual(rank('COMPOSER').slice(0, 2), ['src/composer', 'src/composer.ts']);
  // A subsequence still finds the file, and a query with no match finds nothing.
  assert.equal(rank('smn', 5)[0], 'src/main.ts');
  assert.deepEqual(rank('zzz'), []);
  // A path with a backtick cannot be one token, so it is never offered.
  assert.deepEqual(rank('odd', 3, [{ path: 'odd`name.ts', kind: 'file' }]), []);
  // An empty query lists the shallowest entries, and the limit bounds every answer.
  assert.deepEqual(rank('', 2), ['a', 'src']);
  assert.equal(rank('', 500, candidates).length <= 50, true);
  assert.deepEqual(rank('x', 0), []);
  // The same candidates in another order rank the same.
  assert.deepEqual(rank('comp', 5, [...candidates].reverse()), rank('comp', 5));

  // The trigger is an at sign at a word start. An email address is not one.
  const typed = 'look at @src/com please';
  const trigger = findMentionTrigger(typed, 'look at @src/com'.length);
  assert.deepEqual(trigger, { start: 8, end: 16, query: 'src/com' });
  assert.equal(findMentionTrigger('mail me@host', 12), null);

  const insert = (path: string, kind: 'file' | 'folder') =>
    insertMention(typed, trigger as NonNullable<typeof trigger>, { path, kind });
  assert.equal(
    insert('src/composer.ts', 'file').text,
    'look at src/composer.ts  please'.replace('  ', ' '),
  );
  assert.equal(insert('src/composer', 'folder').text, 'look at src/composer/ please');
  assert.equal(
    insert('docs/composer notes.md', 'file').text,
    'look at `docs/composer notes.md` please',
  );
  const placed = insert('src/main.ts', 'file');
  assert.equal(placed.text.slice(0, placed.caret), 'look at src/main.ts ');
});
