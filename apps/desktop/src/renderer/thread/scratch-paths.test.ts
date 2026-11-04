import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectRelative } from './scratch-paths.ts';

// Claim: a reply shows paths from the project root, in text and in links, for the thread copy
// for a copy named after the project and for a slice's copy (H5).
test('the scratch copy prefix comes off the paths a reply quotes', () => {
  const home = '/Users/me/Projects/crewkite/internal/packages/d0/d3-rc5/state/home';
  const rows: [string, string][] = [
    [
      `The total rounds here (${home}/chat/tsk_01ABC/slices/2/copy/src/money.js:6).`,
      'The total rounds here (src/money.js:6).',
    ],
    [
      `See [money.js](${home}/chat/tsk_01ABC/scratch/src/money.js).`,
      'See [money.js](src/money.js).',
    ],
    [`Link: file://${home}/chat/tsk_01ABC/scratch/README.md`, 'Link: README.md'],
    [`Ran in ${home}/chat/tsk_01ABC/scratch, then stopped.`, 'Ran in ., then stopped.'],
    [
      `See [money.js](${home}/chat/tsk_01ABC/demo-shop/src/money.js).`,
      'See [money.js](src/money.js).',
    ],
    [`Ran in ${home}/chat/tsk_01ABC/demo-shop, then stopped.`, 'Ran in ., then stopped.'],
    [
      `Attached ${home}/chat/tsk_01ABC/files/a1/shot.png`,
      `Attached ${home}/chat/tsk_01ABC/files/a1/shot.png`,
    ],
    // The installed app keeps its home under Application Support, a folder name with a space.
    [
      'Fixed in /Users/me/Library/Application Support/CrewKite/chat/tsk_01ABC/demo-shop/src/cart.js:4.',
      'Fixed in src/cart.js:4.',
    ],
    [
      'Compare /tmp/a and then /Users/me/Library/Application Support/CrewKite/chat/tsk_01ABC/scratch/a.js',
      'Compare /tmp/a and then a.js',
    ],
    ['src/money.js stays as it is.', 'src/money.js stays as it is.'],
    ['/etc/chat/notes stays too.', '/etc/chat/notes stays too.'],
  ];
  for (const [text, want] of rows) assert.equal(projectRelative(text), want, text);
});
