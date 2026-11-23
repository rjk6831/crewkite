import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainFailure } from './ipc-error.ts';

test('an invoke failure reads as the sentence main threw, with no transport text', () => {
  const cases: [unknown, string][] = [
    [
      new Error(
        "Error invoking remote method 'crewkite:command': Error: Another change is still running. Try again when it finishes.",
      ),
      'Another change is still running. Try again when it finishes.',
    ],
    [
      new Error("Error invoking remote method 'crewkite:snapshot': The controller is offline."),
      'The controller is offline.',
    ],
    [new Error('The controller is offline.'), 'The controller is offline.'],
    [
      new Error("Error invoking remote method 'crewkite:command': TypeError: Bad input."),
      'Bad input.',
    ],
    ['boom', 'The request could not be completed.'],
  ];
  for (const [failure, line] of cases) assert.equal(plainFailure(failure).message, line);
});
