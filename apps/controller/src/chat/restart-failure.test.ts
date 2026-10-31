import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatFailure } from './adapter.ts';
import { failedByRestart, restartFailure } from './restart-failure.ts';

test('only the failures startup recovery writes read back as failed by a restart', () => {
  const open = 'The turn did not finish before the controller restarted.';
  const rows = [
    { name: 'open turn', failure: restartFailure(0, ''), expected: true },
    { name: 'one process left', failure: restartFailure(1, 'group 4242'), expected: true },
    {
      name: 'several processes left',
      failure: restartFailure(2, 'groups 4242, 4243'),
      expected: true,
    },
    { name: 'no failure', failure: null, expected: false },
    {
      name: 'client failure with its own text',
      failure: chatFailure({ stage: 'stream', kind: 'client-exit', message: 'The client exited.' }),
      expected: false,
    },
    {
      name: 'same text with the client output in detail',
      failure: {
        ...chatFailure({ stage: 'stream', kind: 'internal', message: open }),
        detail: 'stderr',
      },
      expected: false,
    },
    {
      name: 'same text with a provider message',
      failure: chatFailure({
        stage: 'stream',
        kind: 'internal',
        message: open,
        providerMessage: 'boom',
      }),
      expected: false,
    },
    {
      name: 'same text with a protocol method',
      failure: chatFailure({ stage: 'stream', kind: 'internal', message: open, method: 'turn' }),
      expected: false,
    },
    {
      name: 'same text at another stage',
      failure: chatFailure({ stage: 'launch', kind: 'internal', message: open }),
      expected: false,
    },
    {
      name: 'process failure of a live turn',
      failure: chatFailure({
        stage: 'finish',
        kind: 'internal',
        message: 'The provider process (group 4242) did not exit.',
      }),
      expected: false,
    },
    {
      name: 'usage limit',
      failure: chatFailure({ stage: 'stream', kind: 'usage-limit', message: open }),
      expected: false,
    },
  ];
  for (const row of rows) assert.equal(failedByRestart(row.failure), row.expected, row.name);
});
