import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupReasons } from './local-setup-flow.ts';
import { LOCAL_UNANSWERED, localResultLine, usageReadLine } from './source.ts';

// Codes the controller and the client use between themselves. A card that prints one tells the
// person nothing they can act on.
const raw = ['response-timeout', 'deadline', 'signature-timeout', 'protocol', 'read-failed'];

test('no provider card line shows a raw reason code', () => {
  const lines: [where: string, line: string][] = [
    ...Object.entries(setupReasons).map(([key, line]): [string, string] => [`setup ${key}`, line]),
  ];
  for (const reason of raw) {
    for (const outcome of ['outcome-unknown', 'blocked'])
      lines.push([
        `Local ${outcome} ${reason}`,
        localResultLine({ reason }, 'Local connection was not confirmed.'),
      ]);
    lines.push([`OpenAI read ${reason}`, usageReadLine(reason)]);
  }
  for (const [where, line] of lines)
    for (const reason of raw) assert.equal(line.includes(reason), false, `${where}: ${line}`);
  // A lost answer gets one sentence and one action, whatever the client suggested after it.
  for (const reason of ['response-timeout', 'connection-lost'])
    assert.equal(
      localResultLine(
        { reason, next: 'Read a fresh snapshot and retry the same command key if needed.' },
        'Local connection was not confirmed.',
      ),
      LOCAL_UNANSWERED,
    );
});
