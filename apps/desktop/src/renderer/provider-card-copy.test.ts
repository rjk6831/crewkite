import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupReasons } from './local-setup-flow.ts';
import { CONNECT_COPY, EXPIRED, LOCAL_NOT_RUNNING } from './settings/providers/connect-copy.ts';
import { LOCAL_UNANSWERED, localResultLine, usageReadLine } from './source.ts';

// Codes the controller and the client use between themselves. A card that prints one tells the
// person nothing they can act on.
const raw = ['response-timeout', 'deadline', 'signature-timeout', 'protocol', 'read-failed'];

test('no provider card line shows a raw reason code', () => {
  const lines: [where: string, line: string][] = [
    ...Object.entries(setupReasons).map(([key, line]): [string, string] => [`setup ${key}`, line]),
    ...Object.entries(EXPIRED).map(([family, line]): [string, string] => [
      `expired ${family}`,
      line,
    ]),
    ['Local not running', LOCAL_NOT_RUNNING],
    ...Object.entries(CONNECT_COPY).map(([key, line]): [string, string] => [
      `connect ${key}`,
      typeof line === 'string' ? line : line('2.1.302'),
    ]),
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
