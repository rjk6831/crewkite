import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { z } from 'zod';

// A compact outline of the project for models with a small context window: one line per file,
// one line per exported symbol, most-imported files first. Per-language regexes keep it free of
// parser dependencies. They miss some declarations, and a missed symbol costs the model one
// search call.

export type RepoMapInput = Readonly<{
  base: string;
  files: readonly { path: string; bytes: number }[];
  /** Reads a listed file. The caller confines paths to its own tree. */
  read(path: string): string;
  budgetTokens: number;
}>;
export type RepoMap = Readonly<{
  base: string;
  text: string;
  tokens: number;
  shown: number;
  omitted: number;
}>;
/** One file and its symbol lines, already ranked. Cached per base; the budget cut is cheap. */
export type RepoOutline = readonly (readonly string[])[];

const SOURCE_BYTES = 200 * 1024;
const SIGNATURE_CHARS = 100;
const SYMBOLS_PER_FILE = 24;
const CHARS_PER_TOKEN = 4;

export const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

// Each rule matches one top-level declaration line. `kind` and `name` are named groups.
const js = [
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?<kind>function\*?|class|interface|type|const|let|var|enum|namespace)\s+(?<name>[A-Za-z_$][\w$]*)/d,
];
const RULES: Record<string, readonly RegExp[]> = {
  ts: js,
  tsx: js,
  js,
  mjs: js,
  // A leading underscore marks a private name in Python, so the name must start with a letter.
  py: [/^(?:async\s+)?(?<kind>def|class)\s+(?<name>[A-Za-z]\w*)/d],
  go: [
    /^(?<kind>func)\s+(?:\([^)]*\)\s*)?(?<name>[A-Z]\w*)/d,
    /^(?<kind>type|var|const)\s+(?<name>[A-Z]\w*)/d,
  ],
  rs: [
    /^pub(?:\([^)]*\))?\s+(?:(?:async|unsafe|const|extern\s+"[^"]*")\s+)*(?<kind>fn|struct|enum|trait|type|const|static|mod|union)\s+(?<name>\w+)/d,
  ],
  java: [
    /^public\s+(?:(?:static|final|abstract|sealed|non-sealed|strictfp)\s+)*(?<kind>class|interface|enum|record|@interface)\s+(?<name>\w+)/d,
  ],
  kt: [
    /^(?:public\s+)?(?:(?:data|sealed|abstract|open|enum|inline|value|annotation|suspend|inner|operator|infix|tailrec|const|lateinit)\s+)*(?<kind>fun|class|interface|object|val|var|typealias)\s+(?:<[^>]*>\s*)?(?<name>[\w.]+)/d,
  ],
  swift: [
    /^(?:public|open)\s+(?:(?:final|static|class|mutating|indirect)\s+)*(?<kind>func|class|struct|enum|protocol|typealias|let|var|actor|extension)\s+(?<name>\w+)/d,
  ],
  rb: [/^\s{0,2}(?<kind>class|module|def)\s+(?<name>(?:self\.)?[\w:]+[?!=]?)/d],
  // C# types usually sit one level inside a namespace block.
  cs: [
    /^\s{0,4}public\s+(?:(?:static|sealed|abstract|partial|readonly|unsafe|ref)\s+)*(?<kind>class|interface|enum|struct|record)\s+(?<name>\w+)/d,
  ],
};

// Relative imports only. Package imports cannot be resolved without a build tool.
const IMPORTS: Record<string, readonly RegExp[]> = {
  js: [/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"\n]+)['"]/g],
  py: [/^\s*from\s+(\.+[\w.]*)\s+import\b/gm],
  rs: [/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm],
  rb: [/\brequire_relative\s*\(?\s*['"]([^'"\n]+)['"]/g],
};
const importRules = (extension: string) =>
  ['ts', 'tsx', 'js', 'mjs'].includes(extension) ? IMPORTS.js : (IMPORTS[extension] ?? []);

const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
};
const stemOf = (path: string) => {
  const extension = extensionOf(path);
  return extension ? path.slice(0, -extension.length - 1) : path;
};

function signature(lines: readonly string[], index: number, start: number) {
  let text = lines[index].slice(start);
  // Join continuation lines while a parameter list is open, so short signatures read whole.
  for (let next = index + 1; next < lines.length && next <= index + 4; next++) {
    const open = (text.match(/\(/g) ?? []).length - (text.match(/\)/g) ?? []).length;
    if (open <= 0 || text.length >= SIGNATURE_CHARS) break;
    text += ` ${lines[next].trim()}`;
  }
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s*[{;:]?\s*$/, '')
    .slice(0, SIGNATURE_CHARS);
}

function symbols(path: string, content: string) {
  const rules = RULES[extensionOf(path)];
  if (!rules) return [];
  const lines = content.split(/\r?\n/);
  const found: string[] = [];
  lines.forEach((line, index) => {
    for (const rule of rules) {
      const match = rule.exec(line);
      const name = match?.indices?.groups?.name;
      if (!match?.groups || !name) continue;
      found.push(`  ${match.groups.kind} ${signature(lines, index, name[0])}`);
      return;
    }
  });
  if (found.length <= SYMBOLS_PER_FILE) return found;
  return [
    ...found.slice(0, SYMBOLS_PER_FILE),
    `  ... ${found.length - SYMBOLS_PER_FILE} more symbols`,
  ];
}

function resolveImport(importer: string, specifier: string, extension: string) {
  const directory = posix.dirname(importer);
  let target: string;
  if (extension === 'py') {
    const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
    const module = specifier.slice(dots).replaceAll('.', '/');
    if (!module) return null;
    target = posix.join(directory, '../'.repeat(dots - 1), module);
  } else target = posix.join(directory, specifier);
  target = posix.normalize(target);
  if (target === '..' || target.startsWith('../')) return null;
  // ESM sources import `./file.js` for `file.ts`; matching on the stem covers both.
  return stemOf(target);
}

/** Rank files by how many other files import them, then by path. Reads only small source files. */
export function outlineRepo(input: Pick<RepoMapInput, 'files' | 'read'>): RepoOutline {
  const byStem = new Map<string, string[]>();
  for (const { path } of input.files) {
    for (const stem of [stemOf(path), stemOf(path).replace(/\/(index|mod|__init__)$/, '')]) {
      const list = byStem.get(stem) ?? [];
      if (!list.includes(path)) list.push(path);
      byStem.set(stem, list);
    }
  }
  const importers = new Map<string, Set<string>>();
  const lines = new Map<string, string[]>();
  for (const file of input.files) {
    const extension = extensionOf(file.path);
    if (!RULES[extension] || file.bytes > SOURCE_BYTES) continue;
    let content: string;
    try {
      content = input.read(file.path);
    } catch {
      // An unreadable file still gets its path line.
      continue;
    }
    lines.set(file.path, symbols(file.path, content));
    for (const rule of importRules(extension)) {
      for (const match of content.matchAll(rule)) {
        const stem = resolveImport(file.path, match[1], extension);
        for (const target of (stem && byStem.get(stem)) || []) {
          if (target === file.path) continue;
          const set = importers.get(target) ?? new Set<string>();
          set.add(file.path);
          importers.set(target, set);
        }
      }
    }
  }
  const inbound = (path: string) => importers.get(path)?.size ?? 0;
  return [...input.files]
    .map((file) => file.path)
    .sort((a, b) => inbound(b) - inbound(a) || (a < b ? -1 : a > b ? 1 : 0))
    .map((path) => [path, ...(lines.get(path) ?? [])]);
}

/** Keep whole file blocks in rank order until the budget is spent, and say what was left out. */
export function cutRepoMap(base: string, outline: RepoOutline, budgetTokens: number): RepoMap {
  const note = (count: number) => `(${count} more files not shown. Use search to find them.)\n`;
  const reserve = estimateTokens(note(outline.length));
  let text = '';
  let shown = 0;
  for (const block of outline) {
    const next = `${text}${block.join('\n')}\n`;
    if (estimateTokens(next) + reserve > budgetTokens) continue;
    text = next;
    shown++;
  }
  const omitted = outline.length - shown;
  if (omitted) text += note(omitted);
  return { base, text, tokens: estimateTokens(text), shown, omitted };
}

export function buildRepoMap(input: RepoMapInput): RepoMap {
  return cutRepoMap(input.base, outlineRepo(input), input.budgetTokens);
}

const CacheSchema = z.object({
  version: z.literal(1),
  base: z.string(),
  outline: z.array(z.array(z.string()).min(1)),
});

/**
 * Build the map once per base commit. The ranked outline is cached as JSON under `directory`,
 * keyed by base, and cut to the caller's budget on every call, since models differ in context.
 * A missing or unreadable cache file only costs a rebuild.
 */
export function cachedRepoMap(directory: string, input: RepoMapInput): RepoMap {
  if (!/^[a-f0-9]{7,64}$/.test(input.base)) throw new Error('The base commit is not a hash.');
  const file = join(directory, `${input.base}.json`);
  let outline: RepoOutline | null = null;
  try {
    const cached = CacheSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (cached.base === input.base) outline = cached.outline;
  } catch {}
  if (!outline) {
    outline = outlineRepo(input);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, base: input.base, outline }), {
        mode: 0o600,
      });
      renameSync(temporary, file);
    } catch {}
  }
  return cutRepoMap(input.base, outline, input.budgetTokens);
}
