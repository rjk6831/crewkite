import type { DesignSystem, DesignSystemDraft, Token, TokenGroup } from '@crewkite/contracts';
import { type ColorCheck, EMPTY_SYSTEM, parseValue } from './model.ts';

// The three ways to start a design system that need no saved version: import a project file, take
// a template, or describe it. Templates are built here, so they never pass through a draft source.

type Source = DesignSystemDraft['source'];
export type ImportSource = Exclude<Source, 'description'>;

export const IMPORT_SOURCES: readonly { id: ImportSource; label: string; example: string }[] = [
  { id: 'css-variables', label: 'CSS custom properties', example: 'src/styles/tokens.css' },
  { id: 'tailwind-config', label: 'Tailwind config', example: 'tailwind.config.js' },
  { id: 'tokens-json', label: 'Tokens JSON', example: 'tokens.json' },
  { id: 'design-md', label: 'DESIGN.md', example: 'DESIGN.md' },
  { id: 'design-system', label: 'Design system file', example: 'design-system.json' },
];
export const sourceLabel = (id: ImportSource) =>
  IMPORT_SOURCES.find((source) => source.id === id)?.label ?? id;

/**
 * Where projects usually keep each source. There is no command that lists a project's files, so
 * the editor asks for each of these once and offers the ones that exist.
 */
export const IMPORT_PROBES: readonly { source: ImportSource; path: string }[] = [
  { source: 'design-system', path: 'design-system.json' },
  { source: 'tokens-json', path: 'tokens.json' },
  { source: 'tokens-json', path: 'design-tokens.json' },
  { source: 'tokens-json', path: 'tokens/tokens.json' },
  { source: 'tailwind-config', path: 'tailwind.config.js' },
  { source: 'tailwind-config', path: 'tailwind.config.ts' },
  { source: 'tailwind-config', path: 'tailwind.config.mjs' },
  { source: 'tailwind-config', path: 'tailwind.config.cjs' },
  { source: 'css-variables', path: 'src/styles/tokens.css' },
  { source: 'css-variables', path: 'styles/tokens.css' },
  { source: 'css-variables', path: 'src/tokens.css' },
  { source: 'css-variables', path: 'src/index.css' },
  { source: 'css-variables', path: 'src/styles.css' },
  { source: 'css-variables', path: 'src/app/globals.css' },
  { source: 'css-variables', path: 'app/globals.css' },
  { source: 'design-md', path: 'DESIGN.md' },
  { source: 'design-md', path: 'docs/DESIGN.md' },
];

export type ImportAnswer = { draft: DesignSystemDraft } | { refused: string; next: string };
export type Probe =
  | { source: ImportSource; path: string; draft: DesignSystemDraft }
  | { source: ImportSource; path: string; problem: string };

const KINDS: Record<string, string> = {
  string: 'text',
  number: 'a number',
  boolean: 'true or false',
  object: 'an object',
  array: 'a list',
  undefined: 'nothing',
  null: 'null',
};

/**
 * A file problem in plain words. The controller names the file and the schema path and adds what
 * to do next; the editor already shows the file and its own next step, so this keeps the line and
 * says what the value must be: "Line 7: color.accent must be text, found a number."
 */
export function plainProblem(text: string, path?: string | null): string {
  let said = text.trim();
  if (path && said.startsWith(`${path}: `)) said = said.slice(path.length + 2);
  said = said.replace(/\s*Fix the file, then import it again\.$/, '');
  const where = (value: string) =>
    value
      .replace(/^tokens\./, '')
      .replace(/\.\$(value|type|description)$/, (_, part) =>
        part === 'value' ? '' : ` ${part === 'type' ? 'type' : 'description'}`,
      );
  const typed = /^Line (\d+): (\S+): Invalid input: expected (\w+), received (\w+)\.?$/.exec(said);
  if (typed) {
    const [, line, at = '', expected = '', received = ''] = typed;
    // A token value that must be an object is a size, a duration or a shadow layer.
    const group = /^tokens\.(\w+)\./.exec(at)?.[1] ?? '';
    const shape =
      expected !== 'object'
        ? KINDS[expected]
        : group === 'shadow'
          ? 'a shadow layer'
          : group === 'motion'
            ? 'a duration with a value and a unit'
            : ['spacing', 'radius', 'type'].includes(group)
              ? 'a size with a value and a unit'
              : KINDS.object;
    return `Line ${line}: ${where(at)} must be ${shape ?? expected}, found ${KINDS[received] ?? received}.`;
  }
  const located = /^Line (\d+): (\S+): (.+)$/.exec(said);
  if (located) {
    const [, line, at = '', message = ''] = located;
    return `Line ${line}: ${where(at)}: ${message}`;
  }
  return said;
}

/**
 * Asks for every well-known path once and keeps the files that exist, in probe order. A file that
 * exists but does not read keeps its problem in plain words, so the person sees the line to fix.
 * A path that is not there is dropped. An answer that never came says nothing about its file, so
 * the probe fails with that line.
 */
export async function probeImports(
  importer: (probe: { source: ImportSource; path: string }) => Promise<ImportAnswer>,
  probes: readonly { source: ImportSource; path: string }[] = IMPORT_PROBES,
): Promise<Probe[]> {
  const answers = await Promise.all(probes.map((probe) => importer(probe)));
  const lost = answers.find(
    (answer) => 'refused' in answer && answer.refused === 'outcome-unknown',
  );
  if (lost && 'next' in lost) throw new Error(lost.next);
  return probes.flatMap((probe, index): Probe[] => {
    const answer = answers[index] as ImportAnswer;
    if ('draft' in answer) return [{ ...probe, draft: answer.draft }];
    return answer.refused === 'design-file-missing'
      ? []
      : [{ ...probe, problem: plainProblem(answer.next, probe.path) }];
  });
}

const color = (value: string, description?: string) => ({
  $type: 'color' as const,
  $value: value,
  ...(description ? { $description: description } : {}),
});
const px = (value: number) => ({
  $type: 'dimension' as const,
  $value: { value, unit: 'px' as const },
});
const layer = (y: number, blur: number, shade: string) => ({
  color: shade,
  offsetX: { value: 0, unit: 'px' as const },
  offsetY: { value: y, unit: 'px' as const },
  blur: { value: blur, unit: 'px' as const },
  spread: { value: 0, unit: 'px' as const },
});

/** A small grey scale, one accent and a 4 px spacing scale. */
export const NEUTRAL_TEMPLATE: DesignSystem = {
  schema: 1,
  tokens: {
    color: {
      background: color('#ffffff', 'Page background.'),
      surface: color('#f4f4f5', 'Cards and raised panels.'),
      border: color('#e4e4e7'),
      text: color('#18181b', 'Body text.'),
      'text-muted': color('#52525b', 'Secondary text.'),
      'gray-400': color('#a1a1aa'),
      accent: color('#2563eb', 'Links and the one primary action per view.'),
      'accent-ink': color('#ffffff', 'Text on the accent.'),
    },
    type: {
      sans: { $type: 'fontFamily', $value: ['Inter', 'system-ui', 'sans-serif'] },
      mono: { $type: 'fontFamily', $value: ['ui-monospace', 'monospace'] },
      regular: { $type: 'fontWeight', $value: 400 },
      medium: { $type: 'fontWeight', $value: 500 },
      semibold: { $type: 'fontWeight', $value: 600 },
      sm: px(12),
      base: px(14),
      lg: px(18),
      xl: px(24),
      leading: { $type: 'number', $value: 1.5 },
    },
    spacing: { '1': px(4), '2': px(8), '3': px(12), '4': px(16), '6': px(24), '8': px(32) },
    radius: { sm: px(4), md: px(8), lg: px(12), pill: px(999) },
    shadow: {
      raised: { $type: 'shadow', $value: layer(1, 2, '#0000001a') },
      overlay: { $type: 'shadow', $value: [layer(8, 24, '#00000029'), layer(2, 6, '#0000001f')] },
    },
    motion: {
      fast: { $type: 'duration', $value: { value: 120, unit: 'ms' } },
      base: { $type: 'duration', $value: { value: 200, unit: 'ms' } },
      standard: { $type: 'cubicBezier', $value: [0.2, 0, 0, 1] },
    },
  },
  components: [],
  rules: [
    {
      id: 'tokens-only',
      text: 'Take every color, space, radius and shadow from the tokens.',
      do: ['Use a spacing token for every margin, padding and gap.'],
      dont: ['Do not write a hex color in a component.'],
      example: '.card {\n  padding: var(--spacing-4);\n  background: var(--color-surface);\n}',
    },
  ],
};

/**
 * The tokens this app uses, read from its own tokens.css: the dark theme's colors, the family
 * fills, the shadows written out in full, both font stacks and every spacing and radius step. A
 * value that reads another token is left out, since a design system holds no aliases.
 */
export function crewkiteTemplate(css: string, isColor: ColorCheck): DesignSystem {
  const system = structuredClone(EMPTY_SYSTEM);
  const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const darkBlock = blocks.find(([, selector]) => /data-theme="dark"/.test(selector ?? ''));
  const shared = blocks.findLast(([, selector]) => (selector ?? '').trim().endsWith(':root'));
  const declarations = (body: string | undefined) =>
    [...(body ?? '').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map(
      ([, name, value]) => [name as string, (value as string).trim()] as const,
    );
  const add = (group: TokenGroup, name: string, token: Token) => {
    system.tokens[group][name] = token as never;
  };
  for (const [name, value] of [...declarations(darkBlock?.[2]), ...declarations(shared?.[2])]) {
    if (value.includes('var(')) continue;
    const step = /^(space|radius)-(\w+)$/.exec(name);
    if (step) {
      const parsed = parseValue('dimension', value, isColor);
      if ('value' in parsed)
        add(step[1] === 'space' ? 'spacing' : 'radius', step[2] as string, {
          $type: 'dimension',
          $value: parsed.value as never,
        });
    } else if (name.startsWith('shadow-')) {
      const parsed = parseValue('shadow', value, isColor);
      if ('value' in parsed)
        add('shadow', name.slice(7), { $type: 'shadow', $value: parsed.value as never });
    } else if (name.startsWith('font-')) {
      const parsed = parseValue('fontFamily', value, isColor);
      if ('value' in parsed)
        add('type', name.slice(5), { $type: 'fontFamily', $value: parsed.value as never });
    } else if (isColor(value)) add('color', name, { $type: 'color', $value: value });
  }
  system.rules = [
    {
      id: 'tokens-only',
      text: 'Every color, spacing step, radius, shadow and font family comes from the tokens.',
      do: ['Read a token with var(), such as var(--space-4).'],
      dont: ['Do not write a literal color, length or shadow in a stylesheet.'],
      example: '.card {\n  padding: var(--space-6);\n  border-radius: var(--radius-5);\n}',
    },
  ];
  return system;
}
