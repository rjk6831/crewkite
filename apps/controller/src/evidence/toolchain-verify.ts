import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdir, realpath, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { hashCanonical } from '@crewkite/contracts/hash';
import {
  type CheckOwner,
  type CheckRoot,
  type CheckStage,
  enrollCheckRoot,
  inspectCheckRoots,
} from '../host/check-ownership.ts';
import { type FileContent, materialize } from '../host/source.ts';
import {
  type CopyBudget,
  copyInstalledDependencies,
  type DependencyInventory,
  inventoryTree,
  type TreeEntry,
  type TreeInventory,
} from '../host/toolchain.ts';
import { checkRootQuiescent } from '../host/worker.ts';
import {
  executableHash,
  type ToolchainDefinition,
  validToolchainDefinition,
  verificationStages,
} from './toolchain-definition.ts';

export type VerificationStage = {
  stage: CheckStage;
  commandHash: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  closed: boolean;
  stdout: string;
  stderr: string;
};
export type VerificationExecution = {
  version: 1;
  attemptId: string;
  generation: number;
  definitionHash: string;
  stages: VerificationStage[];
  roots: CheckRoot[];
  quiescent: boolean;
  unchanged: boolean;
  build: TreeInventory | null;
  failure: 'cancelled' | 'deadline' | 'identity' | 'stage' | 'ownership' | null;
};
type Invocation = { runtime: 'node' | 'git' | 'biome'; cwd: '.' | 'apps/desktop'; argv: string[] };
export function verificationCommand(
  definition: ToolchainDefinition,
  stage: CheckStage,
): Invocation {
  const preload = '--import=./apps/controller/src/host/check-ownership.ts';
  switch (stage) {
    case 'policy':
      return { runtime: 'node', cwd: '.', argv: [preload, 'scripts/policy.mjs', 'all'] };
    case 'lint':
      return { runtime: 'biome', cwd: '.', argv: ['check', '.'] };
    case 'types':
      return {
        runtime: 'node',
        cwd: '.',
        argv: [preload, definition.entrypoints.types, '--noEmit'],
      };
    case 'node-tests':
      return {
        runtime: 'node',
        cwd: '.',
        argv: [
          preload,
          '--test',
          '--test-concurrency=3',
          '--test-reporter=./apps/controller/src/evidence/reporter.ts',
          '--',
          ...definition.collection.map((file) => `./${file.path}`),
        ],
      };
    case 'build':
      return {
        runtime: 'node',
        cwd: 'apps/desktop',
        argv: [
          '--import=../../apps/controller/src/host/check-ownership.ts',
          `../../${definition.entrypoints.build}`,
          'build',
        ],
      };
    case 'desktop':
      return {
        runtime: 'node',
        cwd: '.',
        argv: [
          preload,
          definition.entrypoints.desktop,
          'test',
          'e2e/desktop.spec.ts',
          '--workers=1',
          '--retries=0',
          '--reporter=./apps/controller/src/evidence/desktop-reporter.ts',
          '--output=internal/test-results',
        ],
      };
  }
}

const same = (actual: unknown, expected: unknown) => {
  if (hashCanonical(actual) !== hashCanonical(expected))
    throw Error('Verification identity changed.');
};
const beneath = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
export class ToolchainVerification {
  readonly result: Promise<VerificationExecution>;
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    quiescent: boolean;
  }>;
  readonly closed: Promise<void>;
  private readonly abort = new AbortController();
  private readonly options: {
    definition: ToolchainDefinition;
    inventory: DependencyInventory;
    donor: string;
    directory: string;
    stateRoot: string;
    owner: CheckOwner;
    files: readonly FileContent[];
    deadline: number;
    now: () => number;
    onSpawn: (pid: number) => void;
    current: () => boolean;
  };
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private bytes = 0;
  private readonly stages: VerificationStage[] = [];
  private cancelled = false;
  private acknowledged = false;
  private journalReady = false;
  private readonly observedRoots = new Map<string, CheckRoot>();
  private readonly seenRoots = new Set<string>();
  private readonly unresolvedRoots = new Set<string>();

  constructor(options: ToolchainVerification['options']) {
    if (
      !Number.isFinite(options.deadline) ||
      options.deadline <= options.now() ||
      options.deadline - options.now() > 600000
    )
      throw Error('Verification needs one bounded ten-minute deadline.');
    this.options = options;
    this.result = Promise.resolve().then(() => this.run());
    this.exited = this.result.then((result) => ({
      code: result.failure === null ? 0 : 1,
      signal: null,
      quiescent: result.quiescent,
    }));
    this.closed = this.result.then(() => {});
  }
  stop() {
    this.cancelled = true;
    this.abort.abort();
  }
  private budget(final = false): CopyBudget {
    return {
      deadline: this.options.deadline - (final ? 0 : 10000),
      now: this.options.now,
      maximumEntries: 500000,
      maximumBytes: 8 * 1024 * 1024 * 1024,
      signal: this.abort.signal,
    };
  }
  private live(final = false) {
    if (
      this.abort.signal.aborted ||
      this.options.now() >= this.budget(final).deadline ||
      !this.options.current()
    )
      throw Error('Verification work cancelled or expired.');
  }
  private async installedIdentities(final = false) {
    const { definition } = this.options;
    this.live(final);
    for (const [name, identity] of Object.entries({
      node: definition.executables.node,
      git: definition.executables.git,
      mkfifo: definition.mkfifo,
    })) {
      if (name === 'node') same(await realpath(process.execPath), identity.path);
      same(await realpath(identity.path), identity.path);
      same(await executableHash(identity.path, this.budget(final)), identity.sha256);
    }
  }
  private async identities() {
    const { definition, directory } = this.options;
    await this.installedIdentities();
    same(
      await executableHash(join(directory, definition.entrypoints.electron), this.budget()),
      definition.executables.electron.sha256,
    );
    const node = await this.launch(
      { runtime: 'node', cwd: '.', argv: ['--version'] },
      'policy',
      false,
    );
    same(
      Buffer.from(node.stdout, 'base64').toString('utf8').trim(),
      definition.executables.node.version,
    );
    const git = await this.launch(
      { runtime: 'git', cwd: '.', argv: ['--version'] },
      'policy',
      false,
    );
    same(
      Buffer.from(git.stdout, 'base64').toString('utf8').trim(),
      definition.executables.git.version,
    );
  }
  private async launch(
    command: Invocation,
    stage: CheckStage,
    stageRoot: boolean,
  ): Promise<VerificationStage> {
    this.live();
    const { definition, directory, owner, stateRoot } = this.options;
    const context = { ...owner, stage };
    const ticket = enrollCheckRoot(stageRoot ? 'stage' : 'check', true, context);
    const outer = enrollCheckRoot('check', true);
    const executable =
      command.runtime === 'biome'
        ? join(directory, definition.entrypoints.biome)
        : definition.executables[command.runtime].path;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, command.argv, {
        cwd: resolve(directory, command.cwd),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: join(stateRoot, 'bin'),
          HOME: join(stateRoot, 'environment'),
          TMPDIR: join(stateRoot, 'temporary'),
          LANG: 'C',
          LC_ALL: 'C',
          TZ: 'UTC',
          CI: '1',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_LAZY_FETCH: '1',
          GIT_NO_REPLACE_OBJECTS: '1',
          PROVENANCE_PATTERN: definition.provenancePattern,
          CREWKITE_CHECK_JOURNEY: JSON.stringify(
            definition.journey && {
              file: definition.journey.file,
              title: definition.journey.title,
            },
          ),
          ...ticket.environment,
        },
      });
    } catch (error) {
      ticket.failed();
      outer.failed();
      throw error;
    }
    this.children.add(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let invalid = false;
    const closed = new Promise<VerificationStage>((done) => {
      child.once('error', () => {
        invalid = true;
      });
      child.once('close', (code, signal) => {
        this.children.delete(child);
        const receipt = {
          stage,
          commandHash: hashCanonical(command),
          code,
          signal,
          closed: true,
          stdout: Buffer.concat(out).toString('base64'),
          stderr: Buffer.concat(err).toString('base64'),
        };
        if (stageRoot) this.stages.push(receipt);
        done(receipt);
      });
    });
    for (const [stream, chunks] of [
      [child.stdout, out],
      [child.stderr, err],
    ] as const)
      stream.on('data', (chunk: Buffer) => {
        this.bytes += chunk.length;
        if (this.bytes > 16 * 1024 * 1024) {
          invalid = true;
          this.abort.abort();
          return;
        }
        chunks.push(chunk);
      });
    ticket.acknowledge(child);
    outer.acknowledge(child);
    if (child.pid && !this.acknowledged) {
      this.acknowledged = true;
      this.options.onSpawn(child.pid);
    }
    this.live();
    child.stdin.end();
    const result = await new Promise<VerificationStage>((done, reject) => {
      const timer = setTimeout(
        () => reject(Error('Verification stage exceeded its deadline.')),
        Math.max(1, this.budget().deadline - this.options.now()),
      );
      const stop = () => reject(Error('Verification stage cancelled.'));
      this.abort.signal.addEventListener('abort', stop, { once: true });
      if (this.abort.signal.aborted) stop();
      void closed.then(done);
      void closed.finally(() => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener('abort', stop);
      });
    });
    this.live();
    if (invalid || result.code !== 0 || result.signal !== null || !result.closed)
      throw Error('Verification stage did not close normally.');
    return result;
  }
  private inspect() {
    return inspectCheckRoots(this.options.owner);
  }
  private async cleanup(): Promise<boolean> {
    if (!this.journalReady && this.children.size === 0) return true;
    const end = this.options.deadline;
    const observed = this.observedRoots;
    const seen = this.seenRoots;
    const unresolved = this.unresolvedRoots;
    let inspectionFailed = false;
    const refresh = () => {
      try {
        const current = this.inspect();
        inspectionFailed = false;
        const names = new Set([...current.roots.map((root) => root.id), ...current.unresolved]);
        for (const id of seen) if (!names.has(id)) unresolved.add(id);
        for (const id of names) seen.add(id);
        for (const id of current.unresolved) unresolved.add(id);
        for (const root of current.roots) {
          const before = observed.get(root.id);
          if (
            before?.acknowledgment &&
            hashCanonical(before.acknowledgment) !== hashCanonical(root.acknowledgment)
          ) {
            unresolved.add(root.id);
            continue;
          }
          observed.set(root.id, root);
          unresolved.delete(root.id);
        }
      } catch {
        inspectionFailed = true;
      }
      return [...observed.values()];
    };
    const signal = (roots: CheckRoot[], value: NodeJS.Signals) => {
      for (const root of roots) {
        const ack = root.acknowledgment;
        if (!ack || checkRootQuiescent(root)) continue;
        try {
          process.kill(root.intent.detached ? -ack.group : ack.pid, value);
        } catch {}
      }
    };
    const waits = async (filter: (root: CheckRoot) => boolean, until: number) => {
      while (this.options.now() < Math.min(end, until)) {
        if (refresh().filter(filter).every(checkRootQuiescent)) return;
        await setImmediate();
      }
    };
    const groups = [
      (root: CheckRoot) =>
        root.intent.role !== 'stage' && root.intent.role !== 'electron' && root.intent.detached,
      (root: CheckRoot) => !root.intent.detached,
      (root: CheckRoot) => root.intent.role === 'electron',
      (root: CheckRoot) => root.intent.role === 'stage',
    ];
    for (const filter of groups) {
      signal(refresh().filter(filter), 'SIGTERM');
      await waits(filter, this.options.now() + 500);
      signal(refresh().filter(filter), 'SIGKILL');
      await waits(filter, this.options.now() + 500);
    }
    // A malformed acknowledgment still leaves the stage's returned handle locally owned.
    for (const child of this.children)
      if (child.pid)
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
    while (this.options.now() < end) {
      const roots = refresh();
      if (this.children.size === 0 && roots.every(checkRootQuiescent))
        return !inspectionFailed && unresolved.size === 0;
      await setImmediate();
    }
    return false;
  }
  private async unchanged(git: TreeInventory): Promise<{ build: TreeInventory }> {
    const { directory, files, inventory } = this.options;
    const tree = await inventoryTree(directory, this.budget(true));
    const actual = new Map(tree.entries.map((entry) => [entry.path, entry]));
    const expected = new Map<string, TreeEntry>();
    for (const entry of inventory.tree.entries) expected.set(entry.path, entry);
    for (const entry of git.entries)
      expected.set(entry.path === '.' ? '.git' : `.git/${entry.path}`, {
        ...entry,
        path: entry.path === '.' ? '.git' : `.git/${entry.path}`,
        ...(entry.kind === 'link' ? { resolved: `.git/${entry.resolved}` } : {}),
      } as TreeEntry);
    for (const [path, entry] of expected) same(actual.get(path), entry);
    const parents = new Set(['.']);
    for (const file of files) {
      const observed = actual.get(file.path);
      if (
        observed?.kind !== 'file' ||
        observed.hash !== file.hash ||
        observed.bytes !== file.bytes ||
        (observed.mode & 0o111 ? '100755' : '100644') !== file.mode
      )
        throw Error('Checked source changed.');
      let path = file.path;
      while (path.includes('/')) {
        path = path.slice(0, path.lastIndexOf('/'));
        parents.add(path);
      }
    }
    for (const entry of tree.entries) {
      if (
        expected.has(entry.path) ||
        files.some((file) => file.path === entry.path) ||
        (entry.kind === 'directory' && parents.has(entry.path))
      )
        continue;
      if (
        !(entry.path === 'internal' && entry.kind === 'directory') &&
        !beneath(entry.path, 'internal/test-results') &&
        !beneath(entry.path, 'apps/desktop/out')
      )
        throw Error('Verification produced an undeclared output.');
      if (entry.kind === 'link') throw Error('Verification output contains a symlink.');
    }
    const build = await inventoryTree(join(directory, 'apps/desktop/out'), this.budget(true));
    for (const path of ['main/index.js', 'preload/index.cjs', 'renderer/index.html'])
      if (
        !build.entries.some(
          (entry) => entry.path === path && entry.kind === 'file' && entry.bytes > 0,
        )
      )
        throw Error('The desktop build is incomplete.');
    return { build };
  }
  private async run(): Promise<VerificationExecution> {
    const { definition, directory, stateRoot, owner, files } = this.options;
    const result: VerificationExecution = {
      version: 1,
      attemptId: owner.attemptId,
      generation: owner.generation,
      definitionHash: definition.definitionHash,
      stages: this.stages,
      roots: [],
      quiescent: false,
      unchanged: false,
      build: null,
      failure: 'identity',
    };
    try {
      this.live();
      if (!validToolchainDefinition(definition)) throw Error('Verification definition changed.');
      await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
      await mkdir(directory, { mode: 0o700 });
      await mkdir(stateRoot, { mode: 0o700 });
      for (const path of ['environment', 'temporary', 'bin'])
        await mkdir(join(stateRoot, path), { mode: 0o700 });
      await mkdir(owner.directory, { mode: 0o700 });
      this.journalReady = true;
      materialize(directory, files);
      for (const [name, path] of Object.entries({
        node: definition.executables.node.path,
        git: definition.executables.git.path,
        mkfifo: definition.mkfifo.path,
      }))
        await symlink(path, join(stateRoot, 'bin', name));
      await this.installedIdentities();
      await this.launch(
        {
          runtime: 'git',
          cwd: '.',
          argv: ['-c', 'init.defaultBranch=main', 'init', '--quiet', '--template='],
        },
        'policy',
        false,
      );
      await this.launch(
        {
          runtime: 'git',
          cwd: '.',
          argv: [
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'core.attributesFile=/dev/null',
            '-c',
            'core.autocrlf=false',
            'add',
            '--force',
            '--all',
            '--',
            '.',
          ],
        },
        'policy',
        false,
      );
      const git = await inventoryTree(join(directory, '.git'), this.budget());
      await copyInstalledDependencies(
        this.options.donor,
        directory,
        this.options.inventory,
        this.budget(),
      );
      await this.identities();
      result.failure = 'stage';
      for (const stage of verificationStages)
        await this.launch(verificationCommand(definition, stage), stage, true);
      result.quiescent = await this.cleanup();
      if (!result.quiescent) throw Error('Verification ownership is unknown.');
      this.live(true);
      const checked = await this.unchanged(git);
      await this.installedIdentities(true);
      result.unchanged = true;
      result.build = checked.build;
      result.failure = null;
    } catch {
      if (this.cancelled) result.failure = 'cancelled';
      else if (this.options.now() >= this.budget().deadline) result.failure = 'deadline';
    } finally {
      if (!result.quiescent) result.quiescent = await this.cleanup();
      if (this.journalReady)
        try {
          const journal = this.inspect();
          result.roots = journal.roots;
          if (journal.unknown) result.quiescent = false;
        } catch {
          result.quiescent = false;
        }
      if (!result.quiescent) result.failure = 'ownership';
    }
    if (
      result.failure === null &&
      (this.abort.signal.aborted ||
        this.options.now() >= this.options.deadline ||
        !this.options.current())
    )
      result.failure = this.cancelled ? 'cancelled' : 'deadline';
    return result;
  }
}
