import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { CopyBudget } from '../apps/controller/src/host/toolchain.ts';
import { copyRuntimeStore, type StorePackage } from './runtime-packages.ts';

// The CLI's terminal interface in the package: Ink and React in a private store under apps/cli,
// and the renderer modules the interactive views import. All of it is plain JavaScript and
// TypeScript that the packaged Node runs as it is; nothing is built or native.

/**
 * Ink 8.0.0, React 19.3.1 and their closure, pinned by version, edges and license file. ansi-styles
 * appears twice: Ink takes 7.0.0 and the text helpers take 6.2.3. yoga-layout publishes no license
 * file, so its MIT text comes from its upstream repository at the matching tag, recorded in
 * docs/credits.md. type-fest is MIT or CC0; the MIT text ships.
 */
export const cliRuntimePackages: StorePackage[] = [
  {
    name: '@alcalzone/ansi-tokenize',
    version: '0.3.1',
    edges: ['ansi-styles', 'is-fullwidth-code-point'],
    license: 'LICENSE',
  },
  { name: 'ansi-escapes', version: '7.3.0', edges: ['environment'], license: 'license' },
  { name: 'ansi-regex', version: '6.4.0', edges: [], license: 'license' },
  { name: 'ansi-styles', version: '6.2.3', edges: [], license: 'license' },
  { name: 'ansi-styles', version: '7.0.0', edges: [], license: 'license' },
  { name: 'auto-bind', version: '5.0.1', edges: [], license: 'license' },
  { name: 'chalk', version: '6.0.1', edges: [], license: 'license' },
  { name: 'cli-boxes', version: '4.0.1', edges: [], license: 'license' },
  { name: 'cli-cursor', version: '4.0.0', edges: ['restore-cursor'], license: 'license' },
  {
    name: 'cli-truncate',
    version: '6.1.1',
    edges: ['slice-ansi', 'string-width'],
    license: 'license',
  },
  { name: 'code-excerpt', version: '4.0.0', edges: ['convert-to-spaces'], license: 'license' },
  { name: 'convert-to-spaces', version: '2.0.1', edges: [], license: 'license' },
  { name: 'environment', version: '1.1.0', edges: [], license: 'license' },
  { name: 'es-toolkit', version: '1.53.0', edges: [], license: 'LICENSE' },
  { name: 'escape-string-regexp', version: '2.0.0', edges: [], license: 'license' },
  { name: 'get-east-asian-width', version: '1.7.0', edges: [], license: 'license' },
  { name: 'indent-string', version: '5.0.0', edges: [], license: 'license' },
  {
    name: 'ink',
    version: '8.0.0',
    edges: [
      '@alcalzone/ansi-tokenize',
      'ansi-escapes',
      'ansi-styles',
      'auto-bind',
      'chalk',
      'cli-boxes',
      'cli-cursor',
      'cli-truncate',
      'code-excerpt',
      'es-toolkit',
      'indent-string',
      'is-in-ci',
      'patch-console',
      'quick-lru',
      'react',
      'react-reconciler',
      'signal-exit',
      'stack-utils',
      'string-width',
      'terminal-size',
      'type-fest',
      'widest-line',
      'wrap-ansi',
      'yoga-layout',
    ],
    optionalPeers: ['@types/react', 'react-devtools-core'],
    license: 'license',
  },
  {
    name: 'is-fullwidth-code-point',
    version: '5.1.0',
    edges: ['get-east-asian-width'],
    license: 'license',
  },
  { name: 'is-in-ci', version: '2.0.0', edges: [], license: 'license' },
  { name: 'mimic-fn', version: '2.1.0', edges: [], license: 'license' },
  { name: 'onetime', version: '5.1.2', edges: ['mimic-fn'], license: 'license' },
  { name: 'patch-console', version: '2.0.0', edges: [], license: 'license' },
  { name: 'quick-lru', version: '7.3.0', edges: [], license: 'license' },
  { name: 'react', version: '19.3.1', edges: [], license: 'LICENSE' },
  {
    name: 'react-reconciler',
    version: '0.34.0',
    edges: ['react', 'scheduler'],
    license: 'LICENSE',
  },
  {
    name: 'restore-cursor',
    version: '4.0.0',
    edges: ['onetime', 'signal-exit'],
    license: 'license',
  },
  { name: 'scheduler', version: '0.28.0', edges: [], license: 'LICENSE' },
  { name: 'signal-exit', version: '3.0.7', edges: [], license: 'LICENSE.txt' },
  {
    name: 'slice-ansi',
    version: '9.0.1',
    edges: ['ansi-styles', 'is-fullwidth-code-point'],
    license: 'license',
  },
  { name: 'stack-utils', version: '2.0.6', edges: ['escape-string-regexp'], license: 'LICENSE.md' },
  {
    name: 'string-width',
    version: '8.3.0',
    edges: ['get-east-asian-width', 'strip-ansi'],
    license: 'license',
  },
  { name: 'strip-ansi', version: '7.2.0', edges: ['ansi-regex'], license: 'license' },
  { name: 'tagged-tag', version: '1.0.0', edges: [], license: 'license' },
  { name: 'terminal-size', version: '4.0.1', edges: [], license: 'license' },
  { name: 'type-fest', version: '5.10.0', edges: ['tagged-tag'], license: 'license-mit' },
  { name: 'widest-line', version: '6.0.0', edges: ['string-width'], license: 'license' },
  {
    name: 'wrap-ansi',
    version: '10.0.2',
    edges: ['ansi-styles', 'string-width'],
    license: 'license',
  },
  {
    name: 'yoga-layout',
    version: '3.2.1',
    edges: [],
    license: 'LICENSE',
    notice: 'scripts/notices/yoga-layout-3.2.1-LICENSE',
  },
];

const importPattern =
  /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\sfrom\s+)?'(\.{1,2}\/[^']+)'|import\('(\.{1,2}\/[^']+)'\)/g;

/**
 * The renderer files the CLI loads at run time: every relative import reachable from the CLI's
 * entry that lands in apps/desktop/src, following value imports only, since Node drops
 * `import type` when it strips the types.
 */
export function cliRendererModules(source: string): string[] {
  const root = resolve(source);
  const desktop = join(root, 'apps/desktop/src');
  const seen = new Set<string>();
  const queue = [join(root, 'apps/cli/src/main.ts')];
  while (queue.length) {
    const file = queue.shift();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(importPattern)) {
      if (match[1]) continue;
      const target = resolve(dirname(file), match[2] ?? match[3]);
      if (!target.endsWith('.ts')) continue;
      if (target.startsWith(`${desktop}/`) || target.startsWith(`${join(root, 'apps/cli/src')}/`))
        queue.push(target);
    }
  }
  return [...seen]
    .filter((file) => file.startsWith(`${desktop}/`))
    .map((file) => relative(root, file))
    .sort();
}

/** Copies the CLI's store and renderer modules into a staged runtime. */
export async function stageCliRuntime(options: {
  source: string;
  runtime: string;
  budget: CopyBudget;
}) {
  const packages = await copyRuntimeStore({
    source: options.source,
    from: 'apps/cli/package.json',
    destination: join(options.runtime, 'apps/cli'),
    realm: '.cli-store',
    roots: ['ink', 'react'],
    packages: cliRuntimePackages,
    budget: options.budget,
  });
  const modules = cliRendererModules(options.source);
  for (const path of modules) {
    mkdirSync(dirname(join(options.runtime, path)), { recursive: true });
    cpSync(join(options.source, path), join(options.runtime, path), {
      errorOnExist: true,
      force: false,
    });
  }
  return { packages, modules };
}
