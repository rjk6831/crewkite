import assert from 'node:assert/strict';
import { test } from 'node:test';
import { features } from './protocol.ts';

test('each Codex build gets the request fields its release line knows', () => {
  // 0.126 removed the restricted read shape, 0.133 is the first build that reads through a named
  // profile, and the later boundaries come from sign-in-free probes of the published builds. A
  // version CrewKite cannot read gets the current fields and the replies decide.
  const rows = [
    ['0.125.0', false, false, false],
    ['0.126.0', false, false, false],
    ['0.133.0', true, false, false],
    ['0.150.0', true, false, false],
    ['0.151.0', true, true, false],
    ['0.154.0', true, true, true],
    ['codex-cli 0.163.0', true, true, true],
    ['1.0.0', true, true, true],
    [null, true, true, true],
  ] as const;
  for (const [version, readProfile, resumeExcludeTurns, rateLimitsParams] of rows)
    assert.deepEqual(
      features(version),
      { readProfile, resumeExcludeTurns, rateLimitsParams },
      String(version),
    );
});
