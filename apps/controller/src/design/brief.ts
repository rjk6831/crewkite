import { createHash } from 'node:crypto';
import { type DesignSystem, type Token, TokenGroupSchema } from '@crewkite/contracts';
import type { Store } from '../store/index.ts';

// Every writing turn on every provider gets the same text for a saved version, so the version a
// turn records says exactly what the model read. Groups keep their fixed order, token names are
// sorted, and components and rules keep the order the person gave them. The brief has no blank
// line inside, so it reads as one section next to the rules and notes around it.

const HEAD =
  'Design system for this project. Use its tokens for every color, type, spacing, radius, shadow and motion value, and refer to them the way the code already does, such as CSS custom properties or theme keys. Follow its component and written rules. When no token fits, say which value you used and why.';

/** The design system as a writing turn reads it. The same system always gives the same text. */
export function designBrief(system: DesignSystem): string {
  const tokens = TokenGroupSchema.options.flatMap((group) =>
    Object.entries(system.tokens[group])
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(
        ([name, token]) =>
          `${group}.${name}: ${tokenValue(token)}${token.$description ? ` (${token.$description})` : ''}`,
      ),
  );
  return [
    HEAD,
    ...(tokens.length ? ['Tokens:', ...tokens] : []),
    ...ruleLines(
      'Component rules:',
      system.components.map((item) => ({ ...item, title: item.name })),
    ),
    ...ruleLines(
      'Written rules:',
      system.rules.map((item) => ({ ...item, title: item.text })),
    ),
  ].join('\n');
}

/** The SHA-256 of the brief, so a check can show every provider received the same text. */
export function designBriefHash(system: DesignSystem): string {
  return createHash('sha256').update(designBrief(system)).digest('hex');
}

/**
 * The brief a writing turn receives and the version it names, or null when the project has no
 * design system or its delivery is off. It reads the saved version, never the file, so an edit
 * on disk reaches no turn until someone saves it.
 */
export function deliveredDesign(
  store: Store,
  projectId: string,
): { designSystem: { version: number; versionHash: string }; brief: string } | null {
  const record = store.designSystem(projectId);
  if (!record?.delivery) return null;
  const saved = store.designSystemVersion(projectId, record.version);
  // Sending nothing here would let a turn write without the system the person turned on.
  if (!saved)
    throw Error(
      `Version ${record.version} of the design system is missing. Save the design system again, or turn off its delivery.`,
    );
  return {
    designSystem: { version: record.version, versionHash: record.versionHash },
    brief: designBrief(saved.system),
  };
}

function ruleLines(
  head: string,
  items: readonly {
    title: string;
    do: readonly string[];
    dont: readonly string[];
    example: string;
  }[],
): string[] {
  if (!items.length) return [];
  return [
    head,
    ...items.flatMap((item) => [
      `- ${item.title}`,
      ...item.do.map((line) => `  Do: ${line}`),
      ...item.dont.map((line) => `  Do not: ${line}`),
      // An example may span lines. Indenting each one keeps it inside its rule.
      `  Example: ${item.example
        .trim()
        .split(/\r\n|\r|\n/)
        .join('\n    ')}`,
    ]),
  ];
}

const size = (value: { value: number; unit: string }) => `${value.value}${value.unit}`;

/** A token's value in CSS terms, which is how most code in a project spells it. */
function tokenValue(token: Token): string {
  switch (token.$type) {
    case 'color':
      return token.$value;
    case 'dimension':
    case 'duration':
      return size(token.$value);
    case 'fontFamily':
      return typeof token.$value === 'string' ? token.$value : token.$value.join(', ');
    case 'fontWeight':
    case 'number':
      return String(token.$value);
    case 'cubicBezier':
      return `cubic-bezier(${token.$value.join(', ')})`;
    case 'shadow':
      return [token.$value]
        .flat()
        .map((layer) =>
          [
            ...(layer.inset ? ['inset'] : []),
            size(layer.offsetX),
            size(layer.offsetY),
            size(layer.blur),
            size(layer.spread),
            layer.color,
          ].join(' '),
        )
        .join(', ');
  }
}
