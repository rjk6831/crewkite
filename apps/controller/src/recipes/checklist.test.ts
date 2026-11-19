import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { installedTools } from '../store/controller-fixture.ts';
import { checklistRequest, nextChecklistItem } from './checklist.ts';

const PATH = process.env.PATH;

/** A temp folder with PATH narrowed to git, so nothing else is ever found. */
function folder(t: TestContext) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'ck-checklist-'));
  process.env.PATH = PATH;
  process.env.PATH = installedTools(directory, 'git');
  t.after(() => {
    process.env.PATH = PATH;
    rmSync(directory, { recursive: true, force: true });
  });
  const root = join(directory, 'project');
  mkdirSync(root);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    });
  git('init', '-q');
  return { root, git };
}

const none = new Set<string>();

test('a checklist gives its first unchecked item that no run holds', (t) => {
  const { root, git } = folder(t);
  const long = 'x'.repeat(600);
  const rows: { name: string; file: string; taken?: string[]; want: unknown }[] = [
    { name: 'plain', file: '- [ ] one\n- [ ] two\n', want: { kind: 'item', text: 'one' } },
    {
      name: 'nested and other markers',
      file: '- [x] a\n    * [ ] deep\n',
      want: { kind: 'item', text: 'deep' },
    },
    {
      name: 'numbered',
      file: '1) [ ] first\n2. [ ] second\n',
      want: { kind: 'item', text: 'first' },
    },
    {
      name: 'checked first',
      file: '- [X] a\n- [x] b\n+ [ ] c\n',
      want: { kind: 'item', text: 'c' },
    },
    {
      name: 'fenced lines are no item',
      file: '```md\n- [ ] in fence\n```\n~~~~\n- [ ] tilde\n~~~~\n- [ ] after\n',
      want: { kind: 'item', text: 'after' },
    },
    {
      name: 'commented-out items are no item',
      file: '<!--\n- [ ] commented out\n-->\n<!-- - [ ] on one line -->\n- [ ] after\n',
      want: { kind: 'item', text: 'after' },
    },
    {
      name: 'an item with a trailing comment',
      file: '- [ ] keep this <!-- why it waits -->\n- [ ] next\n',
      want: { kind: 'item', text: 'keep this' },
    },
    {
      name: 'a comment that opens and closes on one line before an item',
      file: '<!-- a note -->\n- [ ] after the note\n',
      want: { kind: 'item', text: 'after the note' },
    },
    {
      name: 'a commented-out item on one line',
      file: '<!-- - [ ] old -->\n- [ ] new\n',
      want: { kind: 'item', text: 'new' },
    },
    {
      name: 'a comment in the middle of an item',
      file: '- [ ] fix <!-- see #12 --> the login bug\n',
      want: { kind: 'item', text: 'fix the login bug' },
    },
    {
      name: 'an item that starts with a comment',
      file: '- [ ] <!-- p1 --> fix the build\n',
      want: { kind: 'item', text: 'fix the build' },
    },
    {
      name: 'an item that is only a comment',
      file: '- [ ] <!-- nothing here -->\n- [ ] after\n',
      want: { kind: 'item', text: 'after' },
    },
    {
      name: 'a comment opened right after a list marker hides the lines to its close',
      file: '- <!-- parked\n  - [ ] hidden child\n  -->\n- [ ] after\n',
      want: { kind: 'item', text: 'after' },
    },
    {
      name: 'an indented comment opener hides the lines to its close',
      file: '  <!--\n- [ ] hidden\n-->\n- [ ] after\n',
      want: { kind: 'item', text: 'after' },
    },
    {
      // The next list item ends the paragraph, so an opener after text is text and hides nothing.
      name: 'a comment opened after text hides no later item',
      file: 'Backlog <!--\n- [ ] later item\n-->\n- [ ] after\n',
      want: { kind: 'item', text: 'later item' },
    },
    {
      name: 'an opener after a checked item does not make the list read done',
      file: '- [x] first <!-- note\n- [ ] second -->\n',
      want: { kind: 'item', text: 'second -->' },
    },
    {
      name: 'a marker with no space before an opener is a paragraph and hides nothing',
      file: '-<!--\n- [ ] after\n-->\n',
      want: { kind: 'item', text: 'after' },
    },
    {
      name: 'a comment marker inside a code span is text',
      file: '- [ ] escape `<!--` in titles\n- [ ] next\n',
      want: { kind: 'item', text: 'escape `<!--` in titles' },
    },
    {
      name: 'a closed comment inside a code span stays in the item',
      file: '- [ ] replace `<!--more-->` with the tag\n',
      want: { kind: 'item', text: 'replace `<!--more-->` with the tag' },
    },
    {
      name: 'a comment that holds a backtick still closes',
      file: '- [ ] fix <!-- see `#12` --> the login bug\n',
      want: { kind: 'item', text: 'fix the login bug' },
    },
    {
      name: 'an item followed by a comment that stays open',
      file: '- [ ] first <!-- still open\n- [ ] hidden\n-->\n',
      want: { kind: 'item', text: 'first' },
    },
    {
      name: 'two comments on one line around an item',
      file: '<!-- a --> - [ ] x <!-- b -->\n- [ ] after\n',
      want: { kind: 'item', text: 'x' },
    },
    {
      name: 'a comment opener inside a fence',
      file: '```\n<!--\n```\n- [ ] after\n',
      want: { kind: 'item', text: 'after' },
    },
    {
      name: 'a fence inside a comment',
      file: '<!--\n```\n-->\n- [ ] after\n',
      want: { kind: 'item', text: 'after' },
    },
    {
      name: 'a comment opened at the start of a line after an item',
      file: '- [ ] first\n<!-- hidden\n- [ ] hidden two\n-->\n',
      taken: ['first'],
      want: { kind: 'held' },
    },
    {
      name: 'a fence opened on a list item',
      file: '- ```md\n  - [ ] example in code\n  ```\n- [ ] after\n',
      want: { kind: 'item', text: 'after' },
    },
    {
      name: 'format characters go, and an item of nothing else is skipped',
      file: '- [ ] \u200b\u2060\n- [ ] \u202eab\u200dc\ufeff\n',
      want: { kind: 'item', text: 'abc' },
    },
    {
      name: 'a cut never splits a surrogate pair',
      file: `- [ ] ${'x'.repeat(499)}\u{1F600}tail\n`,
      want: { kind: 'item', text: 'x'.repeat(499) },
    },
    {
      name: 'empty box',
      file: '- [ ]\n- [ ]   \n- [ ] real\n',
      want: { kind: 'item', text: 'real' },
    },
    {
      name: 'long item is cut',
      file: `- [ ] ${long}\n`,
      want: { kind: 'item', text: long.slice(0, 500) },
    },
    {
      name: 'control characters',
      file: '- [ ] a\u0007b\t\tc   d\u2028e\n',
      want: { kind: 'item', text: 'a b c d e' },
    },
    {
      name: 'duplicates are one item',
      file: '- [ ] same\n- [ ] same\n',
      taken: ['same'],
      want: { kind: 'held' },
    },
    {
      name: 'a taken item is passed over',
      file: '- [ ] a\n- [ ] b\n',
      taken: ['a'],
      want: { kind: 'item', text: 'b' },
    },
    {
      name: 'every item taken',
      file: '- [ ] a\n- [ ] b\n',
      taken: ['a', 'b'],
      want: { kind: 'held' },
    },
    { name: 'none unchecked', file: '- [x] a\ntext\n- [ ]\n', want: { kind: 'done' } },
  ];
  for (const row of rows) {
    writeFileSync(join(root, 'list.md'), row.file);
    git('add', 'list.md');
    git('commit', '-q', '--allow-empty', '-m', row.name);
    assert.deepEqual(nextChecklistItem(root, 'list.md', new Set(row.taken)), row.want, row.name);
  }
  writeFileSync(join(root, 'list.md'), '- [ ] edited on disk\n');
  assert.deepEqual(
    nextChecklistItem(root, 'list.md', none),
    { kind: 'done' },
    'HEAD wins over the working file',
  );
  assert.equal(
    checklistRequest('docs/todo.md', 'Add a test'),
    'Do this item from docs/todo.md:\n\nAdd a test\n\nTick it in docs/todo.md as part of the change.',
  );
});

test('a checklist that cannot be read says so', (t) => {
  const { root, git } = folder(t);
  const unreadable = { kind: 'unreadable' };
  assert.deepEqual(nextChecklistItem(root, 'list.md', none), unreadable, 'no commit');
  writeFileSync(join(root, 'big.md'), `- [ ] ${'a'.repeat(256 * 1024)}\n`);
  writeFileSync(join(root, 'latin.md'), Buffer.from([0x2d, 0x20, 0x5b, 0x20, 0x5d, 0x20, 0xe9]));
  writeFileSync(join(root, 'nul.md'), '- [ ] a\0b\n');
  writeFileSync(join(root, 'ok.md'), '- [ ] fine\n');
  // Each of these may hide items below a block that never closes.
  writeFileSync(join(root, 'open-fence.md'), '```\n- [ ] hidden\n');
  writeFileSync(join(root, 'open-in-item.md'), '- [x] one\n  ```\n  code\n- [ ] two\n');
  writeFileSync(join(root, 'open-comment.md'), '<!--\n- [ ] hidden\n');
  writeFileSync(join(root, 'open-after-marker.md'), '- <!-- parked\n- [ ] hidden\n');
  writeFileSync(join(root, 'tick-info.md'), '``` a`b\n- [ ] hidden\n');
  writeFileSync(join(root, 'exact.md'), 'a'.repeat(256 * 1024));
  writeFileSync(join(root, 'over.md'), 'a'.repeat(256 * 1024 + 1));
  writeFileSync(join(root, 'TODO.md'), '- [ ] upper\n');
  mkdirSync(join(root, 'inner'));
  writeFileSync(join(root, 'inner', 'list.md'), '- [ ] from the enclosing repository\n');
  mkdirSync(join(root, 'dir'));
  writeFileSync(join(root, 'dir', 'inner.md'), '- [ ] inner\n');
  symlinkSync('ok.md', join(root, 'link.md'));
  git('add', '.');
  git('commit', '-q', '-m', 'files');
  writeFileSync(join(root, 'untracked.md'), '- [ ] never committed\n');
  for (const path of [
    'missing.md',
    'untracked.md',
    'link.md',
    'big.md',
    'latin.md',
    'nul.md',
    'dir',
    'open-fence.md',
    'open-in-item.md',
    'open-comment.md',
    'open-after-marker.md',
    'tick-info.md',
    'over.md',
    'todo.md',
    // Git lists what a folder holds for a path that ends in a slash, which is not the path asked.
    'dir/',
  ]) {
    assert.deepEqual(nextChecklistItem(root, path, none), unreadable, path);
  }
  assert.deepEqual(nextChecklistItem(root, 'ok.md', none), { kind: 'item', text: 'fine' });
  assert.deepEqual(nextChecklistItem(root, 'exact.md', none), { kind: 'done' }, '256 KiB');
  assert.deepEqual(
    nextChecklistItem(join(root, 'inner'), 'list.md', none),
    unreadable,
    'a folder inside another repository',
  );
});
