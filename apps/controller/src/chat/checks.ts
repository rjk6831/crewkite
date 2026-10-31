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
  type ProjectCommandDefinition,
  type ProjectCommandRecipeName,
  startProjectCommand,
} from '../commands/project-command.ts';
import { executablePin } from '../commands/task-operations.ts';
import { inspectSource } from '../host/source.ts';
import { createIds } from '../store/ids.ts';
import type { Store } from '../store/index.ts';
import { redact } from './thread-reader.ts';

// Project checks in the loop (ADR 0038 chain, ADR 0002 authority). The controller detects the
// checks and the person switches them on. A run needs the person's answer to a permission
// question unless Glide's policy already covers commands and nothing changed since the switch.
// A check runs without a shell: the controller finds the program on PATH and pins its bytes
// before every run, and records the process in the operation journal like any project command.
// A command the person adds cannot start a shell or a wrapper, run inline code or name a file
// outside the scratch copy. Output lands in the artifact store.

export type DetectedCheck = Pick<
  ChatCheck,
  'id' | 'label' | 'kind' | 'source' | 'command' | 'resolved'
>;

const MAX_ITEMS = 16;
const FILE_BYTES = 1024 * 1024;
const DEADLINE_MS = 10 * 60_000;
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
export const ADDED_RULE =
  'Name a program on PATH and files inside the scratch copy. Shells, wrappers such as env, inline code such as node -e and paths outside the copy are refused.';

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

/**
 * The checks a project declares: package.json scripts, pyproject.toml tool tables, Makefile
 * targets and a Cargo.toml. Reads files only; nothing is run and nothing is installed. The
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

  const python = read(directory, 'pyproject.toml');
  if (python !== null) {
    if (/^\[tool\.pytest/m.test(python)) add('pyproject.toml', 'test', 'python3 -m pytest');
    if (/^\[tool\.ruff/m.test(python)) add('pyproject.toml', 'lint', 'ruff check');
    if (/^\[tool\.mypy/m.test(python)) add('pyproject.toml', 'typecheck', 'mypy .');
  }

  const make = read(directory, 'Makefile');
  if (make !== null)
    for (const [kind] of KINDS) {
      const target = new RegExp(`^${kind}\\s*:[^\\n]*\\n((?:\\t[^\\n]*\\n?)*)`, 'm').exec(make);
      if (!target) continue;
      const recipe = target[1]
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('; ');
      add('Makefile', kind, `make ${kind}`, `make ${kind} runs ${recipe || 'no recipe'}`);
    }

  if (read(directory, 'Cargo.toml') !== null) {
    add('Cargo.toml', 'test', 'cargo test');
    add('Cargo.toml', 'lint', 'cargo clippy');
    add('Cargo.toml', 'typecheck', 'cargo check');
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

/** A digest of the command and of the files that decide what it runs. */
function sourceDigest(
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
    // A word that names a file of the copy pins the file, so editing a script asks again.
    for (const word of item.command.split(/\s+/).slice(1)) {
      const content = word.startsWith('-') ? null : read(directory, word);
      if (content !== null) hash.update(`${word}\0${content}\0`);
    }
  } else {
    hash.update(read(directory, item.source) ?? 'missing');
  }
  return hash.digest('hex');
}

/** What an item runs now, and the digest to compare with its pin. */
function describe(item: ChatCheck, directory: string): { resolved: string; digest: string } {
  const found =
    item.source === 'custom' ? null : detectChecks(directory).find((value) => value.id === item.id);
  return {
    resolved:
      found?.resolved ??
      (item.source === 'custom' ? item.command : `${item.command} (no longer declared)`),
    digest: sourceDigest(item, directory),
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
};

type Entry = { taskId: string; combined: boolean; stopped: boolean; stop: () => void };
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

export class ThreadChecks {
  private readonly host: ChecksHost;
  private readonly entries = new Set<Entry>();
  private readonly ops = new Set<string>();
  private readonly ids: ReturnType<typeof createIds>;
  private readonly journal: OperationStore;

  constructor(host: ChecksHost) {
    this.host = host;
    this.ids = createIds(host.now);
    this.journal = new OperationStore(host.store, host.now);
  }

  /** A run of this thread's own scratch copy is open. The thread takes no new turn meanwhile. */
  running(taskId: string): boolean {
    return [...this.entries].some((entry) => entry.taskId === taskId && !entry.combined);
  }

  /** Mark a run as coming before it starts, so a message sent in between waits. */
  reserve(taskId: string, combined = false): Entry {
    const entry: Entry = { taskId, combined, stopped: false, stop: () => {} };
    this.entries.add(entry);
    return entry;
  }

  /**
   * Stop the thread's open runs of the scratch copy. Runs on a merged copy belong to the plan
   * step that started them and end only through `stopCombined`.
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
      if (entry.taskId === taskId && entry.combined === combined) {
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
   * After a restart nobody owns an open run. It reads as failed, the question it waited on is
   * gone, and a process the journal cannot prove gone keeps the thread from taking a turn.
   */
  recover() {
    this.journal.recover(this.host.groupAbsent, this.ops);
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
                status: 'failed' as const,
                reason:
                  'CrewKite restarted while this check ran. Its process may still be running.',
              }
            : run,
        );
        return { ...thread, checks: { ...thread.checks, runs, ask: null } };
      });
    const unknown = this.host.store.db
      .prepare(
        "SELECT DISTINCT task_id FROM task_operations WHERE kind='project-command' AND state='unknown'",
      )
      .all() as { task_id: string }[];
    for (const { task_id } of unknown) this.host.holdOwnership(task_id);
  }

  /** Process groups of this task's unresolved commands that are still present. Reads only. */
  orphans(taskId: string): number[] {
    return this.journal
      .list(taskId, undefined, 21)
      .filter(
        (record) =>
          record.kind === 'project-command' &&
          ['running', 'stopping', 'unknown'].includes(record.state) &&
          !this.ops.has(record.id),
      )
      .flatMap((record) =>
        record.phases.flatMap((phase) =>
          phase.state === 'owned' && phase.group !== null && !this.host.groupAbsent(phase.group)
            ? [phase.group]
            : [],
        ),
      );
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

  /** What a run would execute, and which checks changed since the person turned them on. */
  assess(
    task: Task,
    thread: ChatThread,
    directory?: string,
  ): { commands: { label: string; resolved: string }[]; changed: string[]; set: string } {
    const where = directory ?? this.directory(task);
    const home = this.directory(task);
    const commands: { label: string; resolved: string }[] = [];
    const changed: string[] = [];
    const set = createHash('sha256');
    for (const item of enabledChecks(thread)) {
      const now = describe(item, where);
      commands.push({ label: item.label.slice(0, 80), resolved: now.resolved });
      if (item.pin !== now.digest) changed.push(item.label.slice(0, 80));
      // The set an approval covers is read from the thread's own copy, whatever copy runs.
      set.update(`${item.id}\0${item.command}\0${sourceDigest(item, home)}\0`);
    }
    return { commands, changed, set: set.digest('hex') };
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

  private save(taskId: string, run: ChatCheckRun) {
    try {
      this.host.update(taskId, (thread) => {
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
      });
    } catch {
      // A thread deleted mid-run has nowhere to show the run.
    }
  }

  /**
   * Run the thread's enabled checks one after another in `directory` (the scratch copy unless a
   * merged copy is named). The caller has the person's answer already. A failure does not end
   * the list: the fix message carries every failure. Stop ends the open check and skips the rest.
   */
  async run(
    taskId: string,
    trigger: ChatCheckRun['trigger'],
    directory?: string,
    reserved?: Entry,
  ): Promise<ChecksOutcome> {
    const entry = reserved ?? this.reserve(taskId, directory !== undefined);
    try {
      const task = this.host.task(taskId);
      const thread = this.host.thread(taskId);
      const items = enabledChecks(thread);
      if (!task || !items.length) return { outcome: 'none', runs: [], brief: null };
      const finished: Finished[] = [];
      for (const item of items) {
        if (entry.stopped) break;
        finished.push(await this.one(task, thread, item, trigger, entry, directory));
      }
      const failed = finished.filter(({ run }) => run.status === 'failed');
      const runs = finished.map(({ run }) => run);
      if (entry.stopped || finished.some(({ run }) => run.status === 'stopped'))
        return { outcome: 'stopped', runs, brief: null };
      return failed.length
        ? { outcome: 'failed', runs, brief: checkFixBrief(failed) }
        : { outcome: 'passed', runs, brief: null };
    } finally {
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
    };
    this.save(task.id, run);
    const began = performance.now();
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
      this.save(task.id, done);
      return { run: done, output };
    };
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
        runner: createOwnedProjectCommandRunner({ deadlineMs: preview.deadlineMs }),
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
            next: 'Quit the process, then send again.',
            stdout,
            stderr,
          },
          { outcome: 'blocked', reason: 'operation-ownership-unknown' },
        );
        // No turn may edit the scratch copy while a process of unknown ownership may run.
        this.host.holdOwnership(task.id);
        return end({
          status: 'failed',
          reason: 'CrewKite could not confirm the process exited. Quit it before the next turn.',
          exitCode: result.code,
          ...saved,
        });
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
      if (result.status === 'succeeded') return end({ status: 'passed', exitCode: 0, ...saved });
      if (result.status === 'cancelled')
        return end({
          status: 'stopped',
          reason: 'You stopped it.',
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
      if (open) this.host.holdOwnership(task.id);
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
