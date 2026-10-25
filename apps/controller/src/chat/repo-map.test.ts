import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildRepoMap, cachedRepoMap } from './repo-map.ts';

const sources: Record<string, string> = {
  'README.md': '# Fixture\n',
  'src/cli.ts': "import { add } from './util.js';\nexport class Cli {\n}\n",
  'src/main.ts': "import { add } from './util.ts';\nexport const main = () => add(1, 2);\n",
  'src/util.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
};
const input = {
  base: 'a'.repeat(40),
  files: Object.keys(sources).map((path) => ({ path, bytes: sources[path].length })),
  read: (path: string) => sources[path],
  budgetTokens: 1500,
};

test('the repo map ranks an imported file above its importers and keeps to its budget', () => {
  assert.equal(
    buildRepoMap(input).text,
    [
      'src/util.ts',
      '  function add(a: number, b: number): number',
      'README.md',
      'src/cli.ts',
      '  class Cli',
      'src/main.ts',
      '  const main = () => add(1, 2)',
      '',
    ].join('\n'),
  );

  const small = buildRepoMap({ ...input, budgetTokens: 30 });
  assert.ok(small.tokens <= 30);
  assert.ok(small.text.startsWith('src/util.ts\n  function add('));
  assert.ok(small.omitted > 0);
  assert.ok(
    small.text.endsWith(`(${small.omitted} more files not shown. Use search to find them.)\n`),
  );

  // The outline is cached per base, so a second call reads nothing from the tree.
  const directory = mkdtempSync(join(tmpdir(), 'repo-map-'));
  try {
    const first = cachedRepoMap(directory, input);
    let reads = 0;
    const again = cachedRepoMap(directory, {
      ...input,
      read: (path) => {
        reads++;
        return sources[path];
      },
    });
    assert.equal(reads, 0);
    assert.equal(again.text, first.text);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
