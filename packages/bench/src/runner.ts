import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { connectController, createCommandKey, readControllerEndpoint } from '@crewkite/client/node';
import {
  ChatCatalogReadSchema,
  ChatChangesReadSchema,
  type ChatModelSelection,
  type ChatRole,
  ChatThreadReadSchema,
  type ChatTurn,
  type CommandResult,
  CommandSchema,
  ProjectSchema,
  TaskSchema,
} from '@crewkite/contracts';
import { startController } from '@crewkite/controller';
import { checkEnvironment, runChecks } from './checks.ts';
import { isVerified, type Task } from './manifest.ts';
import type { Exclusion, RunReport, TaskResult } from './report.ts';
import { type ScriptedPlan, scriptedAdapter } from './scripted.ts';
import {
  assertWorkOutsideRepositories,
  ceilingOf,
  copyTree,
  createProject,
  hasCommit,
  linkDependencies,
  placeHidden,
  repositoryOf,
} from './workspace.ts';

const actor = { id: 'terminal', kind: 'cli' } as const;
const ended = (state: ChatTurn['state']) =>
  state === 'done' || state === 'stopped' || state === 'failed';

export const REVIEW_TEXT =
  'Review the current changes in the scratch copy against the base commit. List your findings, most severe first, with the file and line for each. End your reply with one line that reads exactly `Findings: N`, where N is the number of findings you listed, or `Findings: 0` when there are none.';

export type RunOptions = {
  /** The checkout the harness runs from. Tasks with repository `self` read commits here. */
  self: string;
  /**
   * Work files and the controller home live under this folder for the length of the run. It must
   * be outside every repository, and the run refuses a folder inside the checkout. The caller
   * makes it with createWorkDirectory.
   */
  workDirectory: string;
  /**
   * What a work turn may do without asking. The default allows edits in the scratch copy and
   * leaves commands to ask, and nobody answers a question during a run. allow-all lets the client
   * run any command with the person's own permissions, so it is an explicit choice.
   */
  permissionPolicy?: 'allow-edits' | 'allow-all';
  selection: ChatModelSelection;
  tasks: readonly Task[];
  /** Exclusions found before the run, for example tasks that were not verified. */
  exclusions?: readonly Exclusion[];
  /** Run a review turn after each finished work turn and record its findings. */
  review?: boolean;
  /** Present for a scripted run. Absent means the person's own installed client does the work. */
  scripted?: ScriptedPlan;
  /** Per task limit for the work turn, in milliseconds. */
  timeoutMs: number;
  runId: string;
  now: () => number;
  keepWork?: boolean;
  /** Called after each task with the report so far, so a stopped run still leaves its record. */
  onProgress?: (report: RunReport) => void;
};

/** Wraps the controller commands the harness needs. Reads carry no revision, as the CLI's do. */
function connect(transport: Awaited<ReturnType<typeof connectController>>) {
  const send = (command: string, payload: unknown): Promise<CommandResult> =>
    transport.command(
      CommandSchema.parse({
        protocol: 1,
        key: createCommandKey(),
        actor,
        command,
        payload,
        ...(command.startsWith('Read') ? {} : { expectedRevision: 0 }),
      }),
    );
  const run = async (command: string, payload: unknown) => {
    const result = await send(command, payload);
    if (result.outcome !== 'applied' && result.outcome !== 'already-applied')
      throw new Error(`${command} was refused: ${result.next ?? result.reason ?? result.outcome}`);
    return result;
  };
  const read = async <T>(
    command: string,
    payload: unknown,
    schema: { parse(data: unknown): T },
  ): Promise<T> => {
    const { data } = await run(command, payload);
    const { kind: _kind, ...rest } = (data ?? {}) as Record<string, unknown>;
    return schema.parse(rest);
  };
  return {
    send,
    run,
    thread: (taskId: string) =>
      read('ReadChatThread', { taskId, limit: 200 }, ChatThreadReadSchema),
    changes: (taskId: string) => read('ReadChatChanges', { taskId }, ChatChangesReadSchema),
    catalog: () => read('ReadChatCatalog', {}, ChatCatalogReadSchema),
  };
}

/** Settles each thread's turns from the event stream. One subscription serves the whole run. */
async function watchTurns(transport: Awaited<ReturnType<typeof connectController>>) {
  const finished = new Map<string, Map<string, ChatTurn>>();
  const listeners = new Set<() => void>();
  const stop = await transport.subscribe('0', (event) => {
    if (event.type !== 'chat.turn' || !ended(event.payload.state)) return;
    const turns = finished.get(event.payload.taskId) ?? new Map<string, ChatTurn>();
    turns.set(event.payload.id, event.payload);
    finished.set(event.payload.taskId, turns);
    for (const listener of [...listeners]) listener();
  });
  return {
    count: (taskId: string) => finished.get(taskId)?.size ?? 0,
    /** Resolves with the turn that ended after `before` turns had ended, or null at the limit. */
    next(taskId: string, before: number, limitMs: number): Promise<ChatTurn | null> {
      return new Promise((resolve) => {
        const check = () => {
          const turns = finished.get(taskId);
          if (!turns || turns.size <= before) return;
          cleanup();
          resolve([...turns.values()].at(-1) ?? null);
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve(null);
        }, limitMs);
        const cleanup = () => {
          clearTimeout(timer);
          listeners.delete(check);
        };
        listeners.add(check);
        check();
      });
    },
    stop,
  };
}

const findingsOf = (text: string): number | null => {
  const match = /^Findings: (\d{1,6})\s*$/m.exec(text);
  return match ? Number(match[1]) : null;
};

const failureOf = (turn: ChatTurn) =>
  turn.failure ? { kind: turn.failure.kind, message: turn.failure.message } : null;

export function selectTasks(
  all: readonly Task[],
  spec: 'all' | readonly string[],
): { tasks: Task[]; exclusions: Exclusion[] } {
  if (spec === 'all') {
    const verified = all.filter(isVerified);
    return {
      tasks: verified,
      exclusions: all
        .filter((task) => !isVerified(task))
        .map((task) => ({
          taskId: task.id,
          reason: 'unverified' as const,
          detail: 'The task has no verification record, so `all` leaves it out. Name it to run it.',
        })),
    };
  }
  const byId = new Map(all.map((task) => [task.id, task]));
  const tasks: Task[] = [];
  const exclusions: Exclusion[] = [];
  for (const id of new Set(spec)) {
    const task = byId.get(id);
    if (task) tasks.push(task);
    else
      exclusions.push({ taskId: id, reason: 'unknown-task', detail: 'No task file has this id.' });
  }
  return { tasks, exclusions };
}

/** Runs the selected tasks one after another through the controller's chat thread path. */
export async function runBench(options: RunOptions): Promise<RunReport> {
  assertWorkOutsideRepositories(options.workDirectory, options.self);
  const permissionPolicy = options.permissionPolicy ?? 'allow-edits';
  const started = new Date(options.now()).toISOString();
  const report: RunReport = {
    version: 1,
    runId: options.runId,
    startedAt: started,
    finishedAt: null,
    mode: options.scripted ? 'scripted' : 'live',
    selection: options.selection,
    reviewStep: options.review === true,
    permissionPolicy,
    host: { node: process.version, platform: process.platform, arch: process.arch },
    results: [],
    exclusions: [...(options.exclusions ?? [])],
  };
  const home = join(options.workDirectory, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);

  // Git run from inside a scratch copy stops at the work folder's parent. The variable also goes
  // to every check. The clients build their own environment, so the folder outside any repository
  // is what keeps a turn away from the person's checkout.
  const ceiling = ceilingOf(options.workDirectory);
  const priorCeiling = process.env.GIT_CEILING_DIRECTORIES;
  const environment = checkEnvironment(options.workDirectory, ceiling);

  let current: Task | null = null;
  const { family } = options.selection;
  const runtime = await startController({
    home,
    ...(options.scripted
      ? {
          nativeProfiles: () => [],
          nativeSpawn: () => {
            throw new Error('A scripted run starts no provider client.');
          },
          chatAdapters: new Map([
            [family, scriptedAdapter(family, options.scripted, () => current) as never],
          ]),
        }
      : {}),
  });
  const transport = await connectController({ ...readControllerEndpoint(home), actor });
  process.env.GIT_CEILING_DIRECTORIES = ceiling;
  try {
    const api = connect(transport);
    const watch = await watchTurns(transport);
    let blocked: Exclusion['detail'] | null = null;
    if (!options.scripted) {
      const entry = (await api.catalog()).families.find((value) => value.family === family);
      if (!entry?.connected) blocked = entry?.reason ?? `${family} is not connected.`;
    }
    for (const task of options.tasks) {
      const excluded = blocked
        ? { reason: 'family-not-connected' as const, detail: blocked }
        : preflight(task, options.self);
      if (excluded) {
        report.exclusions.push({ taskId: task.id, ...excluded });
        options.onProgress?.(report);
        continue;
      }
      current = task;
      report.results.push(
        await runTask(task, options, api, watch, home, permissionPolicy, environment),
      );
      current = null;
      options.onProgress?.(report);
    }
    watch.stop();
  } finally {
    transport.close();
    await runtime.close();
    if (priorCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = priorCeiling;
    if (!options.keepWork) rmSync(options.workDirectory, { recursive: true, force: true });
  }
  report.finishedAt = new Date(options.now()).toISOString();
  options.onProgress?.(report);
  return report;
}

function preflight(task: Task, self: string): Pick<Exclusion, 'reason' | 'detail'> | null {
  const repository = repositoryOf(task, self);
  if (!existsSync(repository))
    return {
      reason: 'repository-missing',
      detail: `${repository} does not exist on this machine.`,
    };
  for (const commit of [task.base, ...(task.solution ? [task.solution] : [])])
    if (!hasCommit(repository, commit))
      return { reason: 'commit-missing', detail: `${commit} is not in ${repository}.` };
  return null;
}

type Api = ReturnType<typeof connect>;
type Watch = Awaited<ReturnType<typeof watchTurns>>;

async function runTask(
  task: Task,
  options: RunOptions,
  api: Api,
  watch: Watch,
  home: string,
  permissionPolicy: 'allow-edits' | 'allow-all',
  environment: NodeJS.ProcessEnv,
): Promise<TaskResult> {
  const result: TaskResult = {
    taskId: task.id,
    difficulty: task.difficulty,
    verified: isVerified(task),
    baseFailure: task.verification?.baseFailure ?? null,
    outcome: 'errored',
    turn: { state: 'not-started', failure: null },
    wallMs: 0,
    tokensIn: null,
    tokensOut: null,
    changedFiles: null,
    checks: [],
    review: null,
    bugsFoundAfter: null,
  };
  try {
    const repository = repositoryOf(task, options.self);
    const project = join(options.workDirectory, 'projects', task.id);
    createProject(repository, task.base, project);
    const registered = ProjectSchema.parse(
      (await api.run('RegisterProject', { path: project })).entity,
    );
    const created = TaskSchema.parse(
      (
        await api.run('CreateTask', {
          projectId: registered.id,
          title: task.title.slice(0, 80),
          outcome: task.text.slice(0, 4096),
          criteria: ['The request in this thread is addressed.'],
        })
      ).entity,
    );
    // Nobody is there to answer a question, so a command the policy does not allow waits for the
    // limit and the turn is recorded as timed out.
    await api.run('ConfigureChatThread', { taskId: created.id, permissionPolicy });

    const turn = await sendAndWait(api, watch, created.id, task.text, 'assistant', options);
    result.wallMs = turn.wallMs;
    result.turn = { state: turn.state, failure: turn.failure };
    result.tokensIn = turn.tokensIn;
    result.tokensOut = turn.tokensOut;
    if (turn.state === 'timed-out') {
      result.outcome = 'timed-out';
      return result;
    }
    if (turn.state !== 'done') return result;

    result.changedFiles = (await api.changes(created.id)).files.length;
    if (options.review) {
      const review = await sendAndWait(api, watch, created.id, REVIEW_TEXT, 'reviewer', options);
      result.review = {
        state: review.state,
        findings: findingsOf(review.text),
        wallMs: review.wallMs,
        tokensIn: review.tokensIn,
        tokensOut: review.tokensOut,
        text: review.text.slice(0, 20_000),
      };
    }

    const scratch = join(home, 'chat', created.id, 'scratch');
    if (!existsSync(scratch)) throw new Error('The scratch copy is missing after the turn.');
    const checkDirectory = join(options.workDirectory, 'checks', task.id);
    copyTree(scratch, checkDirectory);
    if (task.solution) placeHidden(repository, task.solution, task.hidden, checkDirectory);
    linkDependencies(repository, checkDirectory);
    result.checks = await runChecks(checkDirectory, task.checks, options.now, environment);
    result.outcome = result.checks.every((check) => check.passed) ? 'passed' : 'failed';
  } catch (error) {
    result.outcome = 'errored';
    result.turn.failure ??= {
      kind: 'harness',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return result;
}

async function sendAndWait(
  api: Api,
  watch: Watch,
  taskId: string,
  text: string,
  role: ChatRole,
  options: RunOptions,
) {
  const before = watch.count(taskId);
  const began = options.now();
  const sent = await api.send('SendChatMessage', {
    taskId,
    text,
    role,
    selection: options.selection,
    files: [],
  });
  if (sent.outcome !== 'applied')
    return {
      state: 'failed' as const,
      failure: { kind: 'refused', message: sent.next ?? sent.reason ?? sent.outcome },
      wallMs: 0,
      tokensIn: null,
      tokensOut: null,
      text: '',
    };
  let turn = await watch.next(taskId, before, options.timeoutMs);
  let timedOut = false;
  // The wall time of a turn that hit the limit is the limit, not the wait for it to stop.
  let limitWallMs = 0;
  if (!turn) {
    timedOut = true;
    limitWallMs = Math.max(0, Math.round(options.now() - began));
    const open = (await api.thread(taskId)).thread.activeTurnId;
    if (open) await api.send('StopChatTurn', { taskId, turnId: open });
    // A stopped turn settles quickly. If it does not, the record keeps the timeout without it.
    turn = await watch.next(taskId, before, 60_000);
  }
  const wallMs = timedOut ? limitWallMs : Math.max(0, Math.round(options.now() - began));
  const read = await api.thread(taskId);
  const settled = turn ? read.turns.find((value) => value.id === turn.id) : undefined;
  const message = settled
    ? read.messages.find((value) => value.id === settled.assistantMessageId)
    : undefined;
  const state: 'done' | 'stopped' | 'failed' | 'timed-out' = timedOut
    ? 'timed-out'
    : ((settled?.state as 'done' | 'stopped' | 'failed') ?? 'failed');
  return {
    state,
    failure: settled ? failureOf(settled) : null,
    wallMs,
    tokensIn: settled?.stats?.tokensIn ?? null,
    tokensOut: settled?.stats?.tokensOut ?? null,
    text: message?.text ?? '',
  };
}
