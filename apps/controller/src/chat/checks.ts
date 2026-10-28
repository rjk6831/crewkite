import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
  type Task,
} from '@crewkite/contracts';
import type { ArtifactFiles } from '../artifacts/index.ts';
import { createOwnedProjectCommandRunner } from '../commands/owned-runner.ts';
import {
  type ProjectCommandDefinition,
  type ProjectCommandRecipeName,
  startProjectCommand,
} from '../commands/project-command.ts';
import { executablePin } from '../commands/task-operations.ts';
import { createIds } from '../store/ids.ts';
import type { Store } from '../store/index.ts';
import { redact } from './thread-reader.ts';

// Project checks in the loop (ADR 0038 chain, ADR 0002 authority). The controller detects the
// checks, the person switches them, and the chain runs the enabled ones in the thread's scratch
// copy through the shared process owner. A check is never a shell line: the controller resolves
// the program and pins its bytes before every run. Output lands in the artifact store.

export type DetectedCheck = Pick<ChatCheck, 'id' | 'label' | 'kind' | 'source' | 'command'>;

const MAX_ITEMS = 16;
const FILE_BYTES = 1024 * 1024;
const DEADLINE_MS = 10 * 60_000;
// The newest output kept in memory for the fix message. The card keeps less.
const KEPT_BYTES = 12 * 1024;
const BRIEF_CHARACTERS = 12_000;
const PLAIN_WORD = /^[A-Za-z0-9._/=:,+@%-]+$/;
const SHELLS = new Set(['bash', 'cmd', 'dash', 'fish', 'ksh', 'powershell', 'pwsh', 'sh', 'zsh']);

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

/**
 * The checks a project declares: package.json scripts, pyproject.toml tool tables, Makefile
 * targets and a Cargo.toml. Reads files only; nothing is run and nothing is installed.
 */
export function detectChecks(directory: string): DetectedCheck[] {
  const found: DetectedCheck[] = [];
  const add = (
    source: DetectedCheck['source'],
    kind: 'test' | 'lint' | 'typecheck',
    command: string,
  ) => {
    const label = KINDS.find(([value]) => value === kind)?.[1] ?? kind;
    found.push({ id: `${source}:${kind}`, label: `${label} (${source})`, kind, source, command });
  };

  const manifest = read(directory, 'package.json');
  if (manifest) {
    let scripts: unknown;
    try {
      scripts = (JSON.parse(manifest) as { scripts?: unknown }).scripts;
    } catch {
      scripts = undefined;
    }
    if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
      const manager = packageManager(directory);
      for (const [kind] of KINDS)
        if (typeof (scripts as Record<string, unknown>)[kind] === 'string')
          add('package.json', kind, `${manager} run ${kind}`);
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
    for (const [kind] of KINDS)
      if (new RegExp(`^${kind}\\s*:`, 'm').test(make)) add('Makefile', kind, `make ${kind}`);

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

const RECIPE: Record<ChatCheck['kind'], ProjectCommandRecipeName> = {
  test: 'test',
  lint: 'lint',
  typecheck: 'lint',
  custom: 'test',
};

/** The thread allows commands outside the read-only set: Allow all, or a command grant. */
export function commandsAllowed(thread: ChatThread): boolean {
  return thread.permissionPolicy === 'allow-all' || !!thread.permissionGrants?.includes('command');
}

export const enabledChecks = (thread: ChatThread): ChatCheck[] =>
  (thread.checks?.items ?? []).filter((item) => item.enabled);

export type ChecksOutcome = Readonly<{
  /** none: nothing is switched on. denied: the thread does not allow commands. */
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
 * opens its file first, so a quick check would lose its output. At most 64 chunks wait.
 */
function eager(
  source: AsyncIterable<Uint8Array>,
  keep: (chunk: Uint8Array) => void,
): AsyncIterable<Uint8Array> {
  const waiting: Uint8Array[] = [];
  let ended = false;
  let failure: unknown;
  let wake: (() => void) | undefined;
  let drained: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  void (async () => {
    try {
      for await (const chunk of source) {
        keep(chunk);
        waiting.push(chunk);
        notify();
        if (waiting.length >= PENDING_CHUNKS)
          await new Promise<void>((resolve) => (drained = resolve));
      }
    } catch (error) {
      failure = error;
    } finally {
      ended = true;
      notify();
    }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const chunk = waiting.shift();
        if (chunk) {
          drained?.();
          drained = undefined;
          yield chunk;
        } else if (failure) throw failure;
        else if (ended) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
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

// The service that started last. Code outside the service reaches its checks through it.
let bound: ThreadChecks | undefined;

export class ThreadChecks {
  private readonly host: ChecksHost;
  private readonly entries = new Set<Entry>();
  private readonly ids: ReturnType<typeof createIds>;

  constructor(host: ChecksHost) {
    this.host = host;
    this.ids = createIds(host.now);
    bound = this;
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

  /** Stop the thread's open runs. True when there was one. */
  stop(taskId: string): boolean {
    let any = false;
    for (const entry of this.entries)
      if (entry.taskId === taskId) {
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

  /** Runs left open by a controller that is gone have no process this one owns. */
  recover() {
    const rows = this.host.store.db
      .prepare(
        "SELECT DISTINCT task_id FROM chat_threads, json_each(body,'$.checks.runs') WHERE json_extract(value,'$.status')='running'",
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
        return { ...thread, checks: { ...thread.checks, runs } };
      });
  }

  private directory(task: Task): string {
    const scratch = this.host.scratchDirectory(task.id);
    return existsSync(scratch) ? scratch : (this.host.projectPath(task.projectId) ?? scratch);
  }

  /** The checks the copy declares, with the switches and added commands the thread already has. */
  refresh(task: Task, thread: ChatThread): ChatChecksState {
    const before = thread.checks;
    const detected = detectChecks(this.directory(task)).map((item) => ({
      ...item,
      enabled: before?.items.find((old) => old.id === item.id)?.enabled ?? false,
    }));
    const custom = (before?.items ?? []).filter((item) => item.source === 'custom');
    return {
      items: [...detected, ...custom].slice(0, MAX_ITEMS),
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
    let state = edit.refresh || !thread.checks ? this.refresh(task, thread) : thread.checks;
    if (edit.switch) {
      const wanted = edit.switch;
      if (!state.items.some((item) => item.id === wanted.id))
        return { error: 'That check is not in this thread. Refresh the list.' };
      state = {
        ...state,
        items: state.items.map((item) =>
          item.id === wanted.id ? { ...item, enabled: wanted.enabled } : item,
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
      if (!words)
        return {
          error:
            'Write a program and its arguments as plain words. Quotes, pipes, variables and shells are not accepted.',
        };
      const command = words.join(' ');
      if (state.items.length >= MAX_ITEMS)
        return { error: `A thread keeps at most ${MAX_ITEMS} checks.` };
      if (state.items.some((item) => item.command === command))
        return { error: 'That command is already in the list.' };
      let number = 1;
      while (state.items.some((item) => item.id === `custom:${number}`)) number += 1;
      state = {
        ...state,
        items: [
          ...state.items,
          {
            id: `custom:${number}`,
            label: command.slice(0, 80),
            kind: 'custom',
            source: 'custom',
            command,
            enabled: true,
          },
        ],
      };
    }
    return { state };
  }

  private save(taskId: string, run: ChatCheckRun) {
    try {
      this.host.update(taskId, (thread) => {
        const current = thread.checks ?? { items: [], runs: [], detectedAt: null };
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
   * merged copy is named). A failure does not end the list: the fix message carries every
   * failure. Stop ends the open check and skips the rest.
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
      if (!commandsAllowed(thread)) return { outcome: 'denied', runs: [], brief: null };
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
    if (!words)
      return end({
        status: 'failed',
        reason: 'The command needs a shell, which checks never use.',
      });
    try {
      const root = this.host.projectPath(task.projectId);
      if (!root || !thread.base)
        return end({ status: 'failed', reason: 'The project or its base commit is missing.' });
      let pin: { path: string; sha256: string };
      try {
        pin = executablePin(words[0]);
      } catch {
        return end({ status: 'failed', reason: `Could not find ${words[0]} on this computer.` });
      }
      const where = realpathSync(directory ?? this.host.scratchDirectory(task.id));
      const environment: Record<string, string> = {
        CI: '1',
        LANG: 'C',
        NO_COLOR: '1',
        TMPDIR: tmpdir(),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      };
      const definition: ProjectCommandDefinition = {
        version: 1,
        operationId: this.ids('cmd'),
        recipe: RECIPE[item.kind],
        source: {
          projectId: task.projectId,
          repositoryRoot: realpathSync(root),
          baseRevision: thread.base,
        },
        scratchRoot: where,
        cwd: where,
        executable: pin.path,
        executableIdentity: 'verified-prelaunch-sha256',
        executableSha256: pin.sha256,
        argv: words.slice(1),
        environment,
        output: { stdout: 'artifact', stderr: 'artifact', chunkBytes: 65536 },
      };
      const execution = startProjectCommand(definition, {
        runner: createOwnedProjectCommandRunner({
          deadlineMs: this.host.deadlineMs ?? DEADLINE_MS,
        }),
        // Ownership stays with the shared owner. A restart reads the run as failed.
        lifecycle: { intent: () => {}, owned: () => {}, quiescent: () => {} },
        publishStream: async (source, options) => {
          const bytes = await this.host.artifacts.publishStream(eager(source, keep), {
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
        },
      });
      entry.stop = execution.stop;
      if (entry.stopped) execution.stop();
      const result = await execution.result;
      const named = (hash: string | undefined) => {
        const artifact = artifacts.find((value) => value.hash === hash);
        return artifact ? { id: artifact.id, hash: artifact.hash, bytes: artifact.bytes } : null;
      };
      const saved = { stdout: named(result.stdout?.hash), stderr: named(result.stderr?.hash) };
      if (result.status === 'succeeded') return end({ status: 'passed', exitCode: 0, ...saved });
      if (result.status === 'cancelled')
        return end({
          status: 'stopped',
          reason: 'You stopped it.',
          exitCode: result.code,
          ...saved,
        });
      const reasons: Record<string, string> = {
        'nonzero-exit': `Exit code ${result.code}.`,
        signal: `Ended by signal ${result.signal}.`,
        deadline: `Timed out after ${Math.round((this.host.deadlineMs ?? DEADLINE_MS) / 60_000)} minutes.`,
        launch: 'The command could not start.',
        output: 'The output could not be saved.',
        ownership: 'CrewKite could not confirm the process exited.',
      };
      return end({
        status: 'failed',
        reason: reasons[result.reason] ?? 'The command failed.',
        exitCode: result.code,
        ...saved,
      });
    } catch (error) {
      return end({
        status: 'failed',
        reason: error instanceof Error ? error.message.slice(0, 300) : 'The check could not run.',
      });
    }
  }
}

/**
 * Run the enabled checks of a thread in a merged copy, for the combined review before the
 * challenger. The copy is any directory the caller owns. The runs show on the thread's Checks
 * card like the others. `denied` means the thread does not allow commands, and `none` that no
 * check is switched on.
 */
export function runCombinedChecks(taskId: string, directory: string): Promise<ChecksOutcome> {
  if (!bound) return Promise.reject(new Error('The chat service has not started.'));
  return bound.run(taskId, 'combined', directory);
}
