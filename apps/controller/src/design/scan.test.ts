import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DesignFindingRuleSchema,
  DesignFindingSchema,
  DesignSystemSchema,
} from '@crewkite/contracts';
import { readCssTokens, type SourceFile, scan, scanFiles } from './scan.ts';

const tokens = readCssTokens(`
:root {
  --text: #e5e8e7;
  --accent: #d0e7a1;
  --red: #ec9992;
  --blue: oklch(0.75 0.1 250);
  --plum: lab(40 30 -30);
  --space-2: 4px;
  --space-4: 8px;
  --radius-3: 6px;
  --radius-pill: 999px;
  --shadow-overlay: 0 24px 100px #0007;
  --shadow-ring: inset 0 0 0 1px var(--accent);
  --font-ui: Inter, sans-serif;
  --font-code: "JetBrains Mono", monospace;
}
:root[data-theme="light"] {
  --text: #1c241f;
}
`);
// A design system file may hold a family list as one string.
tokens.type.ui = { $type: 'fontFamily', $value: 'Inter, sans-serif' };
// Nine aliases, each reading the next, and the last holds `value`.
const chain = (name: string, value: string) =>
  `${Array.from({ length: 8 }, (_, index) => `--${name}${index}: var(--${name}${index + 1});`).join(' ')} --${name}8: ${value};`;

// Claim: the check reports each color, spacing step, radius, shadow and font family written around
// the tokens, with the token to use, and lets token reads, keywords, zero and fluid geometry pass.
test('the design check flags values that bypass the tokens and names the nearest one', () => {
  DesignSystemSchema.parse({ schema: 1, tokens, components: [], rules: [] });
  // A row may add context files. They are passed after its own file, as the check passes unchanged
  // files after changed ones, and only the row's own findings are compared.
  const cases: [string, string, [number, string, string, string | null][], SourceFile[]?][] = [
    [
      'a.css',
      '.a { color: var(--text); padding: var(--space-2) var(--space-4); border-radius: var(--radius-3); box-shadow: var(--shadow-overlay); font-family: var(--font-ui); }',
      [],
    ],
    [
      'a.css',
      '.a { color: transparent; background: currentColor; outline: 2px solid CanvasText; margin: 0 auto; gap: 0px; box-shadow: none; font: inherit; animation-name: tan; }',
      [],
    ],
    [
      'a.css',
      '.a { margin-top: 8cqi; padding: 0 10%; border-radius: 50%; width: 13px; font-size: 13px; margin: calc(-1 * var(--space-4)); background: color-mix(in srgb, var(--red) 6%, transparent) url(#hatch); content: "#fff"; }',
      [],
    ],
    [
      'a.css',
      '/* color: #fff; padding: 3px */ .a { font-family: "JetBrains Mono", ui-monospace, -apple-system, monospace; font: 600 12px/1.4 Inter, sans-serif; } @font-face { font-family: "Brand Serif"; }',
      [],
    ],
    // A relative color derives from its origin, so only the origin is checked.
    [
      'a.css',
      '.a { color: rgb(from var(--red) r g b / 6%); background: rgb(from #ec9992 r g b / 6%); }',
      [[1, 'raw-color', '#ec9992', 'color.red']],
    ],
    [
      'a.tsx',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the case is TSX source with a template.
      '<i style={{ width: `${percent}%`, background: view.fill, padding: gap }} />',
      [],
    ],
    [
      'a.css',
      '.a { color: #ec9993; border: 1px solid rgb(229 232 231 / 1); background: white; }',
      [
        [1, 'raw-color', '#ec9993', 'color.red'],
        [1, 'raw-color', 'rgb(229 232 231 / 1)', 'color.text'],
        [1, 'raw-color', 'white', 'color.text'],
      ],
    ],
    [
      'a.css',
      '.a { --tone: hsl(80deg 58% 77%); color: var(--missing, #d0e7a2); }',
      [
        [1, 'raw-color', 'hsl(80deg 58% 77%)', 'color.accent'],
        [1, 'raw-color', '#d0e7a2', 'color.accent'],
      ],
    ],
    // oklch(), lab() and hwb() colors find their nearest token, and tokens may be written that way.
    [
      'a.css',
      '.a { color: oklch(0.74 0.1 250); border-color: lab(41 30 -30); background: hwb(5 57% 7%); }',
      [
        [1, 'raw-color', 'oklch(0.74 0.1 250)', 'color.blue'],
        [1, 'raw-color', 'lab(41 30 -30)', 'color.plum'],
        [1, 'raw-color', 'hwb(5 57% 7%)', 'color.red'],
      ],
    ],
    [
      'a.css',
      '.a { padding: 7px 4px; margin-top: -8px; }\n.b { margin-left: 0.25em !important; }',
      [
        [1, 'off-scale-spacing', '7px', 'spacing.4'],
        [1, 'off-scale-spacing', '4px', 'spacing.2'],
        [1, 'off-scale-spacing', '-8px', 'spacing.4'],
        [2, 'off-scale-spacing', '0.25em', 'spacing.2'],
      ],
    ],
    // A local custom property is checked at its own line and again where it is read, and a value
    // halfway between two steps names the larger one.
    [
      'a.css',
      '.a { --gap: 6px; }\n.b { gap: var(--gap); }',
      [
        [1, 'off-scale-spacing', '6px', 'spacing.4'],
        [2, 'off-scale-spacing', '6px', 'spacing.4'],
      ],
    ],
    [
      'a.css',
      '.a { --_gap: 7px; }\n.b { --2x: var(--_gap); }\n.c { padding: var(--2x); }',
      [
        [1, 'off-scale-spacing', '7px', 'spacing.4'],
        [2, 'off-scale-spacing', '7px', 'spacing.4'],
        [3, 'off-scale-spacing', '7px', 'spacing.4'],
      ],
    ],
    // A reader of an alias that copies a token reports nothing, a theme's override reports only
    // where it is written, and a reader still gets the first value no token holds.
    [
      'a.css',
      '.a { --brand: #ec9992; --pad: 8px 7px; --lift: 0 24px 100px #0007; }\n.b { --brand: #ec9993; }\n.c { color: var(--brand); padding: var(--pad); box-shadow: var(--lift); }',
      [
        [1, 'raw-color', '#ec9992', 'color.red'],
        [1, 'off-scale-spacing', '8px', 'spacing.4'],
        [1, 'off-scale-spacing', '7px', 'spacing.4'],
        [1, 'unknown-shadow', '0 24px 100px #0007', 'shadow.overlay'],
        [1, 'raw-color', '#0007', 'color.plum'],
        [2, 'raw-color', '#ec9993', 'color.red'],
        [3, 'off-scale-spacing', '7px', 'spacing.4'],
      ],
    ],
    // Readers follow the plain :root declaration outside at-rules, or else the first by path, so
    // a declaration passed first cannot stand in for them.
    [
      'b.css',
      '.compact { --gap: var(--space-4); --pad: var(--space-4); }\n.b { gap: var(--gap); }\n.c { padding: var(--pad); }',
      [
        [2, 'off-scale-spacing', '7px', 'spacing.4'],
        [3, 'off-scale-spacing', '9px', 'spacing.4'],
      ],
      [
        {
          path: 'a.css',
          text: '@media print { :root { --gap: var(--space-4); } }\n.a { --pad: 9px; }',
        },
        { path: 'c.css', text: ':root { --gap: 7px; }' },
      ],
    ],
    // Past 8 steps a reader reports the var() it holds, once, under its property's own rule.
    [
      'a.css',
      `.b { gap: var(--s0); color: var(--c0); }\n.a { ${chain('s', '7px')} }\n.c { ${chain('c', '#ec9993')} }`,
      [
        [1, 'off-scale-spacing', 'var(--s0)', null],
        [1, 'raw-color', 'var(--c0)', null],
        [3, 'raw-color', '#ec9993', 'color.red'],
      ],
    ],
    [
      'a.css',
      '.a { border-top-left-radius: 7px; }\n.b { border-radius: 999px; }',
      [
        [1, 'off-scale-radius', '7px', 'radius.3'],
        [2, 'off-scale-radius', '999px', 'radius.pill'],
      ],
    ],
    [
      'a.css',
      '.a { font-family: "Fira Code", monospace; }\n.b { font: 600 13px/1.4 Helvetica, sans-serif; }',
      [
        [1, 'unknown-font', 'Fira Code', 'type.code'],
        [2, 'unknown-font', 'Helvetica', 'type.ui'],
      ],
    ],
    // The shorthand's family follows the size and line height, whatever comes before them.
    [
      'a.css',
      '.a { font: 600 var(--size)/1.4 Helvetica; }\n.b { font: oblique 10deg 12px Inter; font: 12px/normal Inter; font: caption; }',
      [[1, 'unknown-font', 'Helvetica', 'type.ui']],
    ],
    // A found value fits the contract as one well-formed line, and a cut keeps pairs whole.
    [
      'a.css',
      `.a { font-family: "Tab\u0007Name", "", "\uD800"; }\n.b { font-family: "${'x'.repeat(199)}\u{1F600}"; }`,
      [
        [1, 'unknown-font', 'Tab Name', 'type.ui'],
        [1, 'unknown-font', '�', 'type.ui'],
        [2, 'unknown-font', 'x'.repeat(199), 'type.ui'],
      ],
    ],
    [
      'a.css',
      '.a { box-shadow: inset 0 0 0 2px var(--accent), var(--shadow-overlay); }\n.b { box-shadow: 0 20px 90px var(--text); }',
      [
        [1, 'unknown-shadow', 'inset 0 0 0 2px var(--accent)', 'shadow.ring'],
        [2, 'unknown-shadow', '0 20px 90px var(--text)', 'shadow.overlay'],
      ],
    ],
    [
      'a.tsx',
      "<p\n  style={{ margin: 0, padding: 6, color: '#ec9992', fontFamily: 'Comic Sans MS' }}\n/>",
      [
        [2, 'off-scale-spacing', '6px', 'spacing.4'],
        [2, 'raw-color', '#ec9992', 'color.red'],
        [2, 'unknown-font', 'Comic Sans MS', 'type.ui'],
      ],
    ],
    // A comment beside an entry hides nothing.
    [
      'a.tsx',
      '<p style={{ margin: 0, // reset\n  padding: 7 /* odd */, gap: /* step */ 6 }} />',
      [
        [2, 'off-scale-spacing', '7px', 'spacing.4'],
        [2, 'off-scale-spacing', '6px', 'spacing.4'],
      ],
    ],
    // An attribute in a comment or string, or one that never closes, is not read. Spaces around =
    // still make an attribute.
    [
      'a.tsx',
      "// <i style={{ padding: 7 }} />\nconst note = '<i style={{ padding: 7 }} />';\n<p>Don't <b style = {{ padding: 6 }} /></p>\n<i style={ />\nconst plain = { padding: 9 };",
      [[3, 'off-scale-spacing', '6px', 'spacing.4']],
    ],
    // A backtick or comment opener that never closes is text, so it hides nothing after it.
    [
      'a.tsx',
      '<p>Press ` to search</p>\n<i style={{ padding: 7 }} />\n<p>Globs like src/* match</p>\n<b style={{ margin: 6 }} />',
      [
        [2, 'off-scale-spacing', '7px', 'spacing.4'],
        [4, 'off-scale-spacing', '6px', 'spacing.4'],
      ],
    ],
  ];
  for (const [file, text, expected, context = []] of cases)
    assert.deepEqual(
      scan([{ path: file, text }, ...context], tokens, DesignFindingRuleSchema.options).filter(
        (finding) => finding.file === file,
      ),
      expected.map(([line, rule, found, nearestToken]) => ({
        file,
        line,
        rule,
        found,
        nearestToken,
      })),
      text,
    );
});

// Claim: a hostile project file cannot hang or crash the check. Each scan finishes, a file nested
// past the limit or too costly to read is skipped and named, and every finding still fits the
// contract.
test('the design check stays bounded on hostile files', () => {
  const families = Array.from({ length: 5000 }, (_, index) => `F${index}`).join(', ');
  const aliases = Array.from(
    { length: 20_000 },
    (_, index) => `.a${index} { --a${index}: var(--a${index + 1}); }`,
  ).join('\n');
  const digits = '1'.repeat(100_000);
  const cases: [string, string, number, boolean][] = [
    ['a.css', `.a { font-family: ${families}; }`, 5000, false],
    ['a.css', `.a { padding: ${digits}x!; }`, 0, false],
    ['a.tsx', `<i style={{ padding: ${digits}x }} />`, 0, false],
    ['a.css', '@media{a:b;'.repeat(30_000), 0, true],
    ['a.css', `.a { color: ${'f('.repeat(10_000)}${')'.repeat(10_000)}; }`, 0, true],
    ['a.tsx', `<i style={{ a: \`${'${`'.repeat(10_000)}\` }} />`, 0, true],
    // Each unclosed attribute, and each template that never closes, reads on to the end.
    ['a.tsx', '<i style={ />'.repeat(5000), 0, true],
    ['a.tsx', `<p>${'\\`'.repeat(50_000)}</p>`, 0, true],
    ['a.css', `${aliases}\n.z { --a20000: 7px; gap: var(--a0); }`, 1, false],
    ['a.css', `.a { color: red; } /* never closed ${'x'.repeat(100_000)}`, 1, false],
  ];
  for (const [file, text, count, skip] of cases) {
    const label = text.slice(0, 40);
    const { findings, skipped } = scanFiles(
      [{ path: file, text }],
      tokens,
      DesignFindingRuleSchema.options,
    );
    assert.deepEqual(skipped, skip ? [file] : [], label);
    assert.equal(findings.length, count, label);
    for (const finding of findings)
      DesignFindingSchema.parse({
        ...finding,
        id: `dsf_${'0'.repeat(26)}`,
        taskId: `tsk_${'0'.repeat(26)}`,
        state: 'open',
        reason: null,
        versionHash: 'a'.repeat(64),
      });
  }
});
