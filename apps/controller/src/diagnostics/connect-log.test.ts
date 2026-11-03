import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectLog, connectLine } from './connect-log.ts';

test('a connect line names the family, the mode and either the time or a reason code only', () => {
  const rows = [
    { line: connectLine('openai', 'auto', { ms: 1234.6 }), want: 'connect openai auto ok ms=1235' },
    {
      line: connectLine('google', 'manual', { reason: 'authentication-required' }),
      want: 'connect google manual failed reason=authentication-required',
    },
    // Provider words or a path never pass as a reason.
    {
      line: connectLine('anthropic', 'auto', { reason: 'Not signed in: /Users/me/.claude' }),
      want: 'connect anthropic auto failed reason=unknown',
    },
    {
      line: connectLine('local', 'auto', { reason: null }),
      want: 'connect local auto failed reason=unknown',
    },
  ];
  for (const row of rows) assert.equal(row.line, row.want);
});

test('each connect writes one line when it connects or fails, and a kept retry fails once then connects', () => {
  let now = 0;
  const lines: string[] = [];
  const log = new ConnectLog(
    () => now,
    (line) => lines.push(line),
  );
  log.ok('openai');
  assert.deepEqual(lines, [], 'nothing is written for a connect that never began');
  log.begin('openai', 'auto');
  now = 40;
  log.ok('openai');
  log.ok('openai');
  log.begin('google', 'manual');
  log.failed('google', 'google-terms-not-acknowledged');
  log.failed('google', 'blocked');
  // Local's launch reconnect tries every few seconds while the runtime is down.
  log.begin('local', 'auto');
  log.failed('local', 'connection-failed', true);
  now = 50;
  log.begin('local', 'auto');
  log.failed('local', 'connection-failed', true);
  now = 90;
  log.ok('local');
  assert.deepEqual(lines, [
    'connect openai auto ok ms=40',
    'connect google manual failed reason=google-terms-not-acknowledged',
    'connect local auto failed reason=connection-failed',
    'connect local auto ok ms=50',
  ]);
});
