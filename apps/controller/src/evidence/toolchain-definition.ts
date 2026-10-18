import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, readFileSync, realpathSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  CandidateSchema,
  CrewKiteVerifyPreviewSchema,
  canonicalJson,
  HashSchema,
  NativeTargetPathSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { z } from 'zod';
import type { FileContent } from '../host/source.ts';
import {
  type CopyBudget,
  type DependencyInventory,
  inspectInstalledDependencies,
} from '../host/toolchain.ts';

export const toolchainWorkspaces = [
  'apps/controller',
  'apps/cli',
  'apps/desktop',
  'packages/contracts',
  'packages/client',
  'packages/testkit',
] as const;
export const verificationTarget = 'crewkite verify';
export const journeyTitle = 'desktop and CLI retain one checked task through handoff and restart';
export const verificationStages = [
  'policy',
  'lint',
  'types',
  'node-tests',
  'build',
  'desktop',
] as const;
const file = z.strictObject({
  path: NativeTargetPathSchema,
  mode: z.enum(['100644', '100755']),
  hash: HashSchema,
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(64 * 1024 * 1024),
});
const executable = z.strictObject({
  path: z.string().min(1).max(4096),
  version: z.string().min(1).max(200),
  sha256: HashSchema,
});
export const ToolchainDefinitionSchema = z.strictObject({
  recipeId: z.literal('crewkite-verify-v1'),
  candidateId: CandidateSchema.shape.id,
  candidateHash: HashSchema,
  definitionHash: HashSchema,
  evaluator: z.string().min(1).max(200),
  criteria: z.array(z.string().min(1).max(4096)).min(1).max(100),
  baseline: z.array(file).min(1).max(1000),
  baselineHash: HashSchema,
  inventory: z.strictObject({
    hash: HashSchema,
    bytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1024 * 1024),
  }),
  toolchainHash: HashSchema,
  lockHash: HashSchema,
  platform: z.literal('darwin'),
  arch: z.literal('arm64'),
  executables: z.strictObject({ node: executable, git: executable, electron: executable }),
  mkfifo: z.strictObject({ path: z.string().min(1).max(4096), sha256: HashSchema }),
  entrypoints: z.strictObject({
    biome: NativeTargetPathSchema,
    types: NativeTargetPathSchema,
    build: NativeTargetPathSchema,
    desktop: NativeTargetPathSchema,
    electron: NativeTargetPathSchema,
  }),
  collection: z
    .array(file.extend({ tests: z.array(z.string().min(1).max(4096)).min(1).max(100) }))
    .min(1)
    .max(100),
  journey: z.strictObject({
    file: z.literal('e2e/desktop.spec.ts'),
    title: z.literal(journeyTitle),
    hash: HashSchema,
  }),
  stages: z.tuple(
    verificationStages.map((stage) => z.literal(stage)) as [
      z.ZodLiteral<'policy'>,
      z.ZodLiteral<'lint'>,
      z.ZodLiteral<'types'>,
      z.ZodLiteral<'node-tests'>,
      z.ZodLiteral<'build'>,
      z.ZodLiteral<'desktop'>,
    ],
  ),
  provenancePattern: z.string().min(1).max(4096),
  maximumMinutes: z.literal(5),
});
export type ToolchainDefinition = z.infer<typeof ToolchainDefinitionSchema>;
export type ToolchainPreparation = {
  definition: ToolchainDefinition;
  inventory: DependencyInventory;
  inventoryBytes: Buffer;
};
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const metadata = ({ path, mode, hash, bytes }: FileContent) => ({ path, mode, hash, bytes });
const compare = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
export const nodeTestFile = (path: string) =>
  /^(?:apps|packages|scripts)\/.*\.test\.(?:ts|mjs)$/.test(path);

// A repository writer reads this before any check runs. Keep it in step with
// verificationCommand and frozenVerificationPath.
export const verificationGuidance = {
  checks: [
    'policy: node scripts/policy.mjs all',
    'lint: biome check . (formatting differences fail)',
    'types: tsc --noEmit',
    'node-tests: every committed *.test.ts and *.test.mjs under apps, packages and scripts',
    'build: electron-vite build in apps/desktop',
    'desktop: playwright test e2e/desktop.spec.ts',
  ],
  frozen: [
    '*.test.ts and *.test.mjs under apps, packages and scripts',
    'e2e/ and scripts/',
    'apps/controller/src/{host,evidence,providers,store,commands}/ and apps/controller/src/main.ts',
    'apps/desktop/src/{main,preload}/ and apps/desktop/electron.vite.config.ts',
    'packages/{testkit,contracts}/ and packages/client/src/node.ts',
    'every package.json',
    'root files other than *.md',
  ],
};

// The first recipe freezes the code which grades the candidate and enrolls child processes.
export function frozenVerificationPath(path: string): boolean {
  return (
    nodeTestFile(path) ||
    path.startsWith('e2e/') ||
    path.startsWith('scripts/') ||
    /^(?:apps\/controller\/src\/(?:host|evidence|providers|store|commands)\/|apps\/controller\/src\/main\.ts$|apps\/desktop\/src\/(?:main|preload)\/|packages\/(?:testkit|contracts)\/)/.test(
      path,
    ) ||
    path === 'apps/desktop/electron.vite.config.ts' ||
    path === 'packages/client/src/node.ts' ||
    /(?:^|\/)package\.json$/.test(path) ||
    (!path.includes('/') && !/\.md$/.test(path))
  );
}

function inside(root: string, path: string): string {
  const result = relative(root, path);
  if (!result || isAbsolute(result) || result === '..' || result.startsWith(`..${sep}`))
    throw Error('Verification tool is outside its installed closure.');
  return result.split(sep).join('/');
}
function check(budget: CopyBudget) {
  if (budget.signal?.aborted || budget.now() >= budget.deadline)
    throw Error('Verification preparation cancelled or expired.');
}
export async function executableHash(path: string, budget: CopyBudget): Promise<string> {
  check(budget);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const state = await handle.stat();
    if (!state.isFile() || !(state.mode & 0o111) || state.size > 512 * 1024 * 1024)
      throw Error('Verification executable is not a bounded regular executable.');
    const digest = createHash('sha256');
    let bytes = 0;
    while (true) {
      check(budget);
      const buffer = Buffer.allocUnsafe(256 * 1024);
      const count = (await handle.read(buffer, 0, buffer.length, null)).bytesRead;
      if (!count) break;
      bytes += count;
      if (bytes > state.size) throw Error('Verification executable changed.');
      digest.update(buffer.subarray(0, count));
      await setImmediate();
    }
    if (bytes !== state.size || (await handle.stat()).size !== state.size)
      throw Error('Verification executable changed.');
    return digest.digest('hex');
  } finally {
    await handle.close();
  }
}

export function toolchainDefinitionHash(
  value: Omit<ToolchainDefinition, 'definitionHash'>,
): string {
  return hashCanonical(value);
}
export function validToolchainDefinition(value: unknown): value is ToolchainDefinition {
  const parsed = ToolchainDefinitionSchema.safeParse(value);
  if (!parsed.success) return false;
  const { definitionHash, ...fields } = parsed.data;
  return (
    definitionHash === toolchainDefinitionHash(fields) &&
    fields.baselineHash === hashCanonical(fields.baseline) &&
    fields.collection.every(
      (entry, index, all) => index === 0 || compare(all[index - 1], entry) < 0,
    )
  );
}

export function verificationPreview(definition: ToolchainDefinition) {
  const { path: _node, ...node } = definition.executables.node;
  const { path: _git, ...git } = definition.executables.git;
  const { path: _electron, ...electron } = definition.executables.electron;
  return CrewKiteVerifyPreviewSchema.parse({
    toolchainHash: definition.toolchainHash,
    baselineHash: definition.baselineHash,
    lockHash: definition.lockHash,
    platform: definition.platform,
    arch: definition.arch,
    executables: { node, electron, git },
    stages: definition.stages,
    maximumMinutes: 5,
  });
}

export function assertVerificationSource(
  definition: ToolchainDefinition,
  source: readonly FileContent[],
  candidate: readonly FileContent[],
  runtimeRoot: string,
) {
  if (!validToolchainDefinition(definition)) throw Error('Verification definition changed.');
  const baseline = source
    .filter((entry) => frozenVerificationPath(entry.path))
    .map(metadata)
    .sort(compare);
  const actual = candidate
    .filter((entry) => frozenVerificationPath(entry.path))
    .map(metadata)
    .sort(compare);
  if (
    hashCanonical(baseline) !== definition.baselineHash ||
    hashCanonical(actual) !== definition.baselineHash
  )
    throw Error('The candidate changes its trusted verification baseline.');
  for (const entry of baseline) {
    const bytes = readFileSync(join(runtimeRoot, entry.path));
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.hash)
      throw Error('The committed verification helpers differ from the installed grader.');
  }
}

export async function prepareToolchain(input: {
  root: string;
  runtimeRoot: string;
  candidateId: string;
  candidateHash: string;
  source: readonly FileContent[];
  candidate: readonly FileContent[];
  criteria: string[];
  provenancePattern: string;
  git: string;
  budget: CopyBudget;
}): Promise<ToolchainPreparation> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw Error('This verification recipe requires macOS arm64.');
  const root = await realpath(input.root);
  const require = createRequire(join(root, 'package.json'));
  const desktopRequire = createRequire(join(root, 'apps/desktop/package.json'));
  const manifestEntry = (resolver: NodeRequire, name: string, key: string) => {
    const path = resolver.resolve(`${name}/package.json`);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[key];
    if (typeof bin !== 'string') throw Error('Installed verification entrypoint is missing.');
    return inside(root, realpathSync(resolve(dirname(path), bin)));
  };
  const electronManifest = desktopRequire.resolve('electron/package.json');
  const electronRoot = dirname(electronManifest);
  const electronVersion = JSON.parse(readFileSync(electronManifest, 'utf8')).version;
  const electronRelative = readFileSync(join(electronRoot, 'path.txt'), 'utf8');
  if (
    electronRelative !== 'Electron.app/Contents/MacOS/Electron' ||
    readFileSync(join(electronRoot, 'dist/version'), 'utf8') !== electronVersion
  )
    throw Error('Installed desktop payload is missing or changed.');
  const electron = inside(root, await realpath(join(electronRoot, 'dist', electronRelative)));
  const biomeRequire = createRequire(require.resolve('@biomejs/biome/package.json'));
  const biome = inside(
    root,
    realpathSync(
      join(dirname(biomeRequire.resolve('@biomejs/cli-darwin-arm64/package.json')), 'biome'),
    ),
  );
  const inventory = await inspectInstalledDependencies(root, toolchainWorkspaces, input.budget);
  const inventoryBytes = Buffer.from(canonicalJson(inventory));
  if (inventoryBytes.length > 64 * 1024 * 1024)
    throw Error('Toolchain inventory exceeds its bound.');
  const nodePath = await realpath(process.execPath);
  const gitPath = await realpath(input.git);
  const version = (
    await promisify(execFile)(gitPath, ['--version'], {
      timeout: Math.max(1, Math.min(5000, input.budget.deadline - input.budget.now())),
      signal: input.budget.signal,
      maxBuffer: 4096,
      env: { LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    })
  ).stdout.trim();
  const source = [...input.source].sort(compare);
  const collection = source
    .filter((entry) => nodeTestFile(entry.path))
    .map((entry) => ({
      ...metadata(entry),
      tests: [...entry.content.toString('utf8').matchAll(/^test\('([^'\n]+)'/gm)].map(
        (match) => match[1],
      ),
    }));
  const journey = source.find((entry) => entry.path === 'e2e/desktop.spec.ts');
  const lock = source.find((entry) => entry.path === 'pnpm-lock.yaml');
  if (!journey || !lock || !version.startsWith('git version '))
    throw Error('Verification source identity is missing.');
  const nodeHash = await executableHash(nodePath, input.budget);
  const fields: Omit<ToolchainDefinition, 'definitionHash'> = {
    recipeId: 'crewkite-verify-v1' as const,
    candidateId: input.candidateId,
    candidateHash: input.candidateHash,
    evaluator: `crewkite-verify-v1:node:${process.version}:${nodeHash}`,
    criteria: input.criteria,
    baseline: source.filter((entry) => frozenVerificationPath(entry.path)).map(metadata),
    baselineHash: hashCanonical(
      source.filter((entry) => frozenVerificationPath(entry.path)).map(metadata),
    ),
    inventory: { hash: hash(inventoryBytes), bytes: inventoryBytes.length },
    toolchainHash: inventory.hash,
    lockHash: lock.hash,
    platform: 'darwin' as const,
    arch: 'arm64' as const,
    executables: {
      node: { path: nodePath, version: process.version, sha256: nodeHash },
      git: { path: gitPath, version, sha256: await executableHash(gitPath, input.budget) },
      electron: {
        path: electron,
        version: electronVersion,
        sha256: await executableHash(join(root, electron), input.budget),
      },
    },
    mkfifo: {
      path: await realpath('/usr/bin/mkfifo'),
      sha256: await executableHash('/usr/bin/mkfifo', input.budget),
    },
    entrypoints: {
      biome,
      electron,
      types: manifestEntry(require, 'typescript', 'tsc'),
      build: manifestEntry(desktopRequire, 'electron-vite', 'electron-vite'),
      desktop: manifestEntry(require, '@playwright/test', 'playwright'),
    },
    collection,
    journey: { file: 'e2e/desktop.spec.ts' as const, title: journeyTitle, hash: journey.hash },
    stages: [...verificationStages] as [...typeof verificationStages],
    provenancePattern: input.provenancePattern,
    maximumMinutes: 5 as const,
  };
  const definition = ToolchainDefinitionSchema.parse({
    ...fields,
    definitionHash: toolchainDefinitionHash(fields),
  });
  assertVerificationSource(definition, source, input.candidate, input.runtimeRoot);
  check(input.budget);
  return { definition, inventory, inventoryBytes };
}
