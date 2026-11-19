import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type DesignSystem, TokenGroupSchema } from '@crewkite/contracts';
import { importDraft } from './import.ts';

/** Each token as `group.name:type`, then each rule with its do and don't counts. */
const contents = (system: DesignSystem) => [
  ...TokenGroupSchema.options.flatMap((group) =>
    Object.entries(system.tokens[group]).map(([name, token]) => `${group}.${name}:${token.$type}`),
  ),
  ...system.rules.map((rule) => `rule:${rule.id} ${rule.do.length}/${rule.dont.length}`),
];

test('an import maps each source to tokens and rules, counts what it skipped and runs no config code', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-import-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = JSON.stringify(join(directory, 'ran'));
  const existing: DesignSystem = {
    schema: 1,
    tokens: {
      color: { accent: { $type: 'color', $value: '#2f6feb' } },
      type: {},
      spacing: {},
      radius: {},
      shadow: {},
      motion: { fast: { $type: 'duration', $value: { value: 120, unit: 'ms' } } },
    },
    components: [],
    rules: [],
  };
  const cases: [Parameters<typeof importDraft>[0], string, string[], number][] = [
    [
      'css-variables',
      // An alias, a size no group holds and the dark theme's second accent are skipped.
      `:root { --color-accent: #2f6feb; --space-4: 1rem; --radius-md: 6px;
        --font-sans: Inter, sans-serif; --duration-fast: 120ms; --link: var(--color-accent);
        --sidebar-width: 280px; }
       [data-theme='dark'] { --color-accent: #58a6ff; }`,
      [
        'color.accent:color',
        'type.font-sans:fontFamily',
        'spacing.4:dimension',
        'radius.md:dimension',
        'motion.duration-fast:duration',
      ],
      3,
    ],
    [
      'tailwind-config',
      // Run as code, this would leave a marker file. The call and the spread are skipped.
      `const fs = require('node:fs');
       fs.writeFileSync(${marker}, 'top');
       module.exports = {
         theme: {
           colors: {
             blue: { 500: '#3b82f6' },
             brand: (() => { require('node:fs').writeFileSync(${marker}, 'value'); return '#000'; })(),
           },
           extend: { borderRadius: { lg: '0.5rem' }, ...shared },
         },
       };`,
      ['color.blue-500:color', 'radius.lg:dimension'],
      2,
    ],
    [
      'tokens-json',
      // An alias and a typography composite have no place in the contract.
      JSON.stringify({
        color: { $type: 'color', brand: { $value: '#0055ff' }, link: { $value: '{color.brand}' } },
        spacing: { 4: { $type: 'dimension', $value: { value: 16, unit: 'px' } } },
        font: { heading: { $type: 'typography', $value: {} } },
      }),
      ['color.brand:color', 'spacing.4:dimension'],
      2,
    ],
    [
      'design-md',
      `# Buttons\n\nOne primary action per view.\n\n- Use one primary button\n- Don't stack two primary buttons\n- Avoid icons without labels\n`,
      ['rule:buttons 1/2'],
      0,
    ],
    ['design-system', JSON.stringify(existing), ['color.accent:color', 'motion.fast:duration'], 0],
  ];
  for (const [source, text, expected, skipped] of cases) {
    const draft = importDraft(source, text, 'file');
    assert(!('refused' in draft), source);
    assert.deepEqual(contents(draft.system), expected, source);
    assert.equal(draft.skipped, skipped, source);
  }
  assert.equal(existsSync(join(directory, 'ran')), false);
});

// Claim: only a custom property declared inside a rule becomes a token. A selector that holds two
// dashes, as a BEM modifier does, is a selector.
test('a BEM modifier in a selector is not read as a custom property', () => {
  const draft = importDraft(
    'css-variables',
    `.nav--font-main:first-child { color: red; }
     .card--space-4 > .title { margin: 0; }
     :root { --space-4: 1rem; --font-sans: Inter, sans-serif; }`,
    'file',
  );
  assert(!('refused' in draft));
  assert.deepEqual(contents(draft.system), ['type.font-sans:fontFamily', 'spacing.4:dimension']);
});
