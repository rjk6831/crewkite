import {
  canonicalJson,
  type DesignComponent,
  type DesignRule,
  type DesignSystem,
  DesignSystemSchema,
  type Token,
  type TokenGroup,
  TokenGroupSchema,
  TokenNameSchema,
} from '@crewkite/contracts';

// The design system editor works on text. Every field keeps what the person typed, valid or not,
// so a half-typed value survives a category switch and the count of values to fix stays honest.
// The contract shape is built from the text on demand, and only a fully valid model is saved.

export const GROUPS = TokenGroupSchema.options;
export type Category = TokenGroup | 'components' | 'rules';
export const CATEGORIES: readonly { id: Category; label: string }[] = [
  { id: 'color', label: 'Colors' },
  { id: 'type', label: 'Type' },
  { id: 'spacing', label: 'Spacing' },
  { id: 'radius', label: 'Radius' },
  { id: 'shadow', label: 'Shadow' },
  { id: 'motion', label: 'Motion' },
  { id: 'components', label: 'Components' },
  { id: 'rules', label: 'Rules' },
];
export const categoryLabel = (id: Category) =>
  CATEGORIES.find((category) => category.id === id)?.label ?? id;
/** What a row without a name is called, such as "New spacing token". */
export const newLabel = (category: Category) =>
  category === 'components'
    ? 'New component'
    : category === 'rules'
      ? 'New rule'
      : `New ${category} token`;

export const EMPTY_SYSTEM: DesignSystem = {
  schema: 1,
  tokens: { color: {}, type: {}, spacing: {}, radius: {}, shadow: {}, motion: {} },
  components: [],
  rules: [],
};

export type TokenType = Token['$type'];
type ValueOf<T extends TokenType> = Extract<Token, { $type: T }>['$value'];
type Dimension = { value: number; unit: 'px' | 'rem' };
type ShadowLayer = Exclude<ValueOf<'shadow'>, unknown[]>;

/** Says whether the text is a CSS color. The editor asks the browser; tests pass their own. */
export type ColorCheck = (value: string) => boolean;

const dimensionText = (value: { value: number; unit: string }) => `${value.value}${value.unit}`;
const layerText = (layer: ShadowLayer) =>
  [
    layer.inset ? 'inset' : '',
    dimensionText(layer.offsetX),
    dimensionText(layer.offsetY),
    dimensionText(layer.blur),
    dimensionText(layer.spread),
    layer.color,
  ]
    .filter(Boolean)
    .join(' ');

/** A token's value as the person reads and types it. */
export function valueText(token: Token): string {
  switch (token.$type) {
    case 'color':
      return token.$value;
    case 'dimension':
    case 'duration':
      return dimensionText(token.$value);
    case 'fontFamily':
      return typeof token.$value === 'string' ? token.$value : token.$value.join(', ');
    case 'fontWeight':
    case 'number':
      return String(token.$value);
    case 'cubicBezier':
      return `cubic-bezier(${token.$value.join(', ')})`;
    case 'shadow':
      return (Array.isArray(token.$value) ? token.$value : [token.$value])
        .map(layerText)
        .join(', ');
  }
}

const NUMBER = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
const oneLine = (text: string) => text.isWellFormed() && !/\p{Cc}/u.test(text);
// Splits on commas outside parentheses, so rgb(0, 0, 0) stays one part.
function topLevel(text: string, separator: RegExp) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? '';
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && separator.test(char)) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}
const WEIGHTS = new Set([
  'thin',
  'hairline',
  'extra-light',
  'ultra-light',
  'light',
  'normal',
  'regular',
  'book',
  'medium',
  'semi-bold',
  'demi-bold',
  'bold',
  'extra-bold',
  'ultra-bold',
  'black',
  'heavy',
  'extra-black',
  'ultra-black',
]);

function dimension(text: string): Dimension | null {
  const match = new RegExp(`^(${NUMBER})(px|rem)$`).exec(text);
  if (match) return { value: Number(match[1]), unit: match[2] as 'px' | 'rem' };
  return Number(text) === 0 && text.trim() !== '' ? { value: 0, unit: 'px' } : null;
}

const colorValue = (text: string, isColor: ColorCheck) =>
  text.length <= 100 && oneLine(text) && !/var\(|\{/.test(text) && isColor(text);

function shadowLayer(text: string, isColor: ColorCheck): ShadowLayer | null {
  const words = topLevel(text, /\s/);
  const inset = words[0] === 'inset' || words.at(-1) === 'inset';
  const rest = words.filter(
    (word, index) => !(word === 'inset' && (index === 0 || index === words.length - 1)),
  );
  const lengths: Dimension[] = [];
  let color: string | null = null;
  for (const word of rest) {
    const size = dimension(word);
    if (size && color === null) lengths.push(size);
    else if (color === null && colorValue(word, isColor)) color = word;
    else return null;
  }
  if (!color || lengths.length < 2 || lengths.length > 4) return null;
  const zero = { value: 0, unit: 'px' as const };
  const [offsetX, offsetY, blur = zero, spread = zero] = lengths as [Dimension, Dimension];
  return { color, offsetX, offsetY, blur, spread, ...(inset ? { inset: true } : {}) };
}

const VALUE_HELP: Record<TokenType, string> = {
  color: 'Not a CSS color.',
  dimension: 'Use px or rem, such as 16px.',
  fontFamily: 'List one or more font names, separated by commas.',
  fontWeight: 'Use 1 to 1000, or a name such as bold.',
  number: 'Use a number, such as 1.5.',
  duration: 'Use ms or s, such as 150ms.',
  cubicBezier: 'Use cubic-bezier(x1, y1, x2, y2) with x1 and x2 from 0 to 1.',
  shadow: 'Use offset-x offset-y blur spread color, such as 0 2px 8px 0 #0003.',
};

/** The contract value for typed text, or the sentence that says what to type. */
export function parseValue(
  type: TokenType,
  raw: string,
  isColor: ColorCheck,
): { value: Token['$value'] } | { problem: string } {
  const text = raw.trim();
  const fail = { problem: text ? VALUE_HELP[type] : 'Enter a value.' };
  if (!text) return fail;
  switch (type) {
    case 'color':
      return colorValue(text, isColor) ? { value: text } : fail;
    case 'dimension': {
      const size = dimension(text);
      return size ? { value: size } : fail;
    }
    case 'fontFamily': {
      const names = topLevel(text, /,/).map((name) => name.replace(/^(['"])(.*)\1$/, '$2').trim());
      if (!names.length || names.length > 20 || names.some((name) => !name || name.length > 100))
        return fail;
      if (!names.every(oneLine)) return fail;
      return { value: names.length === 1 ? (names[0] as string) : names };
    }
    case 'fontWeight': {
      if (WEIGHTS.has(text)) return { value: text as ValueOf<'fontWeight'> };
      const weight = Number(text);
      return /^\d+$/.test(text) && weight >= 1 && weight <= 1000 ? { value: weight } : fail;
    }
    case 'number': {
      const number = Number(text);
      return new RegExp(`^${NUMBER}$`).test(text) && Number.isFinite(number)
        ? { value: number }
        : fail;
    }
    case 'duration': {
      const match = /^(\d+\.?\d*|\.\d+)(ms|s)$/.exec(text);
      return match ? { value: { value: Number(match[1]), unit: match[2] as 'ms' | 's' } } : fail;
    }
    case 'cubicBezier': {
      const inner = /^cubic-bezier\((.*)\)$/.exec(text)?.[1] ?? text;
      const parts = inner.split(',').map((part) => part.trim());
      if (parts.length !== 4 || !parts.every((part) => new RegExp(`^${NUMBER}$`).test(part)))
        return fail;
      const [x1, y1, x2, y2] = parts.map(Number) as [number, number, number, number];
      if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return fail;
      return { value: [x1, y1, x2, y2] };
    }
    case 'shadow': {
      const layers = topLevel(text, /,/).map((layer) => shadowLayer(layer, isColor));
      if (!layers.length || layers.length > 8 || layers.some((layer) => layer === null))
        return fail;
      const valid = layers as ShadowLayer[];
      return { value: valid.length === 1 ? (valid[0] as ShadowLayer) : valid };
    }
  }
}

/** The CSS a specimen draws with, or null when the value does not parse. */
export function cssValue(type: TokenType, text: string, isColor: ColorCheck): string | null {
  const parsed = parseValue(type, text, isColor);
  if ('problem' in parsed) return null;
  const token = { $type: type, $value: parsed.value } as Token;
  if (type === 'fontFamily')
    return (Array.isArray(parsed.value) ? parsed.value : [parsed.value])
      .map((name) => (/^[\w-]+$/.test(String(name)) ? String(name) : JSON.stringify(name)))
      .join(', ');
  return valueText(token);
}

export type TokenDraft = {
  key: string;
  name: string;
  type: TokenType;
  value: string;
  description: string;
  /** The token as loaded. Unchanged text keeps this exact value, so a load never reads as a change. */
  original?: Token;
  originalName?: string;
};
export type ItemDraft = {
  key: string;
  /** The saved ID. A new item takes one from its title. */
  id: string | null;
  title: string;
  do: string;
  dont: string;
  example: string;
  original?: DesignComponent | DesignRule;
};
export type EditModel = {
  tokens: Record<TokenGroup, TokenDraft[]>;
  components: ItemDraft[];
  rules: ItemDraft[];
};

let keys = 0;
/** A key for a new row. Rows keep it through renames, so focus and edit state follow the row. */
export const draftKey = () => `d${++keys}`;

export function tokenDraft(name: string, token: Token, key = draftKey()): TokenDraft {
  return {
    key,
    name,
    type: token.$type,
    value: valueText(token),
    description: token.$description ?? '',
    original: token,
    originalName: name,
  };
}
const itemDraft = (item: DesignComponent | DesignRule, key = draftKey()): ItemDraft => ({
  key,
  id: item.id,
  title: 'name' in item ? item.name : item.text,
  do: item.do.join('\n'),
  dont: item.dont.join('\n'),
  example: item.example,
  original: item,
});

export function toModel(system: DesignSystem): EditModel {
  return {
    tokens: Object.fromEntries(
      GROUPS.map((group) => [
        group,
        Object.entries(system.tokens[group]).map(([name, token]) => tokenDraft(name, token)),
      ]),
    ) as EditModel['tokens'],
    components: system.components.map((item) => itemDraft(item)),
    rules: system.rules.map((item) => itemDraft(item)),
  };
}

export type Field = 'name' | 'value' | 'description' | 'title' | 'do' | 'dont' | 'example';
export type Problem = {
  category: Category;
  key: string;
  field: Field;
  label: string;
  message: string;
};

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 56)
    .replace(/-+$/, '') || 'item';

/** The ID each item saves under. A new item takes one from its title that no other item has. */
export function itemIds(items: readonly ItemDraft[]): string[] {
  const taken = new Set(items.flatMap((item) => (item.id ? [item.id] : [])));
  return items.map((item) => {
    if (item.id) return item.id;
    const base = slug(item.title);
    let id = base;
    for (let count = 2; taken.has(id); count++) id = `${base}-${count}`;
    taken.add(id);
    return id;
  });
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * The model as the contract shape, with every problem. A row that does not parse keeps its loaded
 * token, if it had one, so the diff shows only finished edits; the problem list names the rest.
 */
export function fromModel(
  model: EditModel,
  isColor: ColorCheck,
): { system: DesignSystem; problems: Problem[]; unfinished: DiffLine[] } {
  const problems: Problem[] = [];
  // New rows that do not parse yet. The diff still counts them, so a drafted token shows as a
  // change before it has a name.
  const unfinished: DiffLine[] = [];
  const tokens = {} as Record<TokenGroup, Record<string, Token>>;
  for (const group of GROUPS) {
    const out: Record<string, Token> = {};
    const names = new Map<string, number>();
    for (const draft of model.tokens[group])
      names.set(draft.name.trim(), (names.get(draft.name.trim()) ?? 0) + 1);
    for (const draft of model.tokens[group]) {
      const name = draft.name.trim();
      const label = name ? `${group}.${name}` : newLabel(group);
      const problem = (field: Field, message: string) =>
        problems.push({ category: group, key: draft.key, field, label, message });
      const before = problems.length;
      if (!name) problem('name', 'Name this token.');
      else if (!TokenNameSchema.safeParse(name).success)
        problem(
          'name',
          'Use letters, digits, hyphens and underscores. Start with a letter or digit.',
        );
      else if ((names.get(name) ?? 0) > 1)
        problem('name', 'Another token in this group has this name.');
      const unchanged =
        draft.original &&
        draft.original.$type === draft.type &&
        valueText(draft.original) === draft.value;
      const parsed = unchanged ? null : parseValue(draft.type, draft.value, isColor);
      if (parsed && 'problem' in parsed) problem('value', parsed.problem);
      const description = draft.description.trim();
      if (description && (description.length > 500 || !oneLine(description)))
        problem('description', 'Keep the description to one line under 500 characters.');
      if (problems.length > before) {
        if (draft.original && draft.originalName && !(draft.originalName in out))
          out[draft.originalName] = draft.original;
        if (!draft.original)
          unfinished.push({
            key: `new:${draft.key}`,
            category: group,
            kind: 'added',
            path: `new:${draft.key}`,
            text: name ? `Adds ${group}.${name}` : `Adds a ${newLabel(group).toLowerCase()}`,
          });
        continue;
      }
      const value = parsed && 'value' in parsed ? parsed.value : draft.original?.$value;
      // The loaded text, spaces and all, keeps the loaded token, so opening a file never reads as
      // a change to it.
      const kept =
        unchanged && (draft.original?.$description ?? '') === draft.description && draft.original;
      out[name] = kept
        ? kept
        : ({
            $type: draft.type,
            $value: value,
            ...(description ? { $description: description } : {}),
          } as Token);
    }
    tokens[group] = out;
  }
  const items = (category: 'components' | 'rules') => {
    const drafts = model[category];
    const ids = itemIds(drafts);
    return drafts.flatMap((draft, index) => {
      const titleMax = category === 'components' ? 80 : 500;
      const title = draft.title.trim();
      const label = title
        ? title.length > 40
          ? `${title.slice(0, 40)}…`
          : title
        : newLabel(category);
      const problem = (field: Field, message: string) =>
        problems.push({ category, key: draft.key, field, label, message });
      const original = draft.original;
      if (
        original &&
        draft.id === original.id &&
        draft.title === ('name' in original ? original.name : original.text) &&
        draft.do === original.do.join('\n') &&
        draft.dont === original.dont.join('\n') &&
        draft.example === original.example
      )
        return [original];
      const before = problems.length;
      if (!title)
        problem('title', category === 'components' ? 'Name this component.' : 'Write the rule.');
      else if (title.length > titleMax || !oneLine(title))
        problem('title', `Keep it to one line under ${titleMax} characters.`);
      for (const field of ['do', 'dont'] as const) {
        const list = lines(draft[field]);
        if (list.length > 20 || list.some((line) => line.length > 300))
          problem(field, 'Use at most 20 lines, each under 300 characters.');
      }
      if (!draft.example.trim()) problem('example', 'Add an example.');
      else if (draft.example.length > 2000)
        problem('example', 'Keep the example under 2,000 characters.');
      if (problems.length > before) {
        if (!draft.original)
          unfinished.push({
            key: `new:${draft.key}`,
            category,
            kind: 'added',
            path: `new:${draft.key}`,
            text: title ? `Adds ${label}` : `Adds a ${newLabel(category).toLowerCase()}`,
          });
        return draft.original ? [draft.original] : [];
      }
      const body = {
        id: ids[index] as string,
        do: lines(draft.do),
        dont: lines(draft.dont),
        example: draft.example,
      };
      return [category === 'components' ? { ...body, name: title } : { ...body, text: title }];
    });
  };
  // Each token was built for its own group above, which the record type cannot express.
  const system: DesignSystem = {
    schema: 1,
    tokens: tokens as unknown as DesignSystem['tokens'],
    components: items('components') as DesignComponent[],
    rules: items('rules') as DesignRule[],
  };
  if (problems.length === 0) {
    const checked = DesignSystemSchema.safeParse(system);
    if (!checked.success)
      problems.push({
        category: 'color',
        key: 'system',
        field: 'value',
        label: 'Design system',
        message: checked.error.issues[0]?.message ?? 'The design system does not fit the format.',
      });
  }
  return { system, problems, unfinished };
}

export type DiffLine = {
  key: string;
  category: Category;
  kind: 'added' | 'changed' | 'removed' | 'renamed' | 'moved';
  /** The token path or item ID the line is about. A rename names the new path. */
  path: string;
  /** The old path of a rename. */
  from?: string;
  text: string;
  /** Rules and components whose example names the old path of a rename. */
  named?: string[];
};

const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const valueKey = (token: Token) => canonicalJson({ $type: token.$type, $value: token.$value });
const titleOf = (item: DesignComponent | DesignRule) => {
  const text = 'name' in item ? item.name : item.text;
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
};
const mentions = (example: string, group: TokenGroup, name: string) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w.-])(${group}\\.${escaped}|--${escaped})(?![\\w-])`).test(example);
};

/**
 * What a save would change, line by line, grouped by category. A token that left one name and
 * arrived under another with the same value reads as a rename, and the line lists the rules and
 * components whose example still names the old token.
 */
export function diffLines(before: DesignSystem, after: DesignSystem): DiffLine[] {
  const out: DiffLine[] = [];
  for (const group of GROUPS) {
    const old = before.tokens[group];
    const next = after.tokens[group];
    const added = Object.keys(next).filter((name) => !Object.hasOwn(old, name));
    const removed = Object.keys(old).filter((name) => !Object.hasOwn(next, name));
    // A rename pairs one removed and one added token whose value no other moved token shares.
    const renamedFrom = new Map<string, string>();
    for (const name of added) {
      const key = valueKey(next[name] as Token);
      const gone = removed.filter((value) => valueKey(old[value] as Token) === key);
      const arrived = added.filter((value) => valueKey(next[value] as Token) === key);
      if (gone.length === 1 && arrived.length === 1) renamedFrom.set(name, gone[0] as string);
    }
    const renamedTo = new Set(renamedFrom.values());
    for (const [name, token] of Object.entries(next)) {
      const path = `${group}.${name}`;
      const from = renamedFrom.get(name);
      if (from) {
        const named = [...after.rules, ...after.components]
          .filter((item) => mentions(item.example, group, from))
          .map(titleOf);
        out.push({
          key: `rename:${group}.${from}`,
          category: group,
          kind: 'renamed',
          path,
          from: `${group}.${from}`,
          text: `Renamed ${group}.${from} to ${path}`,
          ...(named.length ? { named } : {}),
        });
      } else if (!Object.hasOwn(old, name))
        out.push({
          key: `add:${path}`,
          category: group,
          kind: 'added',
          path,
          text: `Added ${path} ${valueText(token)}`,
        });
      else if (!same(old[name], token)) {
        const was = old[name] as Token;
        const valueChanged = valueText(was) !== valueText(token) || was.$type !== token.$type;
        out.push({
          key: `change:${path}`,
          category: group,
          kind: 'changed',
          path,
          text: valueChanged
            ? `Changed ${path} ${valueText(was)} to ${valueText(token)}`
            : `Changed ${path} description`,
        });
      }
    }
    for (const name of removed)
      if (!renamedTo.has(name))
        out.push({
          key: `remove:${group}.${name}`,
          category: group,
          kind: 'removed',
          path: `${group}.${name}`,
          text: `Removed ${group}.${name}`,
        });
  }
  for (const category of ['components', 'rules'] as const) {
    const noun = category === 'components' ? 'component' : 'rule';
    const old = new Map(before[category].map((item) => [item.id, item] as const));
    const next = new Map(after[category].map((item) => [item.id, item] as const));
    for (const [id, item] of next) {
      const was = old.get(id);
      if (!was)
        out.push({
          key: `add:${noun}:${id}`,
          category,
          kind: 'added',
          path: id,
          text: `Added ${noun} ${titleOf(item)}`,
        });
      else if (!same(was, item))
        out.push({
          key: `change:${noun}:${id}`,
          category,
          kind: 'changed',
          path: id,
          text: `Changed ${noun} ${titleOf(item)}`,
        });
    }
    for (const [id, item] of old)
      if (!next.has(id))
        out.push({
          key: `remove:${noun}:${id}`,
          category,
          kind: 'removed',
          path: id,
          text: `Removed ${noun} ${titleOf(item)}`,
        });
    const kept = (list: readonly { id: string }[], other: Map<string, unknown>) =>
      list.filter((item) => other.has(item.id)).map((item) => item.id);
    if (!same(kept(before[category], next), kept(after[category], old)))
      out.push({
        key: `move:${category}`,
        category,
        kind: 'moved',
        path: category,
        text: `Changed the order of ${category}`,
      });
  }
  return out;
}

/** Puts one diff line back the way the saved version has it. The other edits stay. */
export function revertLine(model: EditModel, before: DesignSystem, line: DiffLine): EditModel {
  // A new row that does not parse yet has no saved form to go back to, so it leaves.
  if (line.key.startsWith('new:')) {
    const key = line.key.slice(4);
    if (line.category === 'components' || line.category === 'rules')
      return { ...model, [line.category]: model[line.category].filter((item) => item.key !== key) };
    return {
      ...model,
      tokens: {
        ...model.tokens,
        [line.category]: model.tokens[line.category].filter((draft) => draft.key !== key),
      },
    };
  }
  if (line.category === 'components' || line.category === 'rules') {
    const category = line.category;
    const drafts = model[category];
    const ids = itemIds(drafts);
    const saved: readonly (DesignComponent | DesignRule)[] = before[category];
    if (line.kind === 'moved') {
      const order = new Map(saved.map((item, index) => [item.id, index] as const));
      const kept = drafts
        .map((draft, index) => ({ draft, id: ids[index] as string }))
        .filter(({ id }) => order.has(id))
        .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
      let next = 0;
      return {
        ...model,
        [category]: drafts.map((draft, index) =>
          order.has(ids[index] as string) ? (kept[next++]?.draft ?? draft) : draft,
        ),
      };
    }
    const at = ids.indexOf(line.path);
    const original = saved.find((item) => item.id === line.path);
    if (line.kind === 'added')
      return { ...model, [category]: drafts.filter((_, index) => index !== at) };
    if (!original) return model;
    if (line.kind === 'changed')
      return {
        ...model,
        [category]: drafts.map((draft, index) =>
          index === at ? itemDraft(original, draft.key) : draft,
        ),
      };
    const position = Math.min(saved.indexOf(original), drafts.length);
    return {
      ...model,
      [category]: [...drafts.slice(0, position), itemDraft(original), ...drafts.slice(position)],
    };
  }
  const group = line.category;
  const drafts = model.tokens[group];
  const name = line.path.slice(group.length + 1);
  const oldName = (line.from ?? line.path).slice(group.length + 1);
  const at = drafts.findIndex((draft) => draft.name.trim() === name);
  const original = before.tokens[group][oldName];
  let next = drafts;
  if (line.kind === 'added') next = drafts.filter((_, index) => index !== at);
  else if (original && (line.kind === 'changed' || line.kind === 'renamed'))
    next = drafts.map((draft, index) =>
      index === at ? tokenDraft(oldName, original, draft.key) : draft,
    );
  else if (original && line.kind === 'removed') {
    const order = Object.keys(before.tokens[group]);
    const earlier = order.slice(0, order.indexOf(oldName)).reverse();
    const anchor = earlier
      .map((value) => drafts.findIndex((draft) => draft.name.trim() === value))
      .find((index) => index >= 0);
    const position = anchor === undefined ? 0 : anchor + 1;
    next = [...drafts.slice(0, position), tokenDraft(oldName, original), ...drafts.slice(position)];
  }
  return { ...model, tokens: { ...model.tokens, [group]: next } };
}

/** A color as red, green and blue from 0 to 255 and alpha from 0 to 1. */
export type Rgba = readonly [number, number, number, number];

const luminance = ([red, green, blue]: Rgba) => {
  const channel = (value: number) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
};
/** `top` painted over an opaque `bottom`. */
export const over = (top: Rgba, bottom: Rgba): Rgba => {
  const alpha = top[3];
  const mix = (index: 0 | 1 | 2) => top[index] * alpha + bottom[index] * (1 - alpha);
  return [mix(0), mix(1), mix(2), 1];
};
const WHITE: Rgba = [255, 255, 255, 1];

/** The WCAG contrast ratio of text in one color over another. A translucent color is painted first. */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const base = over(background, WHITE);
  const top = over(foreground, base);
  const [light, dark] = [luminance(top), luminance(base)].sort((left, right) => right - left) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The ratio as the swatch prints it. It rounds down, so a pair just under 4.5 never prints as
 * 4.5 and passes.
 */
export function contrastLabel(ratio: number): string {
  const shown = (Math.floor(ratio * 10) / 10).toFixed(1);
  return ratio >= 4.5 ? `${shown}:1 AA` : `${shown}:1 fails AA`;
}
