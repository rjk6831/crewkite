import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CREWKITE_VERSION } from './version.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const manifests = [
  'package.json',
  ...['apps', 'packages'].flatMap((group) =>
    readdirSync(join(root, group)).map((name) => join(group, name, 'package.json')),
  ),
];

test('every package.json carries the product version the code reports', () => {
  assert.match(CREWKITE_VERSION, /^\d+\.\d+\.\d+$/);
  const found = manifests.flatMap((path) => {
    try {
      return [{ path, version: JSON.parse(readFileSync(join(root, path), 'utf8')).version }];
    } catch {
      return [];
    }
  });
  assert.ok(found.length >= 8);
  assert.deepEqual(
    found.filter((item) => item.version !== CREWKITE_VERSION),
    [],
  );
});
