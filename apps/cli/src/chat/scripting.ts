import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  followWorkflow,
  sinceNextTurn,
  sinceUnderWay,
  type WorkflowResult,
} from '@crewkite/client';
import {
  type AgentEvent,
  type ChatAdmission,
  type ChatAttachment,
  type ChatCatalogRead,
  ChatEffortSchema,
  type ChatFailure,
  ChatFamilySchema,
  type ChatModelSelection,
  ChatPermissionPolicySchema,
  type ChatThreadRead,
  type ChatTurn,
  CLI_EXIT,
  CLI_JSON_LINE_VERSION,
  type CliJsonLine,
  CliJsonLineSchema,
  type CliThreadEvent,
  type CommandResult,
  ConnectionIdSchema,
  ConnectionRoleSchema,
  type Event,
  ProjectIdSchema,
  ProjectSchema,
  rankFamilies,
  TaskIdSchema,
} from '@crewkite/contracts';
import {
  CHARGES_APPLY,
  connectionAttention,
  connectionName,
  isApiConnection,
  roleFamily,
} from '../../../desktop/src/renderer/settings/connection-view.ts';
import { pausedQueueLine } from '../../../desktop/src/renderer/thread/thread-state.ts';
import { preparationResultLine } from '../../../desktop/src/renderer/thread/work-view.ts';
import { familyNames } from '../interactive/theme.ts';
import { crewkiteHome, loadSettings } from '../settings.ts';
import { callerDirectory, checkoutAt, projectsForCheckout } from './checkout.ts';
import { applied, type ChatClient, CommandRefused, threadMessage } from './client.ts';

// `crewkite thread ...` and `crewkite -p`. Every command goes through the chat client, so the
// controller decides each one exactly as it decides the desktop's. Text goes to stdout, progress
// and questions to stderr, and --json writes one CliJsonLine per line.

export type Io = { out: (text: string) => void | Promise<void>; err: (text: string) => void };
export type Connect = (home: string) => Promise<ChatClient>;

export const threadHelp = `Usage: crewkite thread new <project-id> <message> [--model family[/model[:effort]]] [--permission-policy ask|allow-edits|allow-all] [--file path ...] [--watch] [--json]
       crewkite thread send <task-id> <message> [--model ...] [--permission-policy ...] [--file path ...] [--watch] [--json]
       crewkite thread watch <task-id> [--follow] [--json]
       crewkite thread permit <task-id> <request-id> [--thread] [--json]
       crewkite thread deny <task-id> <request-id> [--json]
       crewkite thread stop <task-id> [--json]
       crewkite thread accept <task-id> <branch> [--message text] [--json]
       crewkite thread push <task-id> [--remote name] [--commit sha] --confirm [--json]
       crewkite thread pr <task-id> [--title text] [--body text] [--json]
       crewkite thread merge-check <task-id> [--base branch] [--remote name] [--json]
       crewkite thread prepare <task-id> [--json]
       crewkite thread use-api <task-id> <connection-id> [--role builder|reviewer|challenger|fixer|orchestrator] --confirm [--json]
       crewkite thread use-api <task-id> --off [--role ...] [--json]
       crewkite thread release-check <task-id> --confirm --note <text> [--json]
       crewkite thread list [--json]
       crewkite thread show <task-id> [--json]
       crewkite thread changes <task-id> [--json]
       crewkite -p <message> [--thread task-id | --project project-id | --register] [--model ...] [--permission-policy ...] [--file path ...] [--json]

Every command takes --home path. Exit status: 0 done, 1 failed (an error, a lost connection or a
failed workflow), 2 nothing was done (arguments, a refusal, or a workflow that waits on a question
or is blocked), 3 the followed workflow was stopped. A new
thread asks before each action unless --permission-policy names another policy for this run. A
permission request waits for crewkite thread permit or deny, the interactive CLI or the desktop.
merge-check merges the accepted commit onto the base of the thread's pull request, or --base,
fetched from the remote the thread pushed to. A conflict moves the merge into the thread's copy
and starts the fixer, and Accept then takes the result. prepare copies the project's installed
dependencies into the thread's copy so its checks can run. It installs nothing and answers when
the copy is done. use-api picks an API connection from crewkite connections for the thread's
turns on its provider, or with --role for one role's turns. Provider charges apply. Without
--confirm it only says what it would do, and --off removes the choice.

release-check   Release a thread held by a check whose process CrewKite lost track of
`;

/** Control characters in model or tool text never reach the terminal as control characters. */
export const terminalText = (value: string) =>
  value.replace(/\p{Cc}/gu, (character) =>
    ['\n', '\t'].includes(character)
      ? character
      : `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

export function jsonLine(line: CliJsonLine): string {
  return `${JSON.stringify(CliJsonLineSchema.parse(line))}\n`;
}

/** What `thread stop` says when messages wait behind the stop, or null when none do. */
export function waitingQueueLine(result: CommandResult): string | null {
  return pausedQueueLine(result.data?.kind === 'chat-queue' ? result.data.messages.length : 0);
}

const refusalReasons = new Set([
  'credits-paused',
  'no-eligible-provider',
  'provider-not-ready',
  'ownership-unknown',
  'thread-busy',
]);

/**
 * What a refused send says as an admission. The controller's reason is the code and its next step
 * is the next step. The message is rebuilt here for the two refusals that have fixed copy.
 */
export function refusedAdmission(
  result: CommandResult,
  family: ChatModelSelection['family'],
): Extract<ChatAdmission, { outcome: 'refused' }> {
  const reason = refusalReasons.has(result.reason ?? '')
    ? (result.reason as Extract<ChatAdmission, { outcome: 'refused' }>['reason'])
    : 'blocked';
  const message =
    reason === 'credits-paused'
      ? `${familyNames[family]} is out of included allowance and credit spending is off.`
      : reason === 'no-eligible-provider'
        ? 'No connected provider can take this turn.'
        : (result.next ?? result.reason ?? 'The message was not sent.');
  return {
    outcome: 'refused',
    reason,
    message,
    next: result.next ?? 'Read the thread, then send again.',
  };
}

/**
 * Where the message went, read from the thread after the controller applied the send: the turn it
 * started, the family that took it when that is not the one asked for, or its place in the queue.
 * Null when the thread shows neither, as when the answer was lost.
 */
function admissionAfter(
  before: ChatThreadRead,
  after: ChatThreadRead,
  text: string,
  family: ChatModelSelection['family'],
): ChatAdmission | null {
  const known = new Set(before.messages.map((message) => message.id));
  const sent = after.messages.find(
    (message) => message.author.kind === 'user' && !known.has(message.id) && message.text === text,
  );
  const turn = sent && after.turns.find((value) => value.userMessageId === sent.id);
  if (turn)
    return turn.selection.family === family
      ? { outcome: 'started', turnId: turn.id }
      : { outcome: 'handed-on', turnId: turn.id, from: family, to: turn.selection.family };
  const queued = after.thread.queued.find((item) => item.text === text);
  return queued ? { outcome: 'queued', messageId: queued.id } : null;
}

export const resultLine = (
  command: string,
  result: CommandResult,
  taskId: string | null,
  admission?: ChatAdmission | null,
): CliJsonLine => ({
  v: CLI_JSON_LINE_VERSION,
  kind: 'result',
  command,
  outcome: result.outcome,
  reason: result.reason ?? null,
  next: result.next ?? null,
  taskId,
  ...(result.data === undefined ? {} : { data: result.data }),
  ...(admission ? { admission } : {}),
});

/** One controller event as a thread event line, or null when it belongs to no thread view. */
export function threadEvent(event: Event, taskId: string): CliThreadEvent | null {
  if (event.taskId !== taskId) return null;
  if (event.type === 'agent.event')
    return { type: 'agent.event', cursor: event.cursor, payload: event.payload };
  if (event.type === 'chat.turn')
    return { type: 'chat.turn', cursor: event.cursor, payload: event.payload };
  if (event.type === 'chat.thread')
    return { type: 'chat.thread', cursor: event.cursor, payload: event.payload };
  if (event.type === 'conversation.entry') {
    const message = threadMessage(event.payload);
    return message ? { type: 'message', cursor: event.cursor, payload: message } : null;
  }
  return null;
}

/** `family`, `family/model` or `family/model:effort`. */
export function parseModelFlag(
  value: string,
): { family: ChatModelSelection['family']; model: string | null; effort: string | null } | null {
  const match = /^([a-z]+)(?:\/([^:]+)(?::([a-z][a-z0-9._-]*))?)?$/.exec(value);
  const family = ChatFamilySchema.safeParse(match?.[1]);
  if (!match || !family.success) return null;
  if (match[3] && !ChatEffortSchema.safeParse(match[3]).success) return null;
  return { family: family.data, model: match[2] ?? null, effort: match[3] ?? null };
}

/**
 * The model a message runs on: the --model flag, else the saved default in cli.json, else the
 * connected family with the most allowance left. The controller checks the result again.
 */
export function chooseSelection(
  catalog: ChatCatalogRead,
  flag: string | undefined,
  saved: ChatModelSelection | null,
  now: number,
): ChatModelSelection {
  if (flag !== undefined) {
    const parsed = parseModelFlag(flag);
    if (!parsed) throw new UsageError('Use --model family, family/model or family/model:effort.');
    const entry = catalog.families.find((value) => value.family === parsed.family);
    if (!entry?.connected)
      throw new UsageError(`${parsed.family} is not connected. ${entry?.reason ?? ''}`.trim());
    const model =
      entry.models.find((value) => value.model === (parsed.model ?? entry.defaultModel)) ??
      (parsed.model ? null : entry.models[0]);
    if (model)
      return {
        family: parsed.family,
        model: model.model,
        effort: (parsed.effort as ChatModelSelection['effort'] | null) ?? model.defaultEffort,
      };
    if (!parsed.model || !typedModel(parsed.family, parsed.model))
      throw new UsageError(`${parsed.family} does not list ${parsed.model ?? 'a model'}.`);
    return {
      family: parsed.family,
      model: parsed.model,
      effort: (parsed.effort as ChatModelSelection['effort'] | null) ?? 'default',
    };
  }
  if (saved) {
    const entry = catalog.families.find((value) => value.family === saved.family);
    if (
      entry?.connected &&
      (entry.models.some((value) => value.model === saved.model) ||
        typedModel(saved.family, saved.model))
    )
      return saved;
  }
  const [best] = rankFamilies(catalog.families, [], undefined, 'most-left', now);
  const model = best?.models.find((value) => value.model === best.defaultModel) ?? best?.models[0];
  if (!best || !model)
    throw new UsageError('No provider is connected. Connect one in the desktop Settings.');
  return { family: best.family, model: model.model, effort: model.defaultEffort };
}

export class UsageError extends Error {}

/** A thread ID in the shape the contract takes, or a one line refusal before any command runs. */
export function threadIdArg(value: string | undefined): string {
  if (!value) throw new UsageError('Give the thread ID.');
  if (!TaskIdSchema.safeParse(value).success)
    throw new UsageError(
      'That is not a thread ID. Thread IDs start with tsk_. List them with crewkite thread list.',
    );
  return value;
}

/** A project ID in the shape the contract takes, or a one line refusal before any command runs. */
export function projectIdArg(value: string | undefined): string {
  if (!value) throw new UsageError('Give the project ID.');
  if (!ProjectIdSchema.safeParse(value).success)
    throw new UsageError(
      'That is not a project ID. Project IDs start with prj_. Add one with crewkite project add <path>.',
    );
  return value;
}

/**
 * A cloud family takes a model ID its list does not hold, as the desktop's typed model does, and
 * the client rejects it on the first turn if it is wrong. A Local model has to be on this computer.
 * The pattern is the renderer's MODEL_ID.
 */
const typedModel = (family: ChatModelSelection['family'], model: string) =>
  family !== 'local' && /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,199}$/.test(model);

type Follow = {
  /** The text of the message whose turn ends the watch. Null follows the running turn. */
  text: string | null;
  json: boolean;
  /** Keep streaming after the turn ends. */
  forever?: boolean;
  /**
   * A second reader of the same stream. A client holds one subscription, so a follower that needs
   * the raw events fills this in and receives each one from here.
   */
  tap?: { event?: (event: Event) => void; resync?: () => void };
};

/**
 * Streams one thread from `read` onwards and settles with the status of the turn it follows. The
 * turn is the one started by the message with `follow.text`, matched by the stored message or the
 * queued entry, or the running turn when no text is given.
 */
export function followThread(
  client: ChatClient,
  read: ChatThreadRead,
  io: Io,
  follow: Follow,
): {
  done: Promise<{ status: 'done' | 'stopped' | 'failed'; turnId: string | null }>;
  /** Follow this turn from now on, the one an admission named. Matching the text stops. */
  adopt: (id: string) => void;
  stop: () => void;
} {
  const taskId = read.thread.taskId;
  const known = new Set(read.messages.map((message) => message.id));
  let messageId: string | null = null;
  let turnId: string | null = follow.text === null ? read.thread.activeTurnId : null;
  const settled = Promise.withResolvers<{
    status: 'done' | 'stopped' | 'failed';
    turnId: string | null;
  }>();
  const finishedTurns = new Set<string>();
  const thinking = new Set<string>();
  const early = new Map<string, AgentEvent[]>();
  const finish = (status: 'done' | 'stopped' | 'failed', failure: ChatFailure | null) => {
    if (!turnId || finishedTurns.has(turnId)) return;
    finishedTurns.add(turnId);
    if (follow.json)
      void io.out(
        jsonLine({ v: CLI_JSON_LINE_VERSION, kind: 'turn-end', taskId, turnId, status, failure }),
      );
    else if (failure)
      io.err(
        `\n${terminalText(failure.message)}${failure.providerMessage ? `\n${terminalText(failure.providerMessage)}` : ''}\n${terminalText(failure.nextAction)}\n`,
      );
    else if (status === 'stopped') io.err('\nStopped.\n');
    if (!follow.forever) settled.resolve({ status, turnId });
  };
  const ended = (turn: ChatTurn) =>
    turn.state === 'done' || turn.state === 'stopped' || turn.state === 'failed';
  const onAgent = (event: AgentEvent) => {
    if (follow.json || event.turnId !== turnId) return;
    switch (event.type) {
      case 'text.delta':
        void io.out(terminalText(event.text));
        break;
      case 'text.completed':
        void io.out('\n');
        break;
      case 'thinking.delta':
        if (!thinking.has(event.itemId)) io.err('Thinking\n');
        thinking.add(event.itemId);
        break;
      case 'tool.started':
        io.err(`${terminalText(event.title)}\n`);
        break;
      case 'tool.completed':
        if (event.status !== 'ok') io.err(`  ${event.status}\n`);
        break;
      case 'permission.requested':
        io.err(
          `Permission requested: ${terminalText(event.question)}\n  Options: ${event.options.map((option) => option.label).join(', ')}\n  crewkite thread permit ${taskId} ${event.requestId}\n  crewkite thread deny ${taskId} ${event.requestId}\n`,
        );
        break;
      case 'provider.notice':
        if (!event.trace) io.err(`${terminalText(event.message)}\n`);
        break;
      default:
        break;
    }
  };
  let unsubscribe: (() => void) | null = null;
  const lost = () =>
    settled.reject(
      new Error(
        `The connection to the controller ended. The turn may still be running; read it with crewkite thread show ${taskId}.`,
      ),
    );
  const stopLost = client.transport.onReconnectExhausted?.(lost);
  // The client retries for about a minute before it gives up. One line says why nothing prints.
  let announced = false;
  const stopOffline = client.transport.onConnection?.((state) => {
    if (state === 'connected') announced = false;
    else if (state === 'offline' && !announced) {
      announced = true;
      io.err('Lost the controller. Reconnecting for about a minute.\n');
    }
  });
  // After a gap in the stream the thread is read again, so a turn that ended meanwhile settles.
  const resynced = () =>
    void client.readThread(taskId).then((fresh) => {
      const turn = fresh.turns.find(
        (value) => value.id === turnId || (!turnId && value.userMessageId === messageId),
      );
      if (turn && !turnId) turnId = turn.id;
      if (turn && ended(turn)) finish(turn.state as 'done' | 'stopped' | 'failed', turn.failure);
    }, lost);
  void client.transport
    .subscribe(
      read.cursor,
      (event) => {
        follow.tap?.event?.(event);
        const line = threadEvent(event, taskId);
        if (!line) return;
        if (follow.json)
          void io.out(jsonLine({ v: CLI_JSON_LINE_VERSION, kind: 'event', taskId, event: line }));
        if (line.type === 'message' && follow.text !== null && !messageId) {
          const message = line.payload;
          if (
            message.author.kind === 'user' &&
            !known.has(message.id) &&
            message.text === follow.text
          )
            messageId = message.id;
        } else if (line.type === 'chat.thread' && follow.text !== null && !messageId) {
          const queued = line.payload.queued.find((item) => item.text === follow.text);
          if (queued) messageId = queued.id;
        } else if (line.type === 'chat.turn') {
          const turn = line.payload;
          // Following a thread, each new turn's record names the turn to print next.
          const next = follow.forever && !ended(turn) && turn.id !== turnId;
          if (next || (!turnId && messageId && turn.userMessageId === messageId)) {
            turnId = turn.id;
            // The record of a turn can follow its first events. Those wait here until it names it.
            for (const event of early.get(turn.id) ?? []) onAgent(event);
            early.clear();
          }
          if (turn.id === turnId && ended(turn))
            finish(turn.state as 'done' | 'stopped' | 'failed', turn.failure);
        } else if (line.type === 'agent.event') {
          const event = line.payload;
          if ((!turnId || (follow.forever && event.turnId !== turnId)) && !follow.json)
            early.set(event.turnId, [...(early.get(event.turnId) ?? []), event].slice(-10_000));
          onAgent(event);
          if (event.type === 'turn.completed' && event.turnId === turnId)
            finish(
              event.stopReason === 'stopped' || event.failure?.kind === 'stopped'
                ? 'stopped'
                : event.stopReason === 'done' && !event.failure
                  ? 'done'
                  : 'failed',
              event.failure?.kind === 'stopped' ? null : event.failure,
            );
        }
      },
      () => {
        follow.tap?.resync?.();
        resynced();
      },
    )
    .then(
      (stop) => {
        unsubscribe = stop;
      },
      (error) => settled.reject(error),
    );
  return {
    done: settled.promise,
    adopt: (id) => {
      if (turnId) return;
      turnId = id;
      for (const event of early.get(id) ?? []) onAgent(event);
      early.clear();
      resynced();
    },
    stop: () => {
      unsubscribe?.();
      stopLost?.();
      stopOffline?.();
    },
  };
}

/**
 * Follows the whole workflow of a thread from `read` and prints each turn on the way. It settles
 * when the workflow ends: the turn, its crew chain, plan slices and checks. The turn stream and
 * the workflow follow the same thread, and a lost connection rejects from either.
 */
function followWorkflowOf(
  client: ChatClient,
  read: ChatThreadRead,
  io: Io,
  follow: Omit<Follow, 'forever' | 'tap'>,
  since: number,
) {
  const tap: NonNullable<Follow['tap']> = {};
  const turns = followThread(client, read, io, { ...follow, forever: true, tap });
  const workflow = followWorkflow(
    {
      readThread: (taskId) => client.readThread(taskId),
      subscribe: async (_after, onEvent, onResync) => {
        tap.event = onEvent;
        tap.resync = onResync;
        return () => {
          tap.event = undefined;
          tap.resync = undefined;
        };
      },
      onLost: (listener) => client.transport.onReconnectExhausted?.(listener) ?? (() => {}),
    },
    read,
    // A permission request waits for crewkite thread permit or deny, or the desktop.
    { since, keepWaiting: ['permission'] },
  );
  return {
    adopt: turns.adopt,
    stop: () => {
      turns.stop();
      workflow.stop();
    },
    done: Promise.race([workflow.done, turns.done.then(() => never)]).then((result) => {
      if (result === never) throw new Error('The turn stream ended before the workflow did.');
      if (!follow.json) io.err(workflowLine(result as WorkflowResult));
      return result as WorkflowResult;
    }),
  };
}
const never = Symbol('never');

/** One line on stderr that says how the workflow ended, with the steps it saw. */
export function workflowLine(result: WorkflowResult): string {
  const how =
    result.state === 'done'
      ? 'Done.'
      : result.state === 'waiting'
        ? `Waiting on you (${result.on}): ${terminalText(result.detail)}`
        : result.state === 'blocked'
          ? `Blocked (${result.reason}): ${terminalText(result.detail)}`
          : result.state === 'failed'
            ? `Failed at ${terminalText(result.step)}: ${terminalText(result.detail)}`
            : `Stopped at ${terminalText(result.step)}${result.cause ? ` (${result.cause})` : ''}.`;
  const steps = result.steps
    .map((step) =>
      step.kind === 'turn'
        ? `${step.role} ${step.state}`
        : step.kind === 'slice'
          ? `slice ${step.id} ${step.status}`
          : `check ${terminalText(step.label)} ${step.status}`,
    )
    .join(', ');
  return `\n${how}${steps ? ` Steps: ${steps}.` : ''}\n`;
}

/**
 * The exit code of a workflow. A workflow that waits on the person or is blocked did nothing
 * more on its own, so it exits as a request that was not carried out.
 */
export function workflowExit(result: WorkflowResult): number {
  if (result.state === 'done') return CLI_EXIT.done;
  if (result.state === 'failed') return CLI_EXIT.failed;
  if (result.state === 'stopped') return CLI_EXIT.stopped;
  return CLI_EXIT.notDone;
}

/**
 * The registered project of the checkout the command ran in. Only a project the controller
 * already holds is used. A checkout it does not know needs --project, or --register to register
 * it, which starts no work.
 */
export async function projectHere(
  client: ChatClient,
  directory: string,
  env: NodeJS.ProcessEnv,
  register: boolean,
  io: Io,
): Promise<string> {
  const checkout = checkoutAt(directory, env);
  if (!checkout)
    throw new UsageError(
      `${directory} is not inside a Git checkout. Pass --project <project-id> or --thread <task-id>.`,
    );
  if (register) {
    const result = await client.send('RegisterProject', { path: checkout.root });
    const project = ProjectSchema.safeParse(result.entity);
    if (!applied(result) || !project.success) throw new CommandRefused(result);
    if (result.outcome === 'applied')
      io.err(`Registered ${checkout.root} as project ${project.data.id}.\n`);
    return project.data.id;
  }
  const matching = await projectsForCheckout(client, checkout);
  if (matching.length === 1) return matching[0].id;
  if (matching.length > 1)
    throw new UsageError(
      `More than one project matches ${checkout.root}: ${matching.map((project) => project.id).join(', ')}. Pass --project <project-id>.`,
    );
  throw new UsageError(
    `${checkout.root} is not a registered project. Pass --register to register it, or --project <project-id>.`,
  );
}

/** Reads the permission policy flag. Nothing applies a policy the person did not name for this run. */
function policyFlag(value: string | undefined) {
  if (value === undefined) return null;
  const parsed = ChatPermissionPolicySchema.safeParse(value);
  if (!parsed.success)
    throw new UsageError('Use --permission-policy ask, allow-edits or allow-all.');
  return parsed.data;
}

/** Applies a policy named on the command line, then says which policy the thread runs with. */
async function applyPolicy(
  client: ChatClient,
  io: Io,
  taskId: string,
  policy: ReturnType<typeof policyFlag>,
) {
  if (policy) await client.configure({ taskId, permissionPolicy: policy });
  const read = await client.readThread(taskId);
  io.err(`Permission policy: ${read.thread.permissionPolicy}\n`);
}

/**
 * Removes a thread this command created when its first message was never accepted, so a refusal
 * leaves no empty thread behind. The controller refuses to delete a thread that has a reply
 * running, so a thread that did start work stays.
 */
async function dropThread(client: ChatClient, taskId: string): Promise<boolean> {
  try {
    return applied(await client.send('DeleteChatThread', { taskId }));
  } catch {
    return false;
  }
}

/** Runs a step before the first message and drops the thread this command made when it throws. */
async function withThreadDropped(
  client: ChatClient,
  taskId: string,
  created: boolean,
  step: () => Promise<unknown>,
) {
  try {
    await step();
  } catch (error) {
    if (created) await dropThread(client, taskId);
    throw error;
  }
}

/** Starts one message and, with `watch`, follows its turn. Returns the exit code. */
async function sendAndFollow(
  client: ChatClient,
  io: Io,
  input: {
    taskId: string;
    text: string;
    selection: ChatModelSelection;
    files: string[];
    json: boolean;
    watch: boolean;
    command: string;
    /** True when this command made the thread, so a first message that is refused removes it. */
    created: boolean;
  },
): Promise<number> {
  const before = await client.readThread(input.taskId);
  const follow = input.watch
    ? followWorkflowOf(
        client,
        before,
        io,
        { text: input.text, json: input.json },
        sinceNextTurn(before),
      )
    : null;
  try {
    const stored: ChatAttachment[] = [];
    await withThreadDropped(client, input.taskId, input.created, async () => {
      for (const path of input.files)
        stored.push(await client.importAttachment(input.taskId, resolve(path)));
    });
    const result = await client.send('SendChatMessage', {
      taskId: input.taskId,
      text: input.text,
      selection: input.selection,
      files: stored,
    });
    // An unknown outcome may be a message the controller accepted, so that thread stays.
    const refused = !applied(result) && result.outcome !== 'outcome-unknown';
    // The id is printed unless the thread was removed, so a thread that stays can be found.
    const removed = refused && input.created && (await dropThread(client, input.taskId));
    // The turn id comes from the thread the controller just changed, never from a wait that a
    // refused send would leave hanging.
    const admission = refused
      ? refusedAdmission(result, input.selection.family)
      : applied(result) && (input.json || follow)
        ? await client.readThread(input.taskId).then(
            (after) => admissionAfter(before, after, input.text, input.selection.family),
            // The line is advice. A lost connection surfaces from the wait on the turn.
            () => null,
          )
        : null;
    if (input.json)
      await io.out(jsonLine(resultLine(input.command, result, input.taskId, admission)));
    else if (!input.watch && !removed) await io.out(`${input.taskId}\n`);
    if (!applied(result)) {
      if (!input.json)
        io.err(
          `${admission?.outcome === 'refused' ? `${admission.message} ${admission.next}` : (result.next ?? result.reason ?? 'The message was not sent.')}\n`,
        );
      return CLI_EXIT.notDone;
    }
    if (!follow) return 0;
    if (admission && 'turnId' in admission) follow.adopt(admission.turnId);
    if (!input.json && result.next) io.err(`${result.next}\n`);
    return workflowExit(await follow.done);
  } finally {
    follow?.stop();
  }
}

function threadSummaryText(read: ChatThreadRead): string {
  const thread = read.thread;
  const lines = [
    `Thread ${thread.taskId}`,
    `Model ${thread.selection ? `${thread.selection.family}/${thread.selection.model}` : 'not chosen'}`,
    `Permission policy ${thread.permissionPolicy}, flight ${thread.flightMode}`,
    thread.activeTurnId ? `Running turn ${thread.activeTurnId}` : 'No turn running',
    ...(thread.queuePaused ? [pausedQueueLine(thread.queued.length) ?? ''] : []),
    ...thread.queued.map((message) => `Queued: ${terminalText(message.text.split('\n')[0])}`),
  ];
  for (const message of read.messages) {
    const who =
      message.author.kind === 'user'
        ? 'You'
        : message.author.kind === 'assistant'
          ? `${message.author.family}/${message.author.model}`
          : 'CrewKite';
    lines.push('', `${who}:`, terminalText(message.text));
  }
  for (const event of read.liveEvents)
    if (event.type === 'permission.requested')
      lines.push('', `Permission requested ${event.requestId}: ${terminalText(event.question)}`);
  return `${lines.join('\n')}\n`;
}

/** Open permission requests on the running turn, from the live events of a thread read. */
export function openRequests(read: ChatThreadRead) {
  const resolved = new Set(
    read.liveEvents.flatMap((event) =>
      event.type === 'permission.resolved' ? [event.requestId] : [],
    ),
  );
  return read.liveEvents.flatMap((event) =>
    event.type === 'permission.requested' && !resolved.has(event.requestId) ? [event] : [],
  );
}

const threadActions = new Set([
  'send',
  'watch',
  'permit',
  'deny',
  'stop',
  'accept',
  'push',
  'pr',
  'merge-check',
  'prepare',
  'use-api',
  'release-check',
  'show',
  'changes',
]);

export async function runThreadCommand(args: string[], io: Io, connect: Connect): Promise<number> {
  let client: ChatClient | undefined;
  // Read from the raw arguments so an option that does not parse still gets a JSON error line.
  let json = args.includes('--json');
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        home: { type: 'string' },
        model: { type: 'string' },
        file: { type: 'string', multiple: true },
        watch: { type: 'boolean' },
        follow: { type: 'boolean' },
        thread: { type: 'boolean' },
        message: { type: 'string' },
        'permission-policy': { type: 'string' },
        remote: { type: 'string' },
        confirm: { type: 'boolean' },
        title: { type: 'string' },
        body: { type: 'string' },
        base: { type: 'string' },
        commit: { type: 'string' },
        role: { type: 'string' },
        off: { type: 'boolean' },
        note: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    json = values.json === true;
    const [action, first, second, ...extra] = positionals;
    if (values.help || !action) {
      await io.out(threadHelp);
      return 0;
    }
    if (extra.length > 0) throw new UsageError('Quote a message that has spaces.');
    const need = (value: string | undefined, what: string) => {
      if (!value) throw new UsageError(`Give the ${what}.`);
      return value;
    };
    // A malformed ID is refused here, before the controller is asked anything.
    if (action === 'new') projectIdArg(first);
    else if (threadActions.has(action)) threadIdArg(first);
    const home = crewkiteHome(values.home);
    client = await connect(home);
    const settings = loadSettings(home);
    if (settings.problem) io.err(`${settings.problem}\n`);
    const report = async (command: string, result: CommandResult, taskId: string | null) => {
      if (json) await io.out(jsonLine(resultLine(command, result, taskId)));
      if (!applied(result)) {
        if (!json) io.err(`${result.next ?? result.reason ?? 'The controller refused.'}\n`);
        return CLI_EXIT.notDone;
      }
      return 0;
    };
    switch (action) {
      case 'new':
      case 'send': {
        const text = need(second, 'message');
        const catalog = await client.readCatalog();
        const selection = chooseSelection(
          catalog,
          values.model,
          settings.settings.selection,
          Date.now(),
        );
        const created = action === 'new';
        const taskId = created
          ? (await client.createThread(need(first, 'project ID'), text)).id
          : need(first, 'thread ID');
        if (created || values['permission-policy'] !== undefined)
          await withThreadDropped(client, taskId, created, () =>
            applyPolicy(client as ChatClient, io, taskId, policyFlag(values['permission-policy'])),
          );
        return await sendAndFollow(client, io, {
          taskId,
          text,
          selection,
          files: values.file ?? [],
          json,
          watch: values.watch === true,
          command: 'SendChatMessage',
          created,
        });
      }
      case 'watch': {
        const read = await client.readThread(need(first, 'thread ID'));
        // A plan's slices, a crew chain and checks can all run with no turn named as running.
        const since = sinceUnderWay(read);
        if (since === null && !values.follow) {
          if (json) await io.out(jsonLine({ v: CLI_JSON_LINE_VERSION, kind: 'thread', read }));
          else io.err('Nothing is running in this thread.\n');
          return 0;
        }
        if (values.follow === true) {
          const follow = followThread(client, read, io, { text: null, json, forever: true });
          try {
            await follow.done;
          } finally {
            follow.stop();
          }
          return 0;
        }
        const follow = followWorkflowOf(
          client,
          read,
          io,
          { text: null, json },
          since ?? sinceNextTurn(read),
        );
        try {
          return workflowExit(await follow.done);
        } finally {
          follow.stop();
        }
      }
      case 'permit':
      case 'deny': {
        const taskId = need(first, 'thread ID');
        const requestId = need(second, 'request ID');
        const read = await client.readThread(taskId);
        const request = openRequests(read).find((event) => event.requestId === requestId);
        if (!request) throw new UsageError('That request is not open. Read the thread again.');
        const kind = action === 'deny' ? 'deny' : values.thread ? 'allow-thread' : 'allow-once';
        const option = request.options.find((value) => value.kind === kind);
        if (!option) throw new UsageError('This request does not offer that answer.');
        const result = await client.send('ResolveChatPermission', {
          taskId,
          turnId: request.turnId,
          requestId,
          choice: option.id,
        });
        return await report('ResolveChatPermission', result, taskId);
      }
      case 'stop': {
        const taskId = need(first, 'thread ID');
        const read = await client.readThread(taskId);
        if (!read.thread.activeTurnId) throw new UsageError('Nothing is running in this thread.');
        const result = await client.send('StopChatTurn', {
          taskId,
          turnId: read.thread.activeTurnId,
        });
        const code = await report('StopChatTurn', result, taskId);
        const waiting = waitingQueueLine(result);
        if (!json && code === 0 && waiting) await io.out(`${waiting}\n`);
        return code;
      }
      case 'accept': {
        const taskId = need(first, 'thread ID');
        const result = await client.accept(taskId, need(second, 'branch name'), values.message);
        const code = await report('AcceptChatChanges', result, taskId);
        if (!json && code === 0)
          await io.out(`${result.next ?? 'Accepted on a new local branch.'}\n`);
        return code;
      }
      case 'push': {
        const taskId = need(first, 'thread ID');
        const read = await client.readThread(taskId);
        const branch = read.thread.lastAcceptance?.branch;
        const commit = read.thread.lastAcceptance?.commit;
        if (!branch) throw new UsageError('Accept the changes on a branch first.');
        if (!commit) throw new UsageError('Accept again to record the commit, then push.');
        const remote = values.remote ?? 'origin';
        if (!values.confirm)
          throw new UsageError(
            `This pushes commit ${commit} to ${branch} on ${remote} with your own git credentials. Run it again with --confirm --commit ${commit} to push.`,
          );
        // The commit the dry run printed. The controller refuses it once the thread accepted
        // another, so a script never pushes what it did not see.
        const pushing = values.commit ?? commit;
        if (!/^[a-f0-9]{40}$/.test(pushing))
          throw new UsageError('Give --commit as the full 40-character commit id.');
        const result = await client.push(taskId, branch, pushing, remote);
        const code = await report('PushChatBranch', result, taskId);
        if (!json && code === 0) await io.out(`Pushed ${branch} to ${remote}.\n`);
        return code;
      }
      case 'pr': {
        const taskId = need(first, 'thread ID');
        const read = await client.readThread(taskId);
        const branch = read.thread.lastPush?.branch;
        if (!branch) throw new UsageError('Push the branch first.');
        const title =
          values.title ?? read.messages.find((message) => message.author.kind === 'user')?.text;
        const result = await client.openPullRequest(
          taskId,
          branch,
          (title ?? branch).split('\n')[0].slice(0, 256),
          values.body ?? '',
        );
        const code = await report('OpenChatPullRequest', result, taskId);
        const url = (result.data as { url?: string } | undefined)?.url;
        if (!json && code === 0) await io.out(`${url ?? 'Pull request opened.'}\n`);
        return code;
      }
      case 'merge-check': {
        const taskId = need(first, 'thread ID');
        const pushed = (await client.readThread(taskId)).thread.lastPush;
        // Without --base, the base of the pull request this thread opened from its branch.
        const opened = pushed
          ? (await client.readRemoteEffects(taskId)).effects.findLast(
              (effect) =>
                effect.kind === 'pr-open' &&
                effect.state === 'applied' &&
                effect.target.branch === pushed.branch,
            )
          : undefined;
        const base = values.base ?? opened?.target.baseRef;
        if (!base)
          throw new UsageError('Give --base with the branch the pull request merges into.');
        const result = await client.checkMerge(
          taskId,
          base,
          values.remote ?? pushed?.remote ?? 'origin',
        );
        const code = await report('CheckChatMerge', result, taskId);
        if (!json && code === 0) await io.out(`${result.next ?? 'The merge was checked.'}\n`);
        return code;
      }
      case 'prepare': {
        const taskId = need(first, 'thread ID');
        if (!json)
          io.err('Copying the installed dependencies. A large tree takes a few minutes.\n');
        const result = await client.send('PrepareDependencies', {
          taskId,
          scope: 'thread',
          scopeKey: taskId,
          consent: 'explicit',
        });
        const { prepared, line } = preparationResultLine(result);
        if (json) await io.out(jsonLine(resultLine('PrepareDependencies', result, taskId)));
        else if (prepared) await io.out(`${line}\n`);
        else io.err(`${line}\n`);
        return prepared ? 0 : CLI_EXIT.notDone;
      }
      case 'use-api': {
        const taskId = need(first, 'thread ID');
        const role = ConnectionRoleSchema.safeParse(values.role ?? 'thread');
        if (!role.success)
          throw new UsageError('Use --role builder, reviewer, challenger, fixer or orchestrator.');
        if (values.off) {
          if (second !== undefined) throw new UsageError('Give --off or a connection ID.');
          const result = await client.send('UnassignConnection', { taskId, role: role.data });
          const code = await report('UnassignConnection', result, taskId);
          const from = role.data === 'thread' ? 'this thread' : `the ${role.data}`;
          if (!json && code === 0) await io.out(`Removed the API connection from ${from}.\n`);
          return code;
        }
        const connectionId = connectionIdArg(second);
        const [{ connection }, read] = await Promise.all([
          findConnection(client, connectionId),
          client.readThread(taskId),
        ]);
        const name = terminalText(connectionName(connection));
        if (!isApiConnection(connection)) throw new UsageError(`${name} is not an API connection.`);
        const attention = connectionAttention(connection);
        if (attention)
          throw new UsageError(
            `${name} is not ready: ${attention.replace(/\.$/, '')}. Run crewkite connections check ${connectionId} first.`,
          );
        // An assignment on another family never reaches the role, so it is refused here.
        const family = roleFamily(read.thread, role.data);
        if (role.data !== 'thread' && !family)
          throw new UsageError(`This thread's crew has no ${role.data}.`);
        if (family && family !== connection.family)
          throw new UsageError(
            `The ${role.data} runs on ${familyNames[family]}, and ${name} bills ${familyNames[connection.family]}. Pick a connection for ${familyNames[family]}.`,
          );
        const runs =
          role.data === 'thread'
            ? `this thread's ${familyNames[connection.family]} turns`
            : `the ${role.data}'s turns`;
        if (!values.confirm)
          throw new UsageError(
            `This runs ${runs} on ${name}. ${CHARGES_APPLY} Run it again with --confirm to use it.`,
          );
        const result = await client.send('AssignConnection', {
          taskId,
          role: role.data,
          connectionId,
          consent: 'explicit',
        });
        const code = await report('AssignConnection', result, taskId);
        if (!json && code === 0) await io.out(`${name} now runs ${runs}. ${CHARGES_APPLY}\n`);
        return code;
      }
      case 'release-check': {
        const taskId = need(first, 'thread ID');
        const note = values.note?.trim();
        if (!values.confirm || !note)
          throw new UsageError(
            `This releases a thread held by a check CrewKite cannot confirm ended. If its process still runs, it can change files in the thread's copy. Add --confirm and --note "<what you checked>" to release it.`,
          );
        // An unquoted note leaves its later words as a second argument.
        if (second !== undefined) throw new UsageError('Quote a message that has spaces.');
        if (Buffer.byteLength(note) > 300) throw new UsageError('A note is at most 300 bytes.');
        const result = await client.send('ReleaseChatCheck', {
          taskId,
          confirm: 'explicit',
          note,
        });
        const code = await report('ReleaseChatCheck', result, taskId);
        const held = (result.data as { held?: boolean } | undefined)?.held === true;
        if (!json && code === 0)
          await io.out(
            held
              ? 'Released the check. A provider process still holds the thread.\n'
              : "Released. CrewKite never confirmed the check's process ended.\n",
          );
        return code;
      }
      case 'list': {
        const { threads, complete } = await client.listThreads();
        if (json)
          await io.out(
            jsonLine({
              v: CLI_JSON_LINE_VERSION,
              kind: 'threads',
              threads: threads.map((task) => ({
                taskId: task.id,
                projectId: task.projectId,
                title: task.title,
                activity: task.chatActivity,
              })),
              complete,
            }),
          );
        else {
          for (const task of threads)
            await io.out(`${task.id} ${task.chatActivity.padEnd(7)} ${terminalText(task.title)}\n`);
          if (!complete) io.err('The list is incomplete. Run it again.\n');
        }
        return complete ? 0 : CLI_EXIT.failed;
      }
      case 'show': {
        const read = await client.readThread(need(first, 'thread ID'));
        await io.out(
          json
            ? jsonLine({ v: CLI_JSON_LINE_VERSION, kind: 'thread', read })
            : threadSummaryText(read),
        );
        return 0;
      }
      case 'changes': {
        const changes = await client.readChanges(need(first, 'thread ID'));
        if (json)
          await io.out(
            jsonLine(
              resultLine(
                'ReadChatChanges',
                {
                  outcome: 'applied',
                  data: {
                    kind: 'chat-changes',
                    ...changes,
                    // The list names the files. The patch of an ordinary file stays in the controller.
                    files: changes.files.map((file) => ({
                      ...file,
                      patch: file.additions + file.deletions === 0 ? file.patch : null,
                    })),
                  },
                },
                changes.taskId,
              ),
            ),
          );
        else if (changes.files.length === 0) io.err('No changes in this thread.\n');
        else
          for (const file of changes.files) {
            await io.out(`+${file.additions} -${file.deletions} ${terminalText(file.path)}\n`);
            if (file.additions + file.deletions === 0 && file.patch)
              io.err(`${terminalText(file.patch)}`);
          }
        return 0;
      }
      default:
        throw new UsageError(`Unknown thread command: ${action}.`);
    }
  } catch (error) {
    return failure(error, io, json);
  } finally {
    client?.transport.close();
  }
}

/** Refuses a malformed connection ID before the controller is asked anything. */
export function connectionIdArg(value: string | undefined): string {
  if (!ConnectionIdSchema.safeParse(value).success)
    throw new UsageError('Give the connection ID that crewkite connections lists.');
  return value as string;
}

/** The connection with this ID, or a refusal that says how to find one. */
export async function findConnection(client: ChatClient, connectionId: string) {
  const read = await client.readConnections();
  const connection = read.connections.find((value) => value.connectionId === connectionId);
  if (!connection)
    throw new UsageError(`No connection ${connectionId}. List them with crewkite connections.`);
  return { read, connection };
}

/** Arguments that do not parse or that the command rejects, or a refusal: nothing was done. */
export const notDone = (error: unknown) =>
  error instanceof UsageError ||
  error instanceof CommandRefused ||
  /^ERR_PARSE_ARGS_/.test((error as NodeJS.ErrnoException | null)?.code ?? '');

export function failure(error: unknown, io: Io, json: boolean): number {
  const message =
    error instanceof Error && error.message ? error.message : 'The command could not run.';
  if (json)
    void io.out(
      jsonLine({ v: CLI_JSON_LINE_VERSION, kind: 'error', message: message.slice(0, 4096) }),
    );
  else io.err(`${terminalText(message)}\n`);
  return notDone(error) ? CLI_EXIT.notDone : CLI_EXIT.failed;
}

/** `crewkite -p message`: one message, its reply on stdout, and the turn's status as exit code. */
export async function runPrint(
  args: string[],
  io: Io,
  connect: Connect,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let client: ChatClient | undefined;
  // Read from the raw arguments so an option that does not parse still gets a JSON error line.
  let json = args.includes('--json');
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        print: { type: 'string', short: 'p' },
        json: { type: 'boolean' },
        home: { type: 'string' },
        model: { type: 'string' },
        file: { type: 'string', multiple: true },
        thread: { type: 'string' },
        project: { type: 'string' },
        register: { type: 'boolean' },
        'permission-policy': { type: 'string' },
      },
    });
    json = values.json === true;
    const text = values.print ?? '';
    if (text.trim() === '' || positionals.length > 0)
      throw new UsageError('Use crewkite -p "message". Quote a message that has spaces.');
    if ([values.thread, values.project, values.register].filter(Boolean).length > 1)
      throw new UsageError('Give one of --thread, --project or --register.');
    if (values.thread !== undefined) threadIdArg(values.thread);
    if (values.project !== undefined) projectIdArg(values.project);
    const policy = policyFlag(values['permission-policy']);
    const home = crewkiteHome(values.home);
    client = await connect(home);
    const settings = loadSettings(home);
    if (settings.problem) io.err(`${settings.problem}\n`);
    const catalog = await client.readCatalog(values.thread);
    const selection = chooseSelection(
      catalog,
      values.model,
      settings.settings.selection,
      Date.now(),
    );
    let taskId = values.thread;
    const created = !taskId;
    if (!taskId) {
      const projectId =
        values.project ??
        (await projectHere(client, callerDirectory(env, cwd), env, values.register === true, io));
      taskId = (await client.createThread(projectId, text)).id;
      if (!json) io.err(`Thread ${taskId}\n`);
    }
    const thread = taskId;
    await withThreadDropped(client, thread, created, () =>
      applyPolicy(client as ChatClient, io, thread, policy),
    );
    return await sendAndFollow(client, io, {
      taskId,
      text,
      selection,
      files: values.file ?? [],
      json,
      watch: true,
      command: 'SendChatMessage',
      created,
    });
  } catch (error) {
    return failure(error, io, json);
  } finally {
    client?.transport.close();
  }
}
