import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeSlash, parseSlash } from '../chat/composer-shared.ts';
import {
  acceptCompletion,
  attachmentPaths,
  backspace,
  emptyComposer,
  insert,
  mentionQuery,
  offerMentions,
  sent,
  vertical,
} from './composer-state.ts';

test('slash commands parse, and the box edits lines, recalls history and completes', () => {
  const parsed: [string, ReturnType<typeof parseSlash>][] = [
    ['/new', { name: 'new', argument: '' }],
    [
      '  /ask  why is the total negative?  ',
      { name: 'ask', argument: 'why is the total negative?' },
    ],
    ['/accept cli/clamp', { name: 'accept', argument: 'cli/clamp' }],
    ['/model fixture-model:high', { name: 'model', argument: 'fixture-model:high' }],
    ['/prompt review area="the parser"', { name: 'prompt', argument: 'review area="the parser"' }],
    ['/unknown thing', null],
    ['/usr/local/bin is on the path', null],
    ['Use /help later', null],
  ];
  for (const [text, expected] of parsed) assert.deepEqual(parseSlash(text), expected, text);
  assert.deepEqual(
    completeSlash('/p').map((command) => command.name),
    ['provider', 'plan', 'push', 'pr', 'prompt'],
  );
  assert.deepEqual(completeSlash('/ask why'), []);

  // Typing a slash offers the list; Tab takes the highlighted entry and leaves room for its argument.
  let box = insert(emptyComposer(), '/ac');
  assert.equal(box.completion?.kind, 'slash');
  box = acceptCompletion(box);
  assert.equal(box.text, '/accept ');

  // Two lines, Up moves to the first line, then Up again recalls history; Down returns the draft.
  box = sent(insert(emptyComposer(), 'first message'));
  box = insert(insert(insert(box, 'line one'), '\n'), 'two');
  box = vertical(box, 'up');
  assert.equal(box.caret, 3);
  box = vertical(box, 'up');
  assert.equal(box.text, 'first message');
  box = vertical(box, 'down');
  assert.equal(box.text, 'line one\ntwo');
  assert.equal(backspace(box).text, 'line one\ntw');

  // A mention completes to the project path; an absolute path after @ becomes an attachment.
  box = insert(emptyComposer(), 'Read @ne');
  assert.equal(mentionQuery(box)?.query, 'ne');
  box = acceptCompletion(offerMentions(box, [{ path: 'src/net.mjs', kind: 'file' }]));
  assert.equal(box.text, 'Read src/net.mjs ');
  assert.deepEqual(attachmentPaths('Look @/tmp/shot.png and @~/notes.txt here', '/home/me'), {
    text: 'Look and here',
    paths: ['/tmp/shot.png', '/home/me/notes.txt'],
  });
  assert.deepEqual(attachmentPaths('email me@example.invalid', '/home/me').paths, []);
});
