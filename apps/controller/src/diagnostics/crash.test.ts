import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CRASH_DIRECTORY,
  CRASH_KEEP,
  CRASH_RECORD_BYTES,
  dismissCrash,
  unseenCrash,
  writeCrashRecord,
} from './crash.ts';

test('a crash record stays within its size bound, keeps the newest few and reads as unseen until dismissed', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'crewkite-crash-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let minute = 0;
  const options = {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, minute++)).toISOString(),
    id: () => 'a1b2c3d4',
    userHome: '/home/ann',
  };

  // Multi-byte text passes the character limits, so only the byte bound can hold it.
  const first = writeCrashRecord(
    home,
    {
      source: 'controller',
      kind: 'uncaught-exception',
      message: `${'é'.repeat(9000)} sk-test1234567890`,
      stack: `at /home/ann/app.ts ${'日本'.repeat(9000)}`,
    },
    options,
  );
  assert.ok(first);
  const path = join(home, CRASH_DIRECTORY, first);
  assert.ok(statSync(path).size <= CRASH_RECORD_BYTES);
  const record = JSON.parse(readFileSync(path, 'utf8')) as { message: string; stack: string };
  assert.equal(record.message.includes('sk-test1234567890'), false);
  assert.equal(record.stack.includes('/home/ann'), false);

  for (let count = 0; count < 7; count++)
    writeCrashRecord(
      home,
      { source: 'renderer', kind: 'render-process-gone', detail: `crash ${count}` },
      options,
    );
  const names = readdirSync(join(home, CRASH_DIRECTORY)).filter((name) => name.endsWith('.json'));
  assert.equal(names.length, CRASH_KEEP);
  assert.equal(names.includes(first), false);
  const newest = unseenCrash(home);
  assert.equal(newest?.source, 'renderer');
  assert.equal(newest?.name, [...names].sort().at(-1));

  // Dismissing hides that record. A later crash shows again.
  assert.ok(newest && dismissCrash(home, newest.name));
  assert.equal(unseenCrash(home), null);
  writeCrashRecord(home, { source: 'controller', kind: 'unhandled-rejection' }, options);
  assert.equal(unseenCrash(home)?.kind, 'unhandled-rejection');
  assert.equal(dismissCrash(home, '../escape.json'), false);
});
