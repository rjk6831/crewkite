import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import {
  type CommandResult,
  DEPENDENCIES_NEED_PREPARATION,
  type DependencyLayout,
  type DependencyPreparation,
  type DependencyPreparationReason,
  preparationLine,
  type Task,
} from '@crewkite/contracts';
import { chatScratchDirectory } from '../chat/scratch-folder.ts';
import type { Store } from '../store/index.ts';
import { git } from './source.ts';
import {
  type CopyBudget,
  CopyLimitError,
  copyInstalledDependencies,
  type DependencyShape,
  InstalledIdentityError,
  inspectInstalledDependencies,
} from './toolchain.ts';

// Dependency preparation. A thread, a lane and an Accept candidate each run checks in their own
// writable copy, and that copy has no node_modules: scratch holds committed files only. Preparing
// copies the person's already installed tree into the copy, byte for byte, with no link back. It
// never runs an installer and never reaches the network. If the person's manifest, lockfile,
// workspace layout or Node runtime moves on, the copy is stale and stays unused until the person
// prepares it again.

/** Most bytes one copy may hold. A bigger tree fails before anything is kept. */
export const COPY_LIMIT_BYTES = 2 * 1024 ** 3;
// A tree with more entries than this is far past the byte limit for any real package set.
const MAX_ENTRIES = 2_000_000;
const DEADLINE_MS = 10 * 60_000;

type Inputs = DependencyPreparation['inputs'];
type Refusal = { state: 'unsupported'; reason: DependencyPreparationReason };

class Unsupported extends Error {
  readonly reason: DependencyPreparationReason;
  constructor(reason: DependencyPreparationReason) {
    super(reason);
    this.reason = reason;
  }
}

export type Detected = {
  layout: DependencyLayout;
  inputs: Inputs;
  workspaces: string[];
  shape: DependencyShape | null;
  refusal: Refusal | null;
};

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
const read = (path: string) => readFileSync(path, 'utf8');

/**
 * A Node module lookup walks every ancestor's node_modules and then NODE_PATH. A package that only
 * resolves because of either one would pass a check here and fail anywhere else. The first
 * ancestor that has a node_modules, or null when the path is clean.
 */
export function ancestorModules(directory: string): string | null {
  for (let parent = dirname(resolve(directory)); ; parent = dirname(parent)) {
    if (exists(join(parent, 'node_modules'))) return join(parent, 'node_modules');
    if (dirname(parent) === parent) return null;
  }
}

function patterns(yaml: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (start < 0) return [];
  const found: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(['"]?)(.+?)\1\s*(?:#.*)?$/.exec(line);
    if (!item) break;
    found.push(item[2]);
  }
  return found;
}

function expand(root: string, found: string[]): string[] {
  const paths = new Set<string>();
  for (const pattern of found) {
    if (pattern.startsWith('/') || pattern.split('/').includes('..'))
      throw new Unsupported('external-link');
    const clean = pattern.replace(/^\.\//, '').replace(/\/$/, '');
    if (clean.startsWith('!') || clean.includes('**') || /[?[\]{}]/.test(clean))
      throw new Unsupported('unsupported-layout');
    const star = clean.indexOf('*');
    const candidates: string[] = [];
    if (star < 0) candidates.push(clean);
    else if (clean.endsWith('/*') && clean.indexOf('*') === clean.length - 1) {
      const parent = clean.slice(0, -2);
      if (exists(join(root, parent)))
        for (const entry of readdirSync(join(root, parent)).sort())
          candidates.push(`${parent}/${entry}`);
    } else throw new Unsupported('unsupported-layout');
    for (const path of candidates) {
      if (path === '.' || !exists(join(root, path, 'package.json'))) continue;
      if (lstatSync(join(root, path)).isSymbolicLink()) throw new Unsupported('external-link');
      if (path.split('/').includes('node_modules')) continue;
      paths.add(path);
    }
  }
  return [...paths].sort();
}

/** What the pnpm lockfile resolved for each workspace's direct dependencies. Version 9 only. */
function pnpmResolved(lock: string): Map<string, Map<string, string>> {
  if (!/^lockfileVersion:\s*'?9\./m.test(lock)) throw new Unsupported('unsupported-layout');
  const result = new Map<string, Map<string, string>>();
  let importer: Map<string, string> | undefined;
  let importerPath = '.';
  let name = '';
  let inImporters = false;
  let inGroup = false;
  for (const line of lock.split('\n')) {
    if (/^\S/.test(line)) {
      inImporters = line.startsWith('importers:');
      continue;
    }
    if (!inImporters) continue;
    let match = /^ {2}(['"]?)(\S.*?)\1:\s*$/.exec(line);
    if (match) {
      importer = new Map();
      importerPath = match[2];
      result.set(importerPath, importer);
      inGroup = false;
      continue;
    }
    match = /^ {4}(dependencies|devDependencies|optionalDependencies):\s*$/.exec(line);
    if (match) {
      inGroup = match[1] !== 'optionalDependencies';
      continue;
    }
    if (/^ {4}\S/.test(line)) inGroup = false;
    match = /^ {6}(['"]?)(\S.*?)\1:\s*$/.exec(line);
    if (match && inGroup) name = match[2];
    match = /^ {8}version:\s*(\S+)/.exec(line);
    if (match && inGroup && importer && name) {
      const version = match[1].replace(/^['"]|['"]$/g, '');
      // pnpm writes link: for every workspace:* dependency, relative to its importer. One that
      // stays inside the project is a workspace package the copy carries as a link. One that
      // leaves it would make the copy depend on a folder outside the project.
      if (version.startsWith('link:')) {
        const target = posix.normalize(posix.join(importerPath, version.slice('link:'.length)));
        if (posix.isAbsolute(target) || target === '..' || target.startsWith('../'))
          throw new Unsupported('external-link');
        continue;
      }
      if (/^(file|portal):/.test(version)) throw new Unsupported('external-link');
      importer.set(name, version.replace(/\(.*$/, ''));
    }
  }
  return result;
}

function npmResolved(lock: string): Map<string, string> {
  const parsed = JSON.parse(lock);
  if (![2, 3].includes(parsed.lockfileVersion) || typeof parsed.packages !== 'object')
    throw new Unsupported('unsupported-layout');
  const versions = new Map<string, string>();
  for (const [key, value] of Object.entries<{ version?: string; link?: boolean }>(
    parsed.packages,
  )) {
    if (!key.startsWith('node_modules/') || key.indexOf('/node_modules/', 1) > 0) continue;
    if (value?.link) throw new Unsupported('external-link');
    if (typeof value?.version === 'string')
      versions.set(key.slice('node_modules/'.length), value.version);
  }
  return versions;
}

/**
 * Read the layout and the inputs of a project from its committed files. A project with no
 * dependencies is layout none. A layout the preparation cannot copy honestly carries its refusal.
 */
export function detectDependencies(
  root: string,
  runtime = `node@${process.versions.node}`,
  // A prepared copy has no .git, so only the person's project is asked what Git tracks.
  inGit = true,
): Detected {
  const base = {
    runtime,
    platform: process.platform,
    arch: process.arch,
    manifestDigests: {} as Record<string, string>,
    lockfileDigest: null as string | null,
    workspaceDigest: null as string | null,
    packageManager: null as string | null,
  };
  const done = (
    layout: DependencyLayout,
    workspaces: string[] = [],
    shape: DependencyShape | null = null,
    refusal: Refusal | null = null,
  ): Detected => ({ layout, inputs: base, workspaces, shape, refusal });
  const refuse = (reason: DependencyPreparationReason) =>
    done('unsupported', [], null, { state: 'unsupported', reason });
  if (!exists(join(root, 'package.json'))) return done('none');

  // Dependency trees tracked in Git cannot be told apart from the person's work, and a submodule
  // is source that lives outside this repository.
  const tracked = inGit ? git(root, ['ls-files', '--stage', '-z']).toString().split('\0') : [];
  for (const record of tracked) {
    const match = /^(\d{6}) [a-f0-9]+ [0-3]\t(.+)$/s.exec(record);
    if (!match) continue;
    if (match[2].split('/').includes('node_modules')) return refuse('tracked-dependency-root');
    if (match[1] === '160000') return refuse('unsupported-layout');
  }
  if (exists(join(root, '.gitmodules'))) return refuse('unsupported-layout');
  const yarnrc = exists(join(root, '.yarnrc.yml')) ? read(join(root, '.yarnrc.yml')) : '';
  if (
    exists(join(root, '.pnp.cjs')) ||
    exists(join(root, '.pnp.mjs')) ||
    /nodeLinker:\s*['"]?pnp/.test(yarnrc)
  )
    return refuse('yarn-pnp');

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(read(join(root, 'package.json')));
  } catch {
    return refuse('unsupported-layout');
  }
  if (manifest.workspaces !== undefined || exists(join(root, 'yarn.lock')))
    return refuse('unsupported-layout');

  const hasLock = exists(join(root, 'package-lock.json'));
  const hasPnpm = exists(join(root, 'pnpm-lock.yaml'));
  const hasWorkspace = exists(join(root, 'pnpm-workspace.yaml'));
  let workspaces: string[] = [];
  try {
    if (hasWorkspace) {
      const text = read(join(root, 'pnpm-workspace.yaml'));
      workspaces = expand(root, patterns(text));
      base.workspaceDigest = sha(JSON.stringify([sha(text), workspaces]));
    }
  } catch (error) {
    if (error instanceof Unsupported) return refuse(error.reason);
    throw error;
  }

  const manifests: Record<string, Record<string, unknown>> = { 'package.json': manifest };
  for (const path of workspaces) {
    try {
      manifests[`${path}/package.json`] = JSON.parse(read(join(root, path, 'package.json')));
    } catch {
      return refuse('unsupported-layout');
    }
  }
  let dependencies = 0;
  for (const [path, body] of Object.entries(manifests)) {
    base.manifestDigests[path] = sha(readFileSync(join(root, path)));
    for (const group of ['dependencies', 'devDependencies']) {
      const specs = body[group];
      if (!specs || typeof specs !== 'object') continue;
      for (const spec of Object.values(specs)) {
        dependencies++;
        if (typeof spec === 'string' && /^(link|file|portal):/.test(spec))
          return refuse('external-link');
      }
    }
  }
  if (dependencies === 0) return done('none');
  if (hasLock === hasPnpm) return refuse('unsupported-layout');
  if (hasWorkspace && !hasPnpm) return refuse('unsupported-layout');

  const lockfile = hasLock ? 'package-lock.json' : 'pnpm-lock.yaml';
  const lock = read(join(root, lockfile));
  base.lockfileDigest = sha(lock);
  const tool = hasLock ? 'npm' : 'pnpm';
  const declared = typeof manifest.packageManager === 'string' ? manifest.packageManager : '';
  const named = /^(npm|pnpm)@([0-9][0-9a-z.-]*)/.exec(declared);
  const version = /lockfileVersion['"]?:\s*['"]?([0-9.]+)/.exec(lock)?.[1] ?? 'unknown';
  base.packageManager = named?.[1] === tool ? `${tool}@${named[2]}` : `${tool}@lockfile-${version}`;

  try {
    let resolved: DependencyShape['resolved'];
    if (hasLock) {
      const versions = npmResolved(lock);
      resolved = (_workspace, name) => versions.get(name);
    } else {
      const importers = pnpmResolved(lock);
      resolved = (workspace, name) => importers.get(workspace)?.get(name);
    }
    const files = [
      'package.json',
      lockfile,
      ...(hasWorkspace ? ['pnpm-workspace.yaml'] : []),
      ...(exists(join(root, '.npmrc')) ? ['.npmrc'] : []),
    ];
    return done(hasWorkspace ? 'pnpm-workspace' : tool, workspaces, { files, resolved });
  } catch (error) {
    if (error instanceof Unsupported) return refuse(error.reason);
    return refuse('unsupported-layout');
  }
}

const CHANGED: Record<string, DependencyPreparationReason> = {
  runtime: 'stale-runtime',
  packageManager: 'stale-runtime',
  platform: 'stale-runtime',
  arch: 'stale-runtime',
  lockfileDigest: 'stale-lockfile',
  workspaceDigest: 'stale-workspace',
  manifestDigests: 'stale-manifest',
};
/** Every reason the inputs differ, one per kind, in the order of CHANGED. Empty when none does. */
export function staleReasons(saved: Inputs, current: Inputs): DependencyPreparationReason[] {
  const reasons = new Set<DependencyPreparationReason>();
  for (const [key, reason] of Object.entries(CHANGED))
    if (JSON.stringify(saved[key as keyof Inputs]) !== JSON.stringify(current[key as keyof Inputs]))
      reasons.add(reason);
  return [...reasons];
}

/** The first input that differs, as the reason a preparation is stale. Null when none does. */
export function staleReason(saved: Inputs, current: Inputs): DependencyPreparationReason | null {
  return staleReasons(saved, current)[0] ?? null;
}

/** Where each scope's writable copy lives under the controller home. */
export function scopeDirectory(
  home: string,
  taskId: string,
  scope: DependencyPreparation['scope'],
  scopeKey: string,
): string | null {
  if (scope === 'thread') return chatScratchDirectory(home, taskId);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(scopeKey)) return null;
  const folder = join(home, 'chat', taskId);
  return scope === 'lane'
    ? join(folder, 'slices', scopeKey, 'copy')
    : join(folder, `accept-${scopeKey}`);
}

export type DependencyHost = {
  store: Pick<Store, 'dependencyPreparations' | 'putDependencyPreparation' | 'get' | 'transaction'>;
  home: string;
  now: () => string;
  id: () => string;
  projectPath: (projectId: string) => string | undefined;
  runtime?: string;
  limitBytes?: number;
};

export type PreparedEnvironment =
  | { ok: true; directory: string; layout: DependencyLayout; env: { NODE_PATH: '' } }
  | { ok: false; reason: DependencyPreparationReason | 'not-prepared'; message: string };

const roots = (workspaces: string[]) => [
  'node_modules',
  ...workspaces.map((path) => `${path}/node_modules`),
];

export class DependencyPreparer {
  private readonly active = new Set<string>();
  private readonly host: DependencyHost;
  constructor(host: DependencyHost) {
    this.host = host;
  }

  private projectOf(taskId: string): string | undefined {
    const task = this.host.store.get<Task>('task', taskId);
    return task && this.host.projectPath(task.projectId);
  }

  /** A copy of this thread is being prepared now, so its folder has to stay until the copy ends. */
  preparing(taskId: string): boolean {
    return [...this.active].some((key) => key.startsWith(`${taskId}:`));
  }

  private find(taskId: string, scope: string, scopeKey: string) {
    return this.host.store
      .dependencyPreparations(taskId)
      .find((record) => record.scope === scope && record.scopeKey === scopeKey);
  }

  /** Copy the person's installed dependencies into one scope's directory and record the result. */
  async prepare(taskId: string, scope: DependencyPreparation['scope'], scopeKey: string) {
    const { store } = this.host;
    const key = `${taskId}:${scope}:${scopeKey}`;
    const project = this.projectOf(taskId);
    const target = scopeDirectory(this.host.home, taskId, scope, scopeKey);
    if (!project || !target || !existsSync(target)) return null;
    if (this.active.has(key)) return 'busy' as const;
    this.active.add(key);
    try {
      const earlier = this.find(taskId, scope, scopeKey);
      const id = earlier?.id ?? this.host.id();
      const limitBytes = this.host.limitBytes ?? COPY_LIMIT_BYTES;
      const detected = detectDependencies(project, this.host.runtime);
      const record = (patch: Partial<DependencyPreparation>): DependencyPreparation => {
        const next: DependencyPreparation = {
          id,
          taskId,
          scope,
          scopeKey,
          state: 'preparing',
          layout: detected.layout,
          inputs: detected.inputs,
          treeDigest: null,
          bytes: null,
          limitBytes,
          reason: null,
          preparedAt: null,
          ...patch,
        };
        store.transaction(() => store.putDependencyPreparation(next, this.host.now()));
        return next;
      };
      const stop = (
        state: 'failed' | 'unsupported' | 'stale',
        reason: DependencyPreparationReason,
      ) => record({ state, reason });

      if (detected.refusal) return stop('unsupported', detected.refusal.reason);
      if (detected.layout === 'none')
        return record({ state: 'prepared', preparedAt: this.host.now() });
      // A previous copy is ours: only this command writes dependency roots in a prepared scope.
      for (const path of roots(detected.workspaces))
        rmSync(join(target, path), { recursive: true, force: true });
      if (ancestorModules(target)) return stop('failed', 'copy-failed');

      // The scope's own manifests and lockfile come from the committed base. If they differ from
      // the project's, the installed tree does not belong to this copy.
      // Both sides are read on this host, so only the package manager can differ among the runtime
      // inputs, and it follows from the manifest and the lockfile. Every other difference counts,
      // so a runtime-class difference never hides a lockfile or manifest one behind it.
      const there = detectDependencies(target, this.host.runtime, false);
      const moved = staleReasons(there.inputs, detected.inputs).find(
        (reason) => reason !== 'stale-runtime',
      );
      if (moved) return stop('stale', moved);

      record({});
      const now = () => Date.now();
      const budget: CopyBudget = {
        deadline: now() + DEADLINE_MS,
        now,
        maximumEntries: MAX_ENTRIES,
        maximumBytes: limitBytes,
      };
      const shape = detected.shape as DependencyShape;
      try {
        const inventory = await inspectInstalledDependencies(
          project,
          detected.workspaces,
          budget,
          shape,
        );
        if (inventory.tree.entries.some((entry) => entry.path.endsWith('/binding.gyp')))
          return stop('unsupported', 'native-addon');
        const copied = await copyInstalledDependencies(project, target, inventory, budget, shape);
        return record({
          state: 'prepared',
          treeDigest: copied.tree.hash,
          bytes: copied.tree.bytes,
          preparedAt: this.host.now(),
        });
      } catch (error) {
        // Nothing partial stays: a half copy would look installed to the next check.
        for (const path of roots(detected.workspaces))
          rmSync(join(target, path), { recursive: true, force: true });
        if (error instanceof CopyLimitError) return stop('failed', 'size-limit');
        if (error instanceof InstalledIdentityError) return stop('stale', 'stale-lockfile');
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return stop('failed', 'not-installed');
        return stop('failed', 'copy-failed');
      }
    } finally {
      this.active.delete(key);
    }
  }

  /**
   * The one call Accept, the after-write gate and lane checks make before they run anything in a
   * copy. It says where to run and what to clear, or why not. A prepared record whose inputs moved
   * is marked stale here, so the reason is kept for the next reader.
   */
  environment(
    taskId: string,
    scope: DependencyPreparation['scope'],
    scopeKey: string,
  ): PreparedEnvironment {
    const project = this.projectOf(taskId);
    const directory = scopeDirectory(this.host.home, taskId, scope, scopeKey);
    if (!project || !directory)
      return { ok: false, reason: 'not-prepared', message: DEPENDENCIES_NEED_PREPARATION };
    const current = detectDependencies(project, this.host.runtime);
    const saved = this.find(taskId, scope, scopeKey);
    if (!saved && current.layout === 'none')
      return { ok: true, directory, layout: 'none', env: { NODE_PATH: '' } };
    if (!saved)
      return { ok: false, reason: 'not-prepared', message: DEPENDENCIES_NEED_PREPARATION };
    if (saved.state !== 'prepared')
      return { ok: false, reason: saved.reason ?? 'not-prepared', message: preparationLine(saved) };
    const moved = current.refusal
      ? current.refusal.reason
      : staleReason(saved.inputs, current.inputs);
    const stale = moved ?? (saved.layout !== current.layout ? 'stale-workspace' : null);
    if (stale) {
      const record: DependencyPreparation = current.refusal
        ? { ...saved, state: 'unsupported', reason: stale }
        : { ...saved, state: 'stale', reason: stale };
      this.host.store.transaction(() =>
        this.host.store.putDependencyPreparation(record, this.host.now()),
      );
      return { ok: false, reason: stale, message: preparationLine(record) };
    }
    const missing =
      saved.layout !== 'none' &&
      roots(current.workspaces).some((path) => !exists(join(directory, path)));
    if (missing || ancestorModules(directory))
      return {
        ok: false,
        reason: missing ? 'not-installed' : 'copy-failed',
        message: DEPENDENCIES_NEED_PREPARATION,
      };
    // shortcut: the copy's tree is not re-hashed on every call. Upgrade: compare treeDigest before Accept.
    return { ok: true, directory, layout: saved.layout, env: { NODE_PATH: '' } };
  }

  read(taskId: string, scope?: DependencyPreparation['scope'], scopeKey?: string) {
    return this.host.store
      .dependencyPreparations(taskId)
      .filter(
        (record) =>
          (!scope || record.scope === scope) && (!scopeKey || record.scopeKey === scopeKey),
      );
  }
}

/**
 * Runs one dependency command. `refusal` says why the thread's copies are in use, and a prepare
 * asks it before it removes anything: a turn, a check or an Accept could be running there.
 */
export async function dependenciesCommand(
  preparer: DependencyPreparer,
  hasTask: (taskId: string) => boolean,
  refusal: (taskId: string) => CommandResult | null,
  command:
    | {
        command: 'PrepareDependencies';
        payload: { taskId: string; scope: DependencyPreparation['scope']; scopeKey: string };
      }
    | {
        command: 'ReadDependencyPreparation';
        payload: { taskId: string; scope?: DependencyPreparation['scope']; scopeKey?: string };
      },
): Promise<CommandResult> {
  const { taskId } = command.payload;
  if (!hasTask(taskId)) return { outcome: 'blocked', reason: 'task-not-found' };
  if (command.command === 'ReadDependencyPreparation')
    return {
      outcome: 'applied',
      data: {
        kind: 'dependency-preparations',
        taskId,
        preparations: preparer.read(taskId, command.payload.scope, command.payload.scopeKey),
      },
    };
  const refused = refusal(taskId);
  if (refused) return refused;
  const result = await preparer.prepare(taskId, command.payload.scope, command.payload.scopeKey);
  if (result === 'busy')
    return {
      outcome: 'blocked',
      reason: 'preparing',
      next: 'Dependencies are being prepared for this copy.',
    };
  if (!result)
    return {
      outcome: 'blocked',
      reason: 'copy-missing',
      next: 'This copy does not exist yet. Start the work that creates it first.',
    };
  return {
    outcome: 'applied',
    data: { kind: 'dependency-preparations', taskId, preparations: [result] },
  };
}
