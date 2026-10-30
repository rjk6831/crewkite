import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OnboardingStore } from './onboarding-store.ts';

test('the welcome flag reads as not finished unless the profile holds a small regular file that says so', () => {
  const rows: [string, (dir: string) => void, boolean][] = [
    ['no file', () => {}, false],
    ['corrupt text', (dir) => writeFileSync(join(dir, 'onboarding.json'), '{nope'), false],
    [
      'oversized file',
      (dir) =>
        writeFileSync(
          join(dir, 'onboarding.json'),
          JSON.stringify({ finished: true, pad: 'x'.repeat(300) }),
        ),
      false,
    ],
    [
      'a link to a finished file',
      (dir) => {
        writeFileSync(join(dir, 'real.json'), '{"finished":true}');
        symlinkSync(join(dir, 'real.json'), join(dir, 'onboarding.json'));
      },
      false,
    ],
    [
      'finished false',
      (dir) => writeFileSync(join(dir, 'onboarding.json'), '{"finished":false}'),
      false,
    ],
    [
      'finished true',
      (dir) => writeFileSync(join(dir, 'onboarding.json'), '{"finished":true}'),
      true,
    ],
  ];
  for (const [name, setup, expected] of rows) {
    const dir = mkdtempSync(join(tmpdir(), 'onboarding-'));
    try {
      setup(dir);
      assert.equal(new OnboardingStore(dir).finished(), expected, name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('the welcome flag round trips and a stale temporary file does not block a write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onboarding-'));
  try {
    const store = new OnboardingStore(dir);
    writeFileSync(join(dir, 'onboarding.json.next'), 'left by a crash');
    store.setFinished(true);
    assert.equal(store.finished(), true);
    store.setFinished(false);
    assert.equal(store.finished(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
