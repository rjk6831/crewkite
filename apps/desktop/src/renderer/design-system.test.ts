import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DesignFindingRuleSchema } from '@crewkite/contracts';
import { cssDeclarations, readCssTokens, scan } from '../../../controller/src/design/scan.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const tokenFile = readFileSync(join(root, 'tokens.css'), 'utf8');
const sources = (directory: string, name: RegExp): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(directory, entry.name), name)
      : name.test(entry.name)
        ? [join(directory, entry.name)]
        : [],
  );

// Claim: every dropdown in the desktop app is CrewKite's own Select, so none opens a system popup
// and every one follows the same tokens, keys and focus rules.
test('the desktop app draws no native select', () => {
  const found = sources(root, /\.tsx$/).flatMap((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        /<select[\s>]/.test(line) ? [`${relative(root, path)}:${index + 1}`] : [],
      ),
  );
  assert.deepEqual(found, [], 'use Select from select.tsx');
});

// Claim: a token set for one theme only would keep the other theme's value after a switch, so
// both themes set the same names.
test('the light and dark themes set the same tokens', () => {
  const names = (theme: string) =>
    [...cssDeclarations(tokenFile)]
      .filter(
        ({ selector, property }) =>
          selector.includes(`[data-theme="${theme}"]`) && property.startsWith('--'),
      )
      .map(({ property }) => property)
      .sort();
  assert.notDeepEqual(names('dark'), []);
  assert.deepEqual(names('light'), names('dark'));
});

// Claim: every color, spacing step, radius, shadow and font family in the renderer reads from
// tokens.css. There is no allowance list; a value the check rejects moves into the tokens.
test('the renderer takes every design value from tokens.css', () => {
  const files = sources(root, /^(?!.*\.test\.).*\.(css|tsx)$/)
    .filter((path) => path !== join(root, 'tokens.css'))
    .map((path) => ({ path: relative(root, path), text: readFileSync(path, 'utf8') }));
  assert.ok(files.some((file) => file.path === 'style.css'));
  assert.deepEqual(scan(files, readCssTokens(tokenFile), DesignFindingRuleSchema.options), []);
});
