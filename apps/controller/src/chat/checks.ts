import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import {
  type Artifact,
  ArtifactSchema,
  CHECK_RUNS_KEPT,
  CHECK_TAIL_CHARACTERS,
  type ChatCheck,
  type ChatCheckRun,
  type ChatChecksEdit,
  type ChatChecksState,
  type ChatThread,
  canonicalJson,
  ProjectCommandPreviewSchema,
  type Task,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import type { ArtifactFiles } from '../artifacts/index.ts';
import { liveOperations } from '../commands/live-operations.ts';
import { OperationStore } from '../commands/operation-store.ts';
import { createOwnedProjectCommandRunner } from '../commands/owned-runner.ts';
import {
  type OwnedProjectCommandRunner,
  type ProjectCommandDefinition,
  type ProjectCommandRecipeName,
  startProjectCommand,
} from '../commands/project-command.ts';
import { executablePin } from '../commands/task-operations.ts';
import {
  hashCandidateFiles,
  inspectSource,
  type ScratchPlan,
  scratchPlan,
} from '../host/source.ts';
import { defaultSchedule, type Schedule } from '../host/worker.ts';
import { createIds } from '../store/ids.ts';
import type { LaunchIdentity, Store } from '../store/index.ts';
import { redact } from './thread-reader.ts';

// Project checks in the loop (ADR 0038 chain, ADR 0002 authority). The controller detects the
// checks and the person switches them on. A run needs the person's answer to a permission
// question unless Glide's policy already covers commands and nothing changed since the switch.
// A check runs without a shell: the controller finds the program on PATH and pins its bytes
// before every run, and records the process in the operation journal like any project command.
// A command the person adds cannot start a shell or a wrapper, run inline code or name a file
// outside the scratch copy. Output lands in the artifact store. A check that changes the files
// Accept would publish cannot pass.

export type DetectedCheck = Pick<
  ChatCheck,
  'id' | 'label' | 'kind' | 'source' | 'command' | 'resolved'
>;

const MAX_ITEMS = 16;
/** The most bytes a check reads from one file. A larger file reads as absent. */
export const FILE_BYTES = 1024 * 1024;
const DEADLINE_MS = 10 * 60_000;
// The checks after one writing turn, or after a plan merges a slice, run one after another, so two
// slow commands could hold the thread for twenty minutes. They stop at fifteen in all.
const GATE_MS = 15 * 60_000;
const GATE_OVER =
  'The checks after this turn reached their 15-minute total, so this one did not finish.';
const MERGE_OVER =
  'The checks after this merge reached their 15-minute total, so this one did not finish.';
// The newest output kept in memory for the fix message. The card keeps less.
const KEPT_BYTES = 12 * 1024;
const BRIEF_CHARACTERS = 12_000;
const PLAIN_WORD = /^[A-Za-z0-9._/=:,+@%-]+$/;
const SHELLS = new Set(['bash', 'cmd', 'dash', 'fish', 'ksh', 'powershell', 'pwsh', 'sh', 'zsh']);
// Programs that start another program, fetch code or hand the line to a shell.
const WRAPPERS = new Set([
  'env',
  'nice',
  'nohup',
  'time',
  'timeout',
  'xargs',
  'sudo',
  'doas',
  'command',
  'exec',
  'setsid',
  'stdbuf',
  'busybox',
  'npx',
  'pnpx',
  'bunx',
]);
const INTERPRETERS = new Set([
  'node',
  'nodejs',
  'python',
  'python3',
  'ruby',
  'perl',
  'php',
  'bun',
  'deno',
]);
const INLINE_FLAG = /^(--eval|--print)(=.*)?$|^-[a-zA-Z]*[ecpE][a-zA-Z]*$/;
// Programs that run a package.json script a word names.
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
export const ADDED_RULE =
  'Name a program on PATH and files inside the scratch copy. Shells, wrappers such as env, inline code such as node -e and paths outside the copy are refused.';
const UNCONFIRMED =
  'CrewKite could not confirm the process exited. It checks again before the next turn.';
const AFTER_UNCONFIRMED =
  'A check before this one may still be running in the copy, so this one did not start.';
/** The reason a run carries when the check changed files Accept would publish. */
export const CHANGED_FILES =
  'This check changed files in the copy. Review the changes before running it again.';
const CHANGED_PATHS_KEPT = 50;
// No process group has this number. A command journaled at intent never recorded its group, and
// this stands in for it so the thread stays held.
const UNRECORDED_GROUP = 0;

const KINDS = [
  ['test', 'Tests'],
  ['lint', 'Lint'],
  ['typecheck', 'Type check'],
] as const;

/** A readable file of the copy, or null. Large and non-regular files are not read. */
function read(directory: string, name: string): string | null {
  const path = join(directory, name);
  try {
    const state = lstatSync(path);
    if (!state.isFile() || state.size > FILE_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function packageManager(directory: string): string {
  if (existsSync(join(directory, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(directory, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function packageScripts(directory: string): Record<string, unknown> | null {
  const manifest = read(directory, 'package.json');
  if (!manifest) return null;
  try {
    const scripts = (JSON.parse(manifest) as { scripts?: unknown }).scripts;
    return scripts && typeof scripts === 'object' && !Array.isArray(scripts)
      ? (scripts as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const clipText = (text: string, characters: number) =>
  text.length > characters ? `${text.slice(0, characters - 1).toWellFormed()}…` : text;

// "pytest" as a quoted requirement, such as "pytest>=8", or as a Poetry key, such as pytest = "^8".
const PYTEST_DEPENDENCY = /["']pytest(?:[\s<>=~!;[\]"',]|$)|^\s*pytest\s*=/m;

/**
 * The targets a Makefile defines, with the recipe lines of each joined by "; ". A rule line can
 * name several targets, such as "test lint: deps". Special targets such as .PHONY and variable
 * assignments are not targets.
 */
function makeTargets(make: string): Map<string, string> {
  const targets = new Map<string, string>();
  const rule = /^([A-Za-z0-9_][^:=#\n]*?)\s*::?(?!=)[^\n]*(?:\n|$)((?:\t[^\n]*(?:\n|$))*)/gm;
  for (const match of make.matchAll(rule)) {
    const recipe = match[2]
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('; ');
    for (const name of match[1].split(/\s+/))
      if (name && !targets.has(name)) targets.set(name, recipe);
  }
  return targets;
}

/**
 * The checks a project declares: package.json scripts, pyproject.toml tool tables and pytest,
 * a pytest.ini, Makefile targets, a Cargo.toml and a go.mod. Reads files only; nothing is run and nothing is installed. The
 * resolved text names what the command runs, including the pre and post scripts npm and yarn
 * run around a script.
 */
export function detectChecks(directory: string): DetectedCheck[] {
  const found: DetectedCheck[] = [];
  const add = (
    source: DetectedCheck['source'],
    kind: 'test' | 'lint' | 'typecheck',
    command: string,
    resolved = command,
  ) => {
    const label = KINDS.find(([value]) => value === kind)?.[1] ?? kind;
    found.push({
      id: `${source}:${kind}`,
      label: `${label} (${source})`,
      kind,
      source,
      command,
      resolved: clipText(resolved, 500),
    });
  };

  const scripts = packageScripts(directory);
  if (scripts) {
    const manager = packageManager(directory);
    for (const [kind] of KINDS) {
      if (typeof scripts[kind] !== 'string') continue;
      const names = manager === 'pnpm' ? [kind] : [`pre${kind}`, kind, `post${kind}`];
      const parts = names.flatMap((name) =>
        typeof scripts[name] === 'string' ? [`${name}: ${scripts[name]}`] : [],
      );
      add(
        'package.json',
        kind,
        `${manager} run ${kind}`,
        `${manager} run ${kind} runs ${parts.join('; ')}`,
      );
    }
  }

  // pytest runs from a [tool.pytest] table, a pytest.ini or a project that names pytest as a
  // dependency, in a PEP 621 list or a Poetry table. One test check covers them.
  const python = read(directory, 'pyproject.toml');
  const pytestIni = read(directory, 'pytest.ini');
  if (python !== null) {
    if (/^\[tool\.pytest/m.test(python) || PYTEST_DEPENDENCY.test(python))
      add('pyproject.toml', 'test', 'python3 -m pytest');
    else if (pytestIni !== null) add('pytest.ini', 'test', 'python3 -m pytest');
    if (/^\[tool\.ruff/m.test(python)) add('pyproject.toml', 'lint', 'ruff check');
    if (/^\[tool\.mypy/m.test(python)) add('pyproject.toml', 'typecheck', 'mypy .');
  } else if (pytestIni !== null) add('pytest.ini', 'test', 'python3 -m pytest');

  const make = read(directory, 'Makefile');
  if (make !== null) {
    const targets = makeTargets(make);
    for (const [kind] of KINDS) {
      const recipe = targets.get(kind);
      if (recipe === undefined) continue;
      add('Makefile', kind, `make ${kind}`, `make ${kind} runs ${recipe || 'no recipe'}`);
    }
  }

  if (read(directory, 'Cargo.toml') !== null) {
    add('Cargo.toml', 'test', 'cargo test');
    add('Cargo.toml', 'lint', 'cargo clippy');
    add('Cargo.toml', 'typecheck', 'cargo check');
  }

  // go vet type checks every package as it lints, so a Go module gets no separate type check.
  if (read(directory, 'go.mod') !== null) {
    add('go.mod', 'test', 'go test ./...');
    add('go.mod', 'lint', 'go vet ./...');
  }
  return found;
}

/** The words of a command, or null when it needs a shell to mean what it says. */
export function commandWords(command: string): string[] | null {
  const words = command.trim().split(/\s+/);
  if (
    !words[0] ||
    words.length > 32 ||
    words.some((word) => !PLAIN_WORD.test(word) || word.length > 200) ||
    SHELLS.has(basename(words[0]).toLowerCase())
  )
    return null;
  return words;
}

/**
 * Why a command a person added is refused, or null. Wrappers and interpreters with inline code
 * would run what the words do not show, and a path outside the scratch copy names a file the
 * fixer cannot be held to.
 */
export function addedProblem(words: readonly string[], scratch: string): string | null {
  const program = basename(words[0]).toLowerCase();
  if (WRAPPERS.has(program)) return ADDED_RULE;
  if (INTERPRETERS.has(program)) {
    for (const word of words.slice(1)) {
      if (word === '-m' || !word.startsWith('-')) break;
      if (INLINE_FLAG.test(word)) return ADDED_RULE;
    }
    if (program === 'deno' && words[1] === 'eval') return ADDED_RULE;
  }
  const root = resolve(scratch);
  for (const word of words) {
    const value = word.includes('=') ? word.slice(word.indexOf('=') + 1) : word;
    if (value.split('/').includes('..')) return ADDED_RULE;
    if (value.startsWith('/') && !(resolve(value) + sep).startsWith(root + sep)) return ADDED_RULE;
  }
  return null;
}

// Flags that send a package manager to another package. The root's scripts say nothing then.
const ELSEWHERE = new Set([
  '--filter',
  '-F',
  '--workspace',
  '-w',
  '--workspaces',
  '-ws',
  '--prefix',
  '-C',
  '--dir',
  '--cwd',
  '-r',
  '--recursive',
]);
// npm runs a script by bare name only for these lifecycle shortcuts.
const NPM_SHORTCUTS: Record<string, string> = {
  test: 'test',
  t: 'test',
  tst: 'test',
  start: 'start',
  stop: 'stop',
  restart: 'restart',
};
// The commands pnpm, yarn and bun run themselves, which a bare word never means as a script.
// pnpm runs its test and start through the scripts, so they are not here.
const OWN_COMMANDS: Record<string, ReadonlySet<string>> = {
  pnpm: new Set(
    'add install i update up remove rm link ln unlink import rebuild rb prune fetch patch exec dlx create init publish pack outdated list ls why audit store root bin env config setup server deploy licenses doctor'.split(
      ' ',
    ),
  ),
  yarn: new Set(
    'add install remove up upgrade dlx exec workspace workspaces info init link unlink node pack npm plugin set config constraints why version cache explain'.split(
      ' ',
    ),
  ),
  bun: new Set(
    'test build install i add a remove rm x create init upgrade pm link unlink outdated publish patch exec repl'.split(
      ' ',
    ),
  ),
};

/**
 * The package.json script a package manager command runs from the root, with its text: the word
 * after run or run-script, an npm lifecycle shortcut, or for pnpm, yarn and bun a bare script name
 * that is not one of the manager's own commands. `around` adds the pre and post scripts that npm,
 * yarn and bun run around a script. Nothing for another program or another workspace.
 */
function namedScripts(command: string, directory: string, around: boolean): string[] {
  const words = command.split(/\s+/);
  const manager = basename(words[0]).toLowerCase();
  if (!PACKAGE_MANAGERS.has(manager)) return [];
  const rest = words.slice(1);
  // pnpm's -w is the workspace root, which is where these scripts live.
  const elsewhere = (word: string) =>
    ELSEWHERE.has(word.split('=')[0]) && !(manager === 'pnpm' && word === '-w');
  if (rest.some(elsewhere)) return [];
  const scripts = packageScripts(directory);
  if (!scripts) return [];
  const positional = rest.filter((word) => !word.startsWith('-'));
  const [first, second] = positional;
  const name =
    first === 'run' || first === 'run-script'
      ? second
      : manager === 'npm'
        ? NPM_SHORTCUTS[first ?? '']
        : first && !OWN_COMMANDS[manager]?.has(first)
          ? first
          : undefined;
  if (!name || typeof scripts[name] !== 'string') return [];
  return (around ? [`pre${name}`, name, `post${name}`] : [name]).flatMap((entry) =>
    typeof scripts[entry] === 'string' ? [`${entry}: ${scripts[entry]}`] : [],
  );
}

/** A digest of the command and of the files that decide what it runs. */
export function sourceDigest(
  item: Pick<ChatCheck, 'kind' | 'source' | 'command'>,
  directory: string,
): string {
  const hash = createHash('sha256');
  hash.update(`${item.command}\0`);
  if (item.source === 'package.json') {
    const scripts = packageScripts(directory);
    for (const name of [`pre${item.kind}`, item.kind, `post${item.kind}`])
      hash.update(`${name}=${typeof scripts?.[name] === 'string' ? scripts[name] : ''}\0`);
  } else if (item.source === 'custom') {
    // A word that names a file of the copy pins the file, and a script a package manager runs
    // pins its text, so editing either asks again.
    for (const word of item.command.split(/\s+/).slice(1)) {
      const content = word.startsWith('-') ? null : read(directory, word);
      if (content !== null) hash.update(`${word}\0${content}\0`);
    }
    for (const script of namedScripts(item.command, directory, true))
      hash.update(`script\0${script}\0`);
  } else {
    hash.update(read(directory, item.source) ?? 'missing');
  }
  return hash.digest('hex');
}

/** What an item runs now, and the digest to compare with its pin. */
export function describe(item: ChatCheck, directory: string): { resolved: string; digest: string } {
  const found =
    item.source === 'custom' ? null : detectChecks(directory).find((value) => value.id === item.id);
  const custom = () => {
    const pnpm = basename(item.command.split(/\s+/)[0]).toLowerCase() === 'pnpm';
    const scripts = namedScripts(item.command, directory, !pnpm);
    return clipText(
      scripts.length ? `${item.command} runs ${scripts.join('; ')}` : item.command,
      500,
    );
  };
  return {
    resolved:
      found?.resolved ??
      (item.source === 'custom' ? custom() : `${item.command} (no longer declared)`),
    digest: sourceDigest(item, directory),
  };
}

/**
 * The files Accept would publish from a copy, by path: tracked and untracked files less what the
 * base's ignore rules leave out, each as its mode and blob id.
 */
function publishable(repository: string, copy: string, plan: ScratchPlan): Map<string, string> {
  return new Map(
    hashCandidateFiles(copy, repository, plan).map((file) => [
      file.path,
      `${file.mode} ${file.oid}`,
    ]),
  );
}

/** Paths whose bytes or mode differ between two reads of a copy, sorted. */
function differences(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}

/**
 * Read what Accept would publish from a copy, before a command runs in it. The function it
 * returns reads the copy again: null when it holds what it held before, otherwise the changed
 * paths. A copy left with something it cannot hold, such as a link or a .git folder, counts as
 * changed with no paths. The files stay for the person to review. Throws when the copy cannot be
 * read at the start.
 */
export function watchCopy(
  repository: string,
  base: string,
  copy: string,
): () => Pick<ChatCheckRun, 'changedPaths' | 'changedCount'> | null {
  const plan = scratchPlan(repository, base);
  const before = publishable(repository, copy, plan);
  return () => {
    let changed: string[];
    try {
      changed = differences(before, publishable(repository, copy, plan));
    } catch {
      return {};
    }
    if (!changed.length) return null;
    return {
      changedPaths: changed.filter((path) => path.length <= 1024).slice(0, CHANGED_PATHS_KEPT),
      changedCount: changed.length,
    };
  };
}

const RECIPE: Record<ChatCheck['kind'], ProjectCommandRecipeName> = {
  test: 'test',
  lint: 'lint',
  typecheck: 'lint',
  custom: 'test',
};

/** The thread's own policy covers commands outside the read-only set: Allow all or a grant. */
export function commandsAllowed(thread: ChatThread): boolean {
  return thread.permissionPolicy === 'allow-all' || !!thread.permissionGrants?.includes('command');
}

export const enabledChecks = (thread: ChatThread): ChatCheck[] =>
  (thread.checks?.items ?? []).filter((item) => item.enabled);

export type ChecksOutcome = Readonly<{
  /** none: nothing is switched on. denied: the person did not allow the commands. */
  outcome: 'none' | 'denied' | 'passed' | 'failed' | 'stopped';
  runs: readonly ChatCheckRun[];
  /** The message for a fix turn, or null when nothing failed. */
  brief: string | null;
}>;

export type ChecksHost = {
  store: Store;
  artifacts: ArtifactFiles;
  home: string;
  now: () => string;
  task: (taskId: string) => Task | undefined;
  thread: (taskId: string) => ChatThread;
  /** Change the thread inside one transaction and tell its viewers. */
  update: (taskId: string, change: (thread: ChatThread) => ChatThread) => void;
  scratchDirectory: (taskId: string) => string;
  projectPath: (projectId: string) => string | undefined;
  /** Block the thread's turns until the recorded process groups are found gone. */
  holdOwnership: (taskId: string) => void;
  groupAbsent: (group: number) => boolean;
  deadlineMs?: number;
  /** Recorded with each check's launch intent. */
  launchIdentity?: LaunchIdentity;
  /** Timers and the process runner. Tests replace them; the defaults are the real ones. */
  schedule?: Schedule;
  runner?: OwnedProjectCommandRunner;
};

type Entry = {
  taskId: string;
  combined: boolean;
  /** An Accept's run, in a copy of its own. It holds neither the scratch copy nor a merged one. */
  accept: boolean;
  stopped: boolean;
  /**
   * The gate's total ran out. Its open check fails once its process is gone, and the rest fail
   * without starting.
   */
  expired?: boolean;
  /** A run's process may still be running, so the rest fail without starting. */
  unconfirmed?: boolean;
  stop: () => void;
  /** The plan slice the runs check, in its own copy or on the thread's copy after its merge. */
  slice?: number;
  /** Called with each change to a run of this entry, inside the transaction that saves it. */
  saw?: (run: ChatCheckRun) => void;
};
type Finished = { run: ChatCheckRun; output: string };

const clip = (text: string, characters: number) =>
  text.length > characters ? text.slice(-characters).toWellFormed() : text;

/** Output as text a person reads: no colour codes or control bytes, no secrets, a whole last line. */
function readable(text: string): string {
  const plain = [...stripVTControlCharacters(text).replace(/\r\n?/g, '\n')]
    .filter((char) => char === '\n' || char === '\t' || char.charCodeAt(0) >= 32)
    .join('');
  return redact(plain).trimEnd();
}

const PENDING_CHUNKS = 64;

/**
 * Start reading a process stream at once and hand its chunks on as the consumer asks. A process
 * that exits before anyone reads has its unread output dropped by Node, and the artifact store
 * opens its file first, so a quick check would lose its output. At most 64 chunks wait, and
 * `abandon` ends the read when the consumer is gone.
 */
function eager(source: AsyncIterable<Uint8Array>, keep: (chunk: Uint8Array) => void) {
  const waiting: Uint8Array[] = [];
  let ended = false;
  let abandoned = false;
  let failure: unknown;
  let wake: (() => void) | undefined;
  let drained: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const abandon = () => {
    abandoned = true;
    waiting.length = 0;
    drained?.();
    drained = undefined;
    notify();
  };
  void (async () => {
    try {
      for await (const chunk of source) {
        if (abandoned) break;
        keep(chunk);
        waiting.push(chunk);
        notify();
        if (waiting.length >= PENDING_CHUNKS && !abandoned)
          await new Promise<void>((resolve) => (drained = resolve));
        if (abandoned) break;
      }
    } catch (error) {
      failure = error;
    } finally {
      ended = true;
      notify();
    }
  })();
  const stream: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          const chunk = waiting.shift();
          if (chunk) {
            drained?.();
            drained = undefined;
            yield chunk;
          } else if (failure) throw failure;
          else if (ended || abandoned) return;
          else await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        abandon();
      }
    },
  };
  return { stream, abandon };
}

export function checkFixBrief(runs: readonly Finished[]): string {
  const parts = runs.map(({ run, output }) =>
    [
      `Check: ${run.label}. Command: ${run.command}. ${run.reason ?? 'It failed.'}`,
      '```',
      clip(output || '(no output)', Math.floor(BRIEF_CHARACTERS / Math.max(1, runs.length))),
      '```',
    ].join('\n'),
  );
  return [
    'The project checks failed in the scratch copy. Fix what they report, then say what you changed. Read a file before you change it. Do not edit the checks to make them pass.',
    ...parts,
  ].join('\n\n');
}

/** The thread with the run added, or in place of its earlier state. The newest runs are kept. */
export function withRun(thread: ChatThread, run: ChatCheckRun): ChatThread {
  const current = thread.checks ?? {
    items: [],
    ask: null,
    approved: null,
    runs: [],
    detectedAt: null,
  };
  const runs = current.runs.some((value) => value.id === run.id)
    ? current.runs.map((value) => (value.id === run.id ? run : value))
    : [...current.runs, run];
  return { ...thread, checks: { ...current, runs: runs.slice(-CHECK_RUNS_KEPT) } };
}

export class ThreadChecks {
  private readonly host: ChecksHost;
  private readonly entries = new Set<Entry>();
  private readonly ops = new Set<string>();
  private readonly ids: ReturnType<typeof createIds>;
  private readonly journal: OperationStore;

  constructor(host: ChecksHost) {
    this.host = host;
    this.ids = createIds(host.now);
    this.journal = new OperationStore(host.store, host.now, undefined, host.launchIdentity);
  }

  /** A run of this thread's own scratch copy is open. The thread takes no new turn meanwhile. */
  running(taskId: string): boolean {
    return [...this.entries].some((entry) => entry.taskId === taskId && !entry.combined);
  }

  /** Any run of this thread is open, a plan's run of the merged copy too. */
  open(taskId: string): boolean {
    return [...this.entries].some((entry) => entry.taskId === taskId && !entry.accept);
  }

  /** Mark a run as coming before it starts, so a message sent in between waits. */
  reserve(taskId: string, combined = false, accept = false, slice?: number): Entry {
    const entry: Entry = { taskId, combined, accept, slice, stopped: false, stop: () => {} };
    this.entries.add(entry);
    return entry;
  }

  /** Drop a reservation whose run never started, or has ended. */
  release(entry: Entry) {
    this.entries.delete(entry);
  }

  /**
   * Stop the thread's open runs of the scratch copy. A plan's runs, in a slice's copy or on the
   * merged copy, belong to the plan step that started them and end only through `stopCombined`.
   */
  stop(taskId: string): boolean {
    return this.stopWhere(taskId, false);
  }

  stopCombined(taskId: string): boolean {
    return this.stopWhere(taskId, true);
  }

  private stopWhere(taskId: string, combined: boolean): boolean {
    let any = false;
    for (const entry of this.entries)
      if (entry.taskId === taskId && entry.combined === combined && !entry.accept) {
        any = true;
        entry.stopped = true;
        entry.stop();
      }
    return any;
  }

  close() {
    for (const entry of this.entries) {
      entry.stopped = true;
      entry.stop();
    }
  }

  /**
   * After a restart nobody owns an open run, and the question it waited on is gone. A process the
   * journal cannot prove gone keeps the thread from taking a turn, and the open run reads as
   * unknown. Otherwise it reads as failed.
   */
  recover() {
    this.journal.recover(this.host.groupAbsent, this.ops);
    const unknown = new Set(
      (
        this.host.store.db
          .prepare(
            "SELECT DISTINCT task_id FROM task_operations WHERE kind='project-command' AND state='unknown'",
          )
          .all() as { task_id: string }[]
      ).map((row) => row.task_id),
    );
    const rows = this.host.store.db
      .prepare(
        `SELECT task_id FROM chat_threads WHERE json_extract(body,'$.checks.ask') IS NOT NULL
        OR EXISTS (SELECT 1 FROM json_each(body,'$.checks.runs') WHERE json_extract(value,'$.status')='running')`,
      )
      .all() as { task_id: string }[];
    for (const { task_id } of rows)
      this.host.update(task_id, (thread) => {
        if (!thread.checks) return thread;
        const runs = thread.checks.runs.map((run) =>
          run.status === 'running'
            ? {
                ...run,
                status: unknown.has(task_id) ? ('unknown' as const) : ('failed' as const),
                reason:
                  'CrewKite restarted while this check ran. Its process may still be running.',
              }
            : run,
        );
        return { ...thread, checks: { ...thread.checks, runs, ask: null } };
      });
    for (const task_id of unknown) this.host.holdOwnership(task_id);
  }

  /**
   * Process groups of this task's unresolved commands that are still present. Reads only. A
   * command journaled at intent may have started a process whose group was never recorded.
   * Nothing can prove that process gone, so it counts as present. Every unresolved command of the
   * task counts, however many came after it.
   */
  orphans(taskId: string): number[] {
    return this.journal
      .unresolved(taskId)
      .filter((record) => record.kind === 'project-command' && !this.ops.has(record.id))
      .flatMap((record) =>
        record.phases.flatMap((phase) => {
          if (phase.state === 'intent') return [UNRECORDED_GROUP];
          return phase.state === 'owned' &&
            phase.group !== null &&
            !this.host.groupAbsent(phase.group)
            ? [phase.group]
            : [];
        }),
      );
  }

  /** A run of the thread is open in this process, or an operation of it runs here. */
  live(taskId: string): boolean {
    return (
      [...this.entries].some((entry) => entry.taskId === taskId) ||
      this.journal
        .unresolved(taskId)
        .some((record) => liveOperations.has(record.id) || this.ops.has(record.id))
    );
  }

  /**
   * Release the thread from commands journaled at intent that never recorded a group, on the
   * person's word: ones recovery left unknown, and ones still marked running that nothing in this
   * process owns, since a failed journal write can leave a command so. Each fails with their note
   * as its reason, and the count comes back. Nothing is signaled, and no group number is read for
   * them, since none was recorded. Design preview passes and project commands started for the
   * thread use the same journal, so one that lost its process is released the same way. The caller
   * has already refused a command this process runs and a recorded group still present. Runs
   * inside the caller's transaction.
   */
  releaseHeld(taskId: string, note: string): number {
    if (this.live(taskId) || this.orphans(taskId).some((group) => group !== UNRECORDED_GROUP))
      throw Error('A held command is still owned or present.');
    const held = this.journal
      .unresolved(taskId)
      .filter(
        (record) =>
          record.kind === 'project-command' &&
          record.phases.some((phase) => phase.state === 'intent'),
      );
    for (const record of held)
      this.journal.release(record.id, `operation-released-by-person: ${note}`, {
        outcome: 'blocked',
        reason: 'operation-released-by-person',
      });
    return held.length;
  }

  private directory(task: Task): string {
    const scratch = this.host.scratchDirectory(task.id);
    return existsSync(scratch) ? scratch : (this.host.projectPath(task.projectId) ?? scratch);
  }

  /** The checks the copy declares, with the switches and added commands the thread already has. */
  refresh(task: Task, thread: ChatThread): ChatChecksState {
    const before = thread.checks;
    const detected = detectChecks(this.directory(task)).map((item) => {
      const old = before?.items.find((value) => value.id === item.id);
      return { ...item, enabled: old?.enabled ?? false, pin: old?.pin ?? null };
    });
    const custom = (before?.items ?? []).filter((item) => item.source === 'custom');
    return {
      items: [...detected, ...custom].slice(0, MAX_ITEMS),
      ask: before?.ask ?? null,
      approved: before?.approved ?? null,
      runs: before?.runs ?? [],
      detectedAt: this.host.now(),
    };
  }

  /** Apply one edit. The result is the new state, or the reason the edit was refused. */
  edit(
    task: Task,
    thread: ChatThread,
    edit: ChatChecksEdit,
  ): { state: ChatChecksState } | { error: string } {
    const directory = this.directory(task);
    let state = edit.refresh || !thread.checks ? this.refresh(task, thread) : thread.checks;
    if (edit.switch) {
      const wanted = edit.switch;
      if (!state.items.some((item) => item.id === wanted.id))
        return { error: 'That check is not in this thread. Refresh the list.' };
      // Turning a check on pins what it runs now. A later change to the script asks again.
      state = {
        ...state,
        items: state.items.map((item) =>
          item.id === wanted.id
            ? {
                ...item,
                enabled: wanted.enabled,
                resolved: wanted.enabled ? describe(item, directory).resolved : item.resolved,
                pin: wanted.enabled ? sourceDigest(item, directory) : null,
              }
            : item,
        ),
      };
    }
    if (edit.remove) {
      const target = state.items.find((item) => item.id === edit.remove);
      if (target?.source !== 'custom')
        return { error: 'Only a command you added can be removed. Switch a detected check off.' };
      state = { ...state, items: state.items.filter((item) => item.id !== target.id) };
    }
    if (edit.add) {
      const words = commandWords(edit.add);
      const problem = words ? addedProblem(words, this.host.scratchDirectory(task.id)) : ADDED_RULE;
      if (!words || problem) return { error: problem ?? ADDED_RULE };
      const command = words.join(' ');
      if (state.items.length >= MAX_ITEMS)
        return { error: `A thread keeps at most ${MAX_ITEMS} checks.` };
      if (state.items.some((item) => item.command === command))
        return { error: 'That command is already in the list.' };
      let number = 1;
      while (state.items.some((item) => item.id === `custom:${number}`)) number += 1;
      const added = {
        id: `custom:${number}`,
        label: command.slice(0, 80),
        kind: 'custom' as const,
        source: 'custom' as const,
        command,
        resolved: command,
        enabled: true,
        pin: null,
      };
      state = {
        ...state,
        items: [...state.items, { ...added, pin: sourceDigest(added, directory) }],
      };
    }
    return { state };
  }

  /**
   * What a run would execute, and which checks changed since the person turned them on. `seen`
   * is a digest of what runs in the copy now, so an answer can tell whether it still holds.
   */
  assess(
    task: Task,
    thread: ChatThread,
    directory?: string,
    only?: readonly ChatCheck[],
  ): {
    commands: { label: string; resolved: string }[];
    changed: string[];
    set: string;
    seen: string;
  } {
    const where = directory ?? this.directory(task);
    const home = this.directory(task);
    const commands: { label: string; resolved: string }[] = [];
    const changed: string[] = [];
    const set = createHash('sha256');
    const seen = createHash('sha256');
    for (const item of only ?? enabledChecks(thread)) {
      const now = describe(item, where);
      commands.push({ label: item.label.slice(0, 80), resolved: now.resolved });
      // A check that is off has no pin to compare. Run tests on it asks unless the person allowed
      // this command set for the thread.
      if (item.pin !== null && item.pin !== now.digest) changed.push(item.label.slice(0, 80));
      // The set an approval covers is read from the thread's own copy, whatever copy runs.
      set.update(`${item.id}\0${item.command}\0${sourceDigest(item, home)}\0`);
      seen.update(`${item.id}\0${item.command}\0${now.digest}\0`);
    }
    return { commands, changed, set: set.digest('hex'), seen: seen.digest('hex') };
  }

  /** The person allowed this command set for the thread. */
  approve(taskId: string, set: string) {
    this.host.update(taskId, (thread) =>
      thread.checks ? { ...thread, checks: { ...thread.checks, approved: set } } : thread,
    );
  }

  /** The person allowed the changed commands: pin what they run now. */
  repin(task: Task) {
    const directory = this.directory(task);
    this.host.update(task.id, (thread) =>
      thread.checks
        ? {
            ...thread,
            checks: {
              ...thread.checks,
              items: thread.checks.items.map((item) =>
                item.enabled
                  ? {
                      ...item,
                      resolved: describe(item, directory).resolved,
                      pin: sourceDigest(item, directory),
                    }
                  : item,
              ),
            },
          }
        : thread,
    );
  }

  private save(taskId: string, run: ChatCheckRun, entry?: Entry) {
    try {
      this.host.update(taskId, (thread) => {
        entry?.saw?.(run);
        return withRun(thread, run);
      });
    } catch {
      // A thread deleted mid-run has nowhere to show the run.
    }
  }

  /**
   * Run the thread's enabled checks one after another in `directory` (the scratch copy unless a
   * merged copy or an Accept's copy is named). The caller has the person's answer already. A failure does not end
   * the list: the fix message carries every failure. Stop ends the open check and skips the rest.
   * The gate after a writing turn and the checks after a plan's merge also have a total. Past it
   * the open check stops through its runner and fails once its process is proven gone, and the
   * checks left fail without starting.
   * They fail the same way after a check whose process may still be running, since it could
   * still write the copy they would read.
   */
  async run(
    taskId: string,
    trigger: ChatCheckRun['trigger'],
    directory?: string,
    reserved?: Entry,
    only?: readonly ChatCheck[],
  ): Promise<ChecksOutcome> {
    const entry = reserved ?? this.reserve(taskId, directory !== undefined);
    const cancel =
      trigger === 'after-write' || trigger === 'combined'
        ? (this.host.schedule ?? defaultSchedule)(() => {
            entry.expired = true;
            entry.stop();
          }, GATE_MS)
        : undefined;
    try {
      const task = this.host.task(taskId);
      const thread = this.host.thread(taskId);
      const items = only ?? enabledChecks(thread);
      if (!task || !items.length) return { outcome: 'none', runs: [], brief: null };
      const finished: Finished[] = [];
      for (const item of items) {
        if (entry.stopped) break;
        const done = await this.one(task, thread, item, trigger, entry, directory);
        if (done.run.status === 'unknown') entry.unconfirmed = true;
        finished.push(done);
      }
      // A run whose process may still be running never counts as a pass.
      const failed = finished.filter(
        ({ run }) => run.status === 'failed' || run.status === 'unknown',
      );
      const runs = finished.map(({ run }) => run);
      if (entry.stopped || finished.some(({ run }) => run.status === 'stopped'))
        return { outcome: 'stopped', runs, brief: null };
      return failed.length
        ? { outcome: 'failed', runs, brief: checkFixBrief(failed) }
        : { outcome: 'passed', runs, brief: null };
    } finally {
      cancel?.();
      this.entries.delete(entry);
    }
  }

  private async one(
    task: Task,
    thread: ChatThread,
    item: ChatCheck,
    trigger: ChatCheckRun['trigger'],
    entry: Entry,
    directory?: string,
  ): Promise<Finished> {
    const run: ChatCheckRun = {
      id: `chk_${randomBytes(16).toString('hex')}`,
      checkId: item.id,
      label: item.label,
      command: item.command,
      trigger,
      status: 'running',
      reason: null,
      startedAt: this.host.now(),
      durationMs: null,
      exitCode: null,
      tail: '',
      stdout: null,
      stderr: null,
      ...(entry.slice === undefined ? {} : { slice: entry.slice }),
    };
    this.save(task.id, run, entry);
    const began = performance.now();
    const over = trigger === 'combined' ? MERGE_OVER : GATE_OVER;
    let kept = Buffer.alloc(0);
    const keep = (chunk: Uint8Array) => {
      kept = Buffer.concat([kept, chunk]);
      if (kept.length > KEPT_BYTES) kept = kept.subarray(kept.length - KEPT_BYTES);
    };
    const artifacts: Artifact[] = [];
    const end = (patch: Partial<ChatCheckRun>): Finished => {
      const output = readable(kept.toString('utf8'));
      const done: ChatCheckRun = {
        ...run,
        durationMs: Math.round(performance.now() - began),
        tail: clip(output, CHECK_TAIL_CHARACTERS),
        ...patch,
      };
      this.save(task.id, done, entry);
      return { run: done, output };
    };
    if (entry.expired) return end({ status: 'failed', reason: over });
    if (entry.unconfirmed) return end({ status: 'failed', reason: AFTER_UNCONFIRMED });
    const words = commandWords(item.command);
    const scratch = this.host.scratchDirectory(task.id);
    if (!words || (item.source === 'custom' && addedProblem(words, scratch)))
      return end({ status: 'failed', reason: 'The command is not one a check may run.' });
    const root = this.host.projectPath(task.projectId);
    if (!root || !thread.base)
      return end({ status: 'failed', reason: 'The project or its base commit is missing.' });
    let pin: { path: string; sha256: string };
    try {
      pin = executablePin(words[0]);
    } catch {
      return end({ status: 'failed', reason: `Could not find ${words[0]} on this computer.` });
    }
    // What Accept would publish from the copy, read before the check starts and again after it
    // ends. A check that changes it cannot pass, whatever its exit code.
    let changes: ReturnType<typeof watchCopy>;
    try {
      changes = watchCopy(root, thread.base, directory ?? scratch);
    } catch {
      return end({
        status: 'failed',
        reason: 'CrewKite could not read the copy, so the check did not run.',
      });
    }

    const operationId = this.ids('cmd');
    let where: string;
    let definition: Artifact;
    let preview: ReturnType<typeof ProjectCommandPreviewSchema.parse>;
    try {
      where = realpathSync(directory ?? scratch);
      const home = join(this.host.home, 'operations', operationId);
      mkdirSync(join(home, 'environment'), { recursive: true, mode: 0o700 });
      mkdirSync(join(home, 'temporary'), { recursive: true, mode: 0o700 });
      const repositoryRoot = realpathSync(root);
      preview = ProjectCommandPreviewSchema.parse({
        version: 1,
        id: operationId,
        taskId: task.id,
        taskRevision: task.revision,
        source: inspectSource(task.projectId, repositoryRoot),
        sourceMode: 'committed-head',
        repositoryRoot,
        scratchRoot: where,
        cwd: where,
        recipe: RECIPE[item.kind],
        executable: pin.path,
        executableSha256: pin.sha256,
        executableIdentity: 'verified-prelaunch-sha256',
        argv: words.slice(1),
        // The program gets its own home and temporary folders. PATH stays the controller's.
        environment: {
          CI: '1',
          LANG: 'C',
          NO_COLOR: '1',
          HOME: join(home, 'environment'),
          TMPDIR: join(home, 'temporary'),
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        },
        deadlineMs: this.host.deadlineMs ?? DEADLINE_MS,
        nativeTrust: 'required',
      });
      const published = this.host.artifacts.publish(Buffer.from(canonicalJson(preview)));
      definition = ArtifactSchema.parse({
        id: this.ids('art'),
        ...published,
        mediaType: 'application/json',
      });
      this.journal.createAndBegin(
        { id: operationId, taskId: task.id, kind: 'project-command', definition },
        this.ids('cmd'),
        hashCanonical(preview),
        () => {},
        () => this.host.store.put('artifact', definition.id, 0, definition),
      );
    } catch (error) {
      return end({
        status: 'failed',
        reason: error instanceof Error ? error.message.slice(0, 300) : 'The check could not start.',
      });
    }

    this.ops.add(operationId);
    liveOperations.add(operationId);
    const named = (hash: string | undefined) =>
      artifacts.find((value) => value.hash === hash) ?? null;
    const brief = (artifact: Artifact | null) =>
      artifact ? { id: artifact.id, hash: artifact.hash, bytes: artifact.bytes } : null;
    try {
      const request: ProjectCommandDefinition = {
        version: 1,
        operationId,
        recipe: preview.recipe,
        source: {
          projectId: task.projectId,
          repositoryRoot: preview.repositoryRoot,
          baseRevision: thread.base,
        },
        scratchRoot: where,
        cwd: where,
        executable: pin.path,
        executableIdentity: 'verified-prelaunch-sha256',
        executableSha256: pin.sha256,
        argv: preview.argv,
        environment: Object.fromEntries(
          Object.entries(preview.environment).filter(
            (value): value is [string, string] => typeof value[1] === 'string',
          ),
        ),
        output: { stdout: 'artifact', stderr: 'artifact', chunkBytes: 65536 },
      };
      const execution = startProjectCommand(request, {
        runner:
          this.host.runner ?? createOwnedProjectCommandRunner({ deadlineMs: preview.deadlineMs }),
        lifecycle: {
          intent: () => {
            this.journal.phase(operationId, 'command', 'intent', null);
          },
          owned: (group) => {
            this.journal.phase(operationId, 'command', 'owned', group);
          },
          quiescent: (group) => {
            this.journal.phase(operationId, 'command', 'closed', group);
          },
          unlaunched: () => {
            this.journal.unlaunched(operationId, 'command');
          },
        },
        publishStream: async (source, options) => {
          const feed = eager(source, keep);
          try {
            const bytes = await this.host.artifacts.publishStream(feed.stream, {
              signal: options?.signal,
            });
            const artifact = ArtifactSchema.parse({
              id: this.ids('art'),
              ...bytes,
              mediaType: 'text/plain; charset=utf-8',
            });
            this.host.store.transaction(() =>
              this.host.store.put('artifact', artifact.id, 0, artifact),
            );
            artifacts.push(artifact);
            return bytes;
          } catch (error) {
            // The store failed: stop reading so the process is not held by a full queue.
            feed.abandon();
            throw error;
          }
        },
      });
      entry.stop = execution.stop;
      if (entry.stopped) execution.stop();
      const result = await execution.result;
      const stdout = named(result.stdout?.hash);
      const stderr = named(result.stderr?.hash);
      const saved = { stdout: brief(stdout), stderr: brief(stderr) };
      const reasons: Record<string, string> = {
        'nonzero-exit': `Exit code ${result.code}.`,
        signal: `Ended by signal ${result.signal}.`,
        deadline: `Timed out after ${Math.round(preview.deadlineMs / 60_000)} minutes.`,
        launch: 'The command could not start.',
        output: 'The output could not be saved.',
        ownership: 'CrewKite could not confirm the process exited.',
      };
      if (result.status === 'unknown') {
        this.journal.finish(
          operationId,
          {
            state: 'unknown',
            reason: 'operation-ownership-unknown',
            next: 'CrewKite checks again before the next turn. If it stays, export diagnostics before taking further action.',
            stdout,
            stderr,
          },
          { outcome: 'blocked', reason: 'operation-ownership-unknown' },
        );
        // No turn may edit the scratch copy while a process of unknown ownership may run.
        this.host.holdOwnership(task.id);
        return end({ status: 'unknown', reason: UNCONFIRMED, exitCode: result.code, ...saved });
      }
      this.journal.finish(
        operationId,
        {
          state: result.status,
          reason: result.status === 'succeeded' ? 'exit-zero' : result.reason,
          next: null,
          stdout,
          stderr,
        },
        result.status === 'succeeded'
          ? { outcome: 'applied' }
          : { outcome: 'blocked', reason: result.reason },
      );
      const changed = changes();
      // The gate's total stopped this run, and that is a failure the fixer may see. Only the
      // person's own stop reads as stopped.
      const stopped = result.status === 'cancelled' && !entry.expired;
      // A run the person stopped stays stopped. Any other run that changed the copy fails.
      if (changed)
        return end({
          status: stopped ? 'stopped' : 'failed',
          reason: CHANGED_FILES,
          exitCode: result.code,
          ...changed,
          ...saved,
        });
      if (result.status === 'succeeded') return end({ status: 'passed', exitCode: 0, ...saved });
      if (result.status === 'cancelled')
        return end({
          status: stopped ? 'stopped' : 'failed',
          reason: stopped ? 'You stopped it.' : over,
          exitCode: result.code,
          ...saved,
        });
      return end({
        status: 'failed',
        reason: reasons[result.reason] ?? 'The command failed.',
        exitCode: result.code,
        ...saved,
      });
    } catch (error) {
      // The process may still own a group the journal has not seen closed.
      const record = this.journal.get(operationId);
      const open = record?.phases.some((phase) => phase.state !== 'closed') ?? false;
      try {
        this.journal.finish(
          operationId,
          open
            ? { state: 'unknown', reason: 'operation-ownership-unknown', next: null }
            : { state: 'failed', reason: 'operation-failed', next: null },
          open
            ? { outcome: 'blocked', reason: 'operation-ownership-unknown' }
            : { outcome: 'blocked', reason: 'operation-failed' },
        );
      } catch {
        // Recovery reads the rows that are left.
      }
      if (open) {
        this.host.holdOwnership(task.id);
        return end({ status: 'unknown', reason: UNCONFIRMED });
      }
      return end({
        status: 'failed',
        reason: error instanceof Error ? error.message.slice(0, 300) : 'The check could not run.',
      });
    } finally {
      this.ops.delete(operationId);
      liveOperations.delete(operationId);
    }
  }
}

/**
 * The thread line for Run tests. One command reads as before: its name and exit status. With
 * several, a failure names the first command that failed, with its own exit status, and how many
 * of the commands failed, so a later command that passed is never reported as the failure. Each
 * run, its tail and its full output stay with the thread's checks.
 */
export function testsLine(
  outcome: 'passed' | 'failed',
  runs: readonly Pick<ChatCheckRun, 'command' | 'status' | 'exitCode'>[],
): string {
  const named = (run: (typeof runs)[number] | undefined) =>
    `${run?.command ?? 'the test command'}${
      run?.exitCode === null || run?.exitCode === undefined ? '' : ` (exit ${run.exitCode})`
    }`;
  if (outcome === 'passed')
    return runs.length > 1
      ? `Tests passed: all ${runs.length} commands. The output is under Checks.`
      : `Tests passed: ${named(runs[0])}.`;
  const failed = runs.filter((run) => run.status === 'failed' || run.status === 'unknown');
  const first = failed[0] ?? runs.at(-1);
  const count = runs.length > 1 ? `, ${failed.length || 1} of ${runs.length} commands failed` : '';
  return `Tests failed: ${named(first)}${count}. The output is under Checks.`;
}
