import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
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

test('crash capture never changes how the process fails, and a link in place of the crashes folder is refused', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'crewkite-crash-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const capture = pathToFileURL(join(import.meta.dirname, 'crash.ts')).href;
  const throwingGetters =
    "const e = new Error('getter failure'); " +
    "Object.defineProperty(e, 'message', { get() { throw new Error('inner'); } }); " +
    "Object.defineProperty(e, 'stack', { get() { throw new Error('inner'); } }); throw e;";
  const cases = [
    { name: 'error', body: "throw new Error('original failure');", stderr: 'original failure' },
    { name: 'no-prototype', body: 'throw Object.create(null);', stderr: 'null prototype' },
    { name: 'getters', body: throwingGetters, stderr: '' },
    {
      name: 'rejection',
      body: "Promise.reject(new Error('rejected failure'));",
      stderr: 'rejected failure',
    },
  ];
  for (const { name, body, stderr } of cases) {
    const home = join(root, name);
    mkdirSync(home);
    const script = join(root, `${name}.mjs`);
    writeFileSync(
      script,
      `import { installCrashCapture } from ${JSON.stringify(capture)};\ninstallCrashCapture(${JSON.stringify(home)});\n${body}\n`,
    );
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(run.status, 1, `${name}: exit status`);
    assert.ok(run.stderr.includes(stderr), `${name}: stderr`);
    const records = readdirSync(join(home, CRASH_DIRECTORY)).filter((file) =>
      file.endsWith('.json'),
    );
    assert.equal(records.length, 1, `${name}: one record`);
  }

  // A link in place of the folder gets no record and shows no crash.
  const home = join(root, 'linked');
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(home);
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(home, CRASH_DIRECTORY));
  assert.equal(writeCrashRecord(home, { source: 'controller', kind: 'uncaught-exception' }), null);
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.equal(unseenCrash(home), null);
  assert.equal(dismissCrash(home, 'crash-x.json'), false);
});
