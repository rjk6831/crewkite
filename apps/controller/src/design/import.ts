import {
  type DesignComponent,
  DesignComponentSchema,
  type DesignRule,
  DesignRuleSchema,
  type DesignSystem,
  DesignSystemSchema,
  type DesignSystemSourceSchema,
  MAX_GROUP_TOKENS,
  type Token,
  type TokenGroup,
  TokenNameSchema,
  TokenSchema,
} from '@crewkite/contracts';
import type { z } from 'zod';
import { cssDeclarations } from './scan.ts';

// An import reads one project file into a draft and saves nothing. Each value either becomes one
// token the contract accepts or counts as skipped, so the person sees how much the draft left
// behind. Nothing here runs project code. A Tailwind config is read as text, and only the parts of
// its theme that are plain literals are taken.

type Source = z.infer<typeof DesignSystemSourceSchema>;
export type Imported =
  | { system: DesignSystem; skipped: number }
  | { refused: 'design-file-invalid' | 'design-import-empty'; next: string };

export function importDraft(source: Source, text: string, path: string): Imported {
  const body = text.replace(/^﻿/, '');
  if (source === 'design-system') {
    const read = readSystemFile(body);
    return 'system' in read
      ? { system: read.system, skipped: 0 }
      : { refused: 'design-file-invalid', next: `${path}: ${read.error}` };
  }
  const draft = new Draft();
  if (source === 'css-variables')
    try {
      fromCss(draft, body);
    } catch (error) {
      return {
        refused: 'design-file-invalid',
        next: `${path}: ${error instanceof RangeError ? error.message : 'the CSS could not be read.'}`,
      };
    }
  if (source === 'design-md') fromMarkdown(draft, body);
  if (source === 'tokens-json') {
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return {
        refused: 'design-file-invalid',
        next: `${path}: Line ${lineAt(body, jsonIndex(body))} is not valid JSON.`,
      };
    }
    fromTokensJson(draft, value);
  }
  if (source === 'tailwind-config' && !fromTailwind(draft, body))
    return {
      refused: 'design-import-empty',
      next: `${path} has no theme object written as plain values. Tailwind 4 keeps its theme in CSS: import that file as CSS custom properties.`,
    };
  const system = DesignSystemSchema.safeParse(draft.system());
  return system.success
    ? { system: system.data, skipped: draft.skipped }
    : { refused: 'design-file-invalid', next: `${path} holds more than one design system can.` };
}

/** A design system file as JSON, or the first problem in it with its line. */
export function readSystemFile(text: string): { system: DesignSystem } | { error: string } {
  const body = text.replace(/^﻿/, '');
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { error: `Line ${lineAt(body, jsonIndex(body))} is not valid JSON.` };
  }
  const parsed = DesignSystemSchema.safeParse(value);
  if (parsed.success) return { system: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.map(String).join('.');
  const said = `${where ? `${where}: ` : ''}${issue?.message ?? 'Not a design system.'}`;
  // A key or message from the file may hold control characters. The sentence stays one line.
  const clean = said
    .replace(/\p{Cc}/gu, ' ')
    .slice(0, 300)
    .replace(/[^.]$/, '$&.');
  return { error: `Line ${lineAt(body, jsonIndex(body, issue?.path ?? []))}: ${clean}` };
}

export const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;

/**
 * Where JSON text stops parsing. For text that parses, where the value at `target` starts, or its
 * nearest ancestor when the value is absent. JSON.parse reports a position in only some of its
 * messages, and none for a value the schema refused.
 */
export function jsonIndex(text: string, target: readonly PropertyKey[] = []): number {
  let at = 0;
  let found = 0;
  const space = () => {
    while (at < text.length && ' \t\n\r'.includes(text[at] as string)) at++;
  };
  const string = () => {
    const start = at;
    if (text[at] !== '"') throw at;
    for (at++; text[at] !== '"'; at += text[at] === '\\' ? 2 : 1)
      if (at >= text.length || text.charCodeAt(at) < 0x20) throw at;
    at++;
    return JSON.parse(text.slice(start, at)) as string;
  };
  const value = (path: readonly string[]) => {
    space();
    if (path.length <= target.length && path.every((key, index) => key === String(target[index])))
      found = at;
    const open = text[at];
    if (open === '{' || open === '[') {
      const close = open === '{' ? '}' : ']';
      at++;
      space();
      if (text[at] === close) {
        at++;
        return;
      }
      for (let index = 0; ; index++) {
        space();
        if (open === '{') {
          const key = string();
          space();
          if (text[at++] !== ':') throw at - 1;
          value([...path, key]);
        } else value([...path, String(index)]);
        space();
        if (text[at] === close) {
          at++;
          return;
        }
        if (text[at] !== ',') throw at;
        at++;
      }
    }
    if (open === '"') {
      string();
      return;
    }
    const literal = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
    literal.lastIndex = at;
    if (!literal.test(text)) throw at;
    at = literal.lastIndex;
  };
  try {
    value([]);
    space();
    if (at < text.length) throw at;
  } catch (stop) {
    return typeof stop === 'number' ? stop : at;
  }
  return found;
}

const GROUP_TYPES: Record<TokenGroup, readonly Token['$type'][]> = {
  color: ['color'],
  type: ['fontFamily', 'fontWeight', 'dimension', 'number'],
  spacing: ['dimension'],
  radius: ['dimension'],
  shadow: ['shadow'],
  motion: ['duration', 'cubicBezier'],
};

export class Draft {
  readonly tokens: Record<TokenGroup, Record<string, Token>> = {
    color: {},
    type: {},
    spacing: {},
    radius: {},
    shadow: {},
    motion: {},
  };
  readonly components: DesignComponent[] = [];
  readonly rules: DesignRule[] = [];
  skipped = 0;

  /**
   * Keeps a token that fits its group. A second value under one name is skipped, so the first
   * definition wins, which in a stylesheet is the light theme's.
   */
  token(group: TokenGroup, name: string, token: unknown) {
    const parsed = TokenSchema.safeParse(token);
    const tokens = this.tokens[group];
    if (
      !parsed.success ||
      !GROUP_TYPES[group].includes(parsed.data.$type) ||
      !TokenNameSchema.safeParse(name).success ||
      Object.hasOwn(tokens, name) ||
      Object.keys(tokens).length >= MAX_GROUP_TOKENS
    ) {
      this.skipped++;
      return;
    }
    tokens[name] = parsed.data;
  }

  component(value: unknown) {
    this.keep(this.components, DesignComponentSchema.safeParse(value).data);
  }

  rule(value: unknown) {
    this.keep(this.rules, DesignRuleSchema.safeParse(value).data);
  }

  /** Keeps a component or a rule the contract accepts under an ID the draft has not used. */
  private keep<T extends { id: string }>(list: T[], item: T | undefined) {
    if (item && list.length < 100 && !list.some(({ id }) => id === item.id)) list.push(item);
    else this.skipped++;
  }

  skip() {
    this.skipped++;
  }

  system() {
    return { schema: 1, tokens: this.tokens, components: this.components, rules: this.rules };
  }
}

// Values. Each returns undefined for anything the contract cannot hold, and the caller skips it.

const COLOR =
  /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\))$/i;
const color = (value: string) => (COLOR.test(value.trim()) ? value.trim() : undefined);

function dimension(value: string) {
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem)?$/.exec(value.trim());
  if (!match || (!match[2] && Number(match[1]) !== 0)) return undefined;
  return { value: Number(match[1]), unit: (match[2] ?? 'px') as 'px' | 'rem' };
}

function duration(value: string) {
  const match = /^(\d+\.?\d*|\.\d+)(ms|s)$/.exec(value.trim());
  return match ? { value: Number(match[1]), unit: match[2] as 'ms' | 's' } : undefined;
}

const EASINGS: Record<string, number[]> = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
};
function bezier(value: string) {
  const trimmed = value.trim();
  if (Object.hasOwn(EASINGS, trimmed)) return EASINGS[trimmed];
  const points = /^cubic-bezier\(([^()]*)\)$/.exec(trimmed)?.[1]?.split(',').map(Number);
  return points?.length === 4 && points.every(Number.isFinite) ? points : undefined;
}

/** Splits at commas, or at whitespace, outside parentheses and quotes. */
function split(text: string, at: ',' | 'space'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (depth === 0 && (at === ',' ? char === ',' : /\s/.test(char))) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function families(value: string) {
  const names = split(value, ',').map((name) => name.replace(/^(['"])(.*)\1$/, '$2'));
  return names.length === 1 ? names[0] : names;
}

function shadow(value: string) {
  const zero = { value: 0, unit: 'px' as const };
  const layers = split(value, ',').map((layer) => {
    const parts = split(layer, 'space');
    const rest = parts.filter((part) => part !== 'inset');
    const sizes = rest.map(dimension).filter((size) => size !== undefined);
    const colors = rest.filter((part) => !dimension(part));
    const found = colors.length === 1 ? color(colors[0] as string) : undefined;
    if (!found || sizes.length < 2 || sizes.length > 4) return undefined;
    return {
      color: found,
      offsetX: sizes[0],
      offsetY: sizes[1],
      blur: sizes[2] ?? zero,
      spread: sizes[3] ?? zero,
      ...(parts.includes('inset') ? { inset: true } : {}),
    };
  });
  if (layers.some((layer) => !layer)) return undefined;
  return layers.length === 1 ? layers[0] : layers;
}

// Names. A value whose type is ambiguous takes its group from the words in its name. A color is a
// color whatever its name says.

const NAME_GROUPS: [TokenGroup, RegExp][] = [
  ['radius', /radius|radii|rounded/i],
  ['shadow', /shadow|elevation/i],
  ['motion', /duration|ease|easing|timing|motion|transition/i],
  ['type', /font|text|type|typography|leading|line-?height/i],
  ['spacing', /space|spacing|gap|gutter|inset|padding|margin/i],
];
const groupOf = (name: string) => NAME_GROUPS.find(([, words]) => words.test(name))?.[0];

// The group's own word adds nothing inside the group: `--color-accent` becomes `color.accent`.
const PREFIXES: Partial<Record<TokenGroup, RegExp>> = {
  color: /^colou?rs?-/i,
  spacing: /^(?:spacing|space)-/i,
  radius: /^(?:border-?radius|radius|radii|rounded)-/i,
  shadow: /^(?:box-?shadow|shadows?|elevation)-/i,
  motion: /^motion-/i,
};
function tokenName(group: TokenGroup, name: string) {
  const prefix = PREFIXES[group];
  const short = prefix ? name.replace(prefix, '') : name;
  return (short || name).replace(/\./g, '_');
}

/** One CSS value as a token of `group`, read the way the name suggests. */
function typed(group: TokenGroup, name: string, value: string): Token | undefined {
  const size = dimension(value);
  if (group === 'spacing' || group === 'radius')
    return size && { $type: 'dimension', $value: size };
  if (group === 'shadow') {
    const layers = shadow(value);
    return layers && ({ $type: 'shadow', $value: layers } as Token);
  }
  if (group === 'motion') {
    const time = duration(value);
    if (time) return { $type: 'duration', $value: time };
    const curve = bezier(value);
    return curve && ({ $type: 'cubicBezier', $value: curve } as Token);
  }
  if (group === 'type') {
    if (/weight/i.test(name)) {
      const weight = /^\d+$/.test(value.trim()) ? Number(value) : value.trim();
      return { $type: 'fontWeight', $value: weight } as Token;
    }
    if (size) return { $type: 'dimension', $value: size };
    if (/^\d*\.?\d+$/.test(value.trim())) return { $type: 'number', $value: Number(value) };
    if (/font|family/i.test(name)) return { $type: 'fontFamily', $value: families(value) } as Token;
  }
  return undefined;
}

// CSS custom properties. Tailwind 4's @theme block is read here too.

function fromCss(draft: Draft, text: string) {
  // Declarations are read rule by rule, so a selector with two dashes in it, such as a BEM
  // modifier, is never taken for a custom property.
  for (const declaration of cssDeclarations(text)) {
    if (!declaration.property.startsWith('--')) continue;
    const name = declaration.property.slice(2);
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      draft.skip();
      continue;
    }
    const value = declaration.value.trim();
    // A reference or an expression is an alias. The contract keeps none.
    if (/\b(?:var|calc|env|color-mix)\(/i.test(value)) {
      draft.skip();
      continue;
    }
    const found = color(value);
    if (found) {
      draft.token('color', tokenName('color', name), { $type: 'color', $value: found });
      continue;
    }
    const group = groupOf(name);
    if (group) draft.token(group, tokenName(group, name), typed(group, name, value));
    else draft.skip();
  }
}

// W3C design tokens community format. Groups nest freely there and carry `$type` down.

type Json = Record<string, unknown>;
export const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fromTokensJson(draft: Draft, root: unknown) {
  const walk = (node: unknown, path: string[], inherited: unknown) => {
    if (!isObject(node)) return;
    const type = node.$type ?? inherited;
    if ('$value' in node) {
      w3cToken(draft, path.join('-'), type, node);
      return;
    }
    for (const [key, child] of Object.entries(node))
      if (!key.startsWith('$')) walk(child, [...path, key], type);
  };
  walk(root, [], undefined);
}

function w3cColor(value: unknown) {
  if (typeof value === 'string') return color(value);
  // The 2025 format writes a color as an object. Its hex form is the one a CSS string can carry.
  if (isObject(value) && typeof value.hex === 'string' && (value.alpha ?? 1) === 1)
    return color(value.hex);
  return undefined;
}

function w3cMeasure(value: unknown, units: readonly string[]) {
  if (typeof value === 'string') {
    const found = units.includes('px') ? dimension(value) : duration(value);
    return found && units.includes(found.unit) ? found : undefined;
  }
  if (isObject(value) && typeof value.value === 'number' && units.includes(value.unit as string))
    return { value: value.value, unit: value.unit };
  return undefined;
}

function w3cShadow(value: unknown) {
  const layer = (item: unknown) => {
    if (!isObject(item)) return undefined;
    const sizes = [item.offsetX, item.offsetY, item.blur, item.spread ?? '0px'].map((size) =>
      w3cMeasure(size, ['px', 'rem']),
    );
    const found = w3cColor(item.color);
    if (!found || sizes.some((size) => !size)) return undefined;
    const [offsetX, offsetY, blur, spread] = sizes;
    return { color: found, offsetX, offsetY, blur, spread, ...(item.inset ? { inset: true } : {}) };
  };
  const layers = (Array.isArray(value) ? value : [value]).map(layer);
  if (layers.length === 0 || layers.some((item) => !item)) return undefined;
  return Array.isArray(value) ? layers : layers[0];
}

function w3cToken(draft: Draft, name: string, type: unknown, node: Json) {
  const value = node.$value;
  // An alias names another token. The contract keeps none.
  if (typeof value === 'string' && /^\{.+\}$/.test(value.trim())) return draft.skip();
  const description =
    typeof node.$description === 'string' &&
    /^[^\p{Cc}]{1,500}$/u.test(node.$description) &&
    node.$description.isWellFormed()
      ? { $description: node.$description }
      : {};
  const put = (group: TokenGroup, token: Json | undefined) =>
    draft.token(group, tokenName(group, name), token && { ...token, ...description });
  const group = groupOf(name);
  switch (type) {
    case 'color':
      return put('color', { $type: 'color', $value: w3cColor(value) });
    case 'dimension': {
      const target = group === 'radius' || group === 'type' || group === 'spacing' ? group : null;
      if (!target) return draft.skip();
      return put(target, { $type: 'dimension', $value: w3cMeasure(value, ['px', 'rem']) });
    }
    case 'fontFamily':
    case 'fontWeight':
      return put('type', { $type: type, $value: value });
    case 'number':
      if (!/line|leading|height/i.test(name)) return draft.skip();
      return put('type', { $type: 'number', $value: value });
    case 'duration':
      return put('motion', { $type: 'duration', $value: w3cMeasure(value, ['ms', 's']) });
    case 'cubicBezier':
      return put('motion', { $type: 'cubicBezier', $value: value });
    case 'shadow':
      return put('shadow', { $type: 'shadow', $value: w3cShadow(value) });
    default:
      // Typography, border, transition, gradient and stroke style have no place in the contract.
      return draft.skip();
  }
}

// Tailwind config, read as text. A value that is not a plain literal is skipped where it stands,
// and the reader moves to the next property. Nothing is evaluated.

const UNREAD = Symbol('unread');
type Literal =
  | string
  | number
  | boolean
  | null
  | typeof UNREAD
  | Literal[]
  | { [key: string]: Literal };

class LiteralReader {
  at = 0;
  /** Object entries that were not `key: value`: spreads, shorthands, methods, computed keys. */
  unread = 0;
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private space() {
    for (;;) {
      const rest = this.text.slice(this.at, this.at + 2);
      if (/^\s/.test(rest)) this.at++;
      else if (rest === '//') this.at = this.endOf('\n', this.at);
      else if (rest === '/*') this.at = this.endOf('*/', this.at) + 1;
      else return;
    }
  }

  private endOf(token: string, from: number) {
    const found = this.text.indexOf(token, from + 2);
    return found === -1 ? this.text.length : found + 1;
  }

  /** Steps over one expression of any shape, up to the comma or bracket that ends it. */
  private skip() {
    let depth = 0;
    while (this.at < this.text.length) {
      this.space();
      const char = this.text[this.at] as string;
      if (char === '"' || char === "'" || char === '`') {
        this.quoted();
        continue;
      }
      if ('([{'.includes(char)) depth++;
      else if (')]}'.includes(char)) {
        if (depth === 0) return;
        depth--;
      } else if (char === ',' && depth === 0) return;
      this.at++;
    }
  }

  /** A quoted string, or undefined when it is a template with substitutions. */
  private quoted(): string | undefined {
    const quote = this.text[this.at];
    let out = '';
    let plain = true;
    for (this.at++; this.at < this.text.length; this.at++) {
      const char = this.text[this.at] as string;
      if (char === quote) {
        this.at++;
        return plain ? out : undefined;
      }
      if (char === '\\') {
        this.at++;
        out += this.text[this.at] ?? '';
      } else {
        if (quote === '`' && char === '$' && this.text[this.at + 1] === '{') plain = false;
        out += char;
      }
    }
    return undefined;
  }

  value(): Literal {
    this.space();
    const start = this.at;
    const char = this.text[this.at];
    let found: Literal = UNREAD;
    if (char === '{') found = this.object();
    else if (char === '[') found = this.array();
    else if (char === '"' || char === "'" || char === '`') found = this.quoted() ?? UNREAD;
    else {
      const literal = /-?(?:\d+\.?\d*|\.\d+)|true\b|false\b|null\b/y;
      literal.lastIndex = this.at;
      const match = literal.exec(this.text);
      if (match) {
        this.at = literal.lastIndex;
        found =
          match[0] === 'null'
            ? null
            : match[0] === 'true' || match[0] === 'false'
              ? match[0] === 'true'
              : Number(match[0]);
      }
    }
    this.space();
    // Anything after the literal makes it an expression: `'a' + b`, `colors.blue`, a call.
    if (found === UNREAD || !',}]'.includes(this.text[this.at] ?? ',')) {
      this.at = start;
      this.skip();
      return UNREAD;
    }
    return found;
  }

  private array(): Literal {
    const items: Literal[] = [];
    this.at++;
    for (;;) {
      this.space();
      const before = this.at;
      if (this.text[this.at] === ']' || this.at >= this.text.length) {
        this.at++;
        return items;
      }
      items.push(this.value());
      this.space();
      if (this.text[this.at] === ',') this.at++;
      if (this.at === before) return this.stuck();
    }
  }

  private object(): Literal {
    const entries: Record<string, Literal> = {};
    this.at++;
    for (;;) {
      this.space();
      const before = this.at;
      if (this.text[this.at] === '}' || this.at >= this.text.length) {
        this.at++;
        return entries;
      }
      const key = this.key();
      this.space();
      if (key !== undefined && this.text[this.at] === ':') {
        this.at++;
        entries[key] = this.value();
      } else {
        this.unread++;
        this.skip();
      }
      this.space();
      if (this.text[this.at] === ',') this.at++;
      if (this.at === before) return this.stuck();
    }
  }

  /** A closing bracket that is not this one's. The rest of the file is not a literal. */
  private stuck(): Literal {
    this.at = this.text.length;
    return UNREAD;
  }

  private key(): string | undefined {
    const char = this.text[this.at];
    if (char === '"' || char === "'") return this.quoted();
    const name = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?/y;
    name.lastIndex = this.at;
    const match = name.exec(this.text);
    if (!match) return undefined;
    this.at = name.lastIndex;
    return match[0];
  }
}

const SECTIONS: Record<string, [TokenGroup, string]> = {
  colors: ['color', ''],
  spacing: ['spacing', ''],
  borderRadius: ['radius', ''],
  boxShadow: ['shadow', ''],
  fontFamily: ['type', 'font-'],
  fontSize: ['type', 'text-'],
  fontWeight: ['type', 'font-weight-'],
  lineHeight: ['type', 'leading-'],
  transitionDuration: ['motion', 'duration-'],
  transitionTimingFunction: ['motion', 'ease-'],
};

/** Reads the theme object. False when the file has none written as a literal. */
function fromTailwind(draft: Draft, text: string): boolean {
  const start = /\btheme\s*:\s*\{/.exec(text);
  if (!start) return false;
  const reader = new LiteralReader(text);
  reader.at = start.index + start[0].length - 1;
  const theme = reader.value();
  if (!isLiteralObject(theme)) return false;
  for (let index = 0; index < reader.unread; index++) draft.skip();
  // Extend comes first, so its value wins over the base one under the same name.
  const { extend, ...base } = theme;
  for (const sections of [isLiteralObject(extend) ? extend : {}, base])
    for (const [section, content] of Object.entries(sections)) {
      const target = Object.hasOwn(SECTIONS, section) ? SECTIONS[section] : undefined;
      for (const [path, leaf] of leaves(content, [])) {
        if (!target) {
          draft.skip();
          continue;
        }
        const [group, prefix] = target;
        const name = `${prefix}${path.filter((part) => part !== 'DEFAULT').join('-') || 'default'}`;
        const value = cssText(section, leaf);
        if (value === undefined) draft.skip();
        else
          draft.token(
            group,
            tokenName(group, name),
            group === 'color'
              ? { $type: 'color', $value: color(value) }
              : typed(group, name, value),
          );
      }
    }
  if (extend !== undefined && !isLiteralObject(extend)) draft.skip();
  return true;
}

const isLiteralObject = (value: Literal | undefined): value is Record<string, Literal> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Nested color scales flatten to `blue-500`. Arrays are values in their own right. */
function leaves(value: Literal, path: string[]): [string[], Literal][] {
  if (!isLiteralObject(value)) return [[path, value]];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key]));
}

/** A theme value as the CSS text it stands for. */
function cssText(section: string, value: Literal): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (!Array.isArray(value)) return undefined;
  // fontSize is [size, line height or options]. fontFamily is a list, or [list, options].
  const first = value[0];
  if (section === 'fontSize') return typeof first === 'string' ? first : undefined;
  const names = Array.isArray(first) ? first : value;
  return section === 'fontFamily' && names.every((name) => typeof name === 'string')
    ? names.map((name) => (/^["']|^[^\s,]+$/.test(name as string) ? name : `"${name}"`)).join(', ')
    : undefined;
}

// DESIGN.md. Each heading with a list under it becomes a rule. A line that starts with don't,
// do not, never or avoid is a don't. The first code block is the example, else the first line.

function fromMarkdown(draft: Draft, text: string) {
  const sections: { title: string; lines: string[]; code?: string }[] = [];
  let fence: string[] | undefined;
  for (const line of text.split(/\r?\n/)) {
    const section = sections.at(-1);
    if (/^\s*(?:```|~~~)/.test(line)) {
      if (fence && section && section.code === undefined) section.code = fence.join('\n').trim();
      fence = fence ? undefined : [];
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) sections.push({ title: heading[1] as string, lines: [] });
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (item && section) section.lines.push((item[1] as string).trim());
  }
  const ids = new Set<string>();
  for (const { title, lines, code } of sections) {
    if (lines.length === 0) continue;
    const kept = { do: [] as string[], dont: [] as string[] };
    for (const line of lines) {
      const list = /^(?:don'?t|do not|never|avoid)\b/i.test(line) ? kept.dont : kept.do;
      const text = line.replace(/^(?:do|don'?t|do not)\s*:\s*/i, '');
      if (list.length < 20 && text.length <= 300 && !/\p{Cc}/u.test(text)) list.push(text);
      else draft.skip();
    }
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 56);
    let id = slug || 'rule';
    for (let count = 2; ids.has(id); count++) id = `${slug || 'rule'}-${count}`;
    ids.add(id);
    draft.rule({
      id,
      text: title.slice(0, 500),
      ...kept,
      example: (code || (lines[0] as string)).slice(0, 2000),
    });
  }
}
