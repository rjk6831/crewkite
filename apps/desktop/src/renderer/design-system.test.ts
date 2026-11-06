import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(directory, entry.name))
      : entry.name.endsWith('.tsx')
        ? [join(directory, entry.name)]
        : [],
  );

// Claim: every dropdown in the desktop app is CrewKite's own Select, so none opens a system popup
// and every one follows the same tokens, keys and focus rules.
test('the desktop app draws no native select', () => {
  const found = sources(root).flatMap((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        /<select[\s>]/.test(line) ? [`${relative(root, path)}:${index + 1}`] : [],
      ),
  );
  assert.deepEqual(found, [], 'use Select from select.tsx');
});
