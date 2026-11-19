import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { sweepGoogleUsageDirectories } from './google-usage-sweep.ts';

function home(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'crewkite-sweep-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('the sweep removes only folders shaped like usage reads make them', (t) => {
  const root = home(t);
  const gone = ['google-usage-Ab3dE9', 'google-usage-tmp-Zy8x7W'];
  for (const name of gone) {
    mkdirSync(join(root, name), { mode: 0o700 });
    writeFileSync(join(root, name, 'log'), 'x');
  }
  const outside = mkdtempSync(join(tmpdir(), 'crewkite-sweep-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(root, 'google-usage-Link12'));
  mkdirSync(join(root, 'google-usage-Open12'), { mode: 0o755 });
  writeFileSync(join(root, 'google-usage-File12'), '');
  mkdirSync(join(root, 'google-acp-setup-Ab3dE9'), { mode: 0o700 });
  mkdirSync(join(root, 'google-usage-notmade'), { mode: 0o700 });
  mkdirSync(join(root, 'native'), { mode: 0o700 });

  const result = sweepGoogleUsageDirectories(root, () => true);

  assert.deepEqual(result, { removed: 2, failed: 3 });
  for (const name of gone) assert.equal(existsSync(join(root, name)), false);
  for (const name of [
    'google-usage-Link12',
    'google-usage-Open12',
    'google-usage-File12',
    'google-acp-setup-Ab3dE9',
    'google-usage-notmade',
    'native',
  ])
    assert.equal(existsSync(join(root, name)), true, name);
  assert.equal(existsSync(outside), true, 'a link is never followed');
});

test('the sweep removes nothing once a Google operation is not settled and stops between batches', (t) => {
  const root = home(t);
  const names = ['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd', 'eeeeee'].map((s) => `google-usage-${s}`);
  for (const name of names) mkdirSync(join(root, name), { mode: 0o700 });

  assert.deepEqual(
    sweepGoogleUsageDirectories(root, () => false),
    { removed: 0, failed: 0 },
  );

  // The gate answers true for the first batch of two, then a read begins.
  let asked = 0;
  const result = sweepGoogleUsageDirectories(root, () => ++asked <= 2, 2);
  assert.deepEqual(result, { removed: 2, failed: 0 });
  assert.equal(names.filter((name) => existsSync(join(root, name))).length, 3);
});
