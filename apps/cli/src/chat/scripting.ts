import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type AgentEvent,
  type ChatCatalogRead,
  ChatEffortSchema,
  type ChatFailure,
  ChatFamilySchema,
  type ChatModelSelection,
  ChatPermissionPolicySchema,
  type ChatThreadRead,
  type ChatTurn,
  CLI_EXIT,
  type CliJsonLine,
  CliJsonLineSchema,
  type CliThreadEvent,
  type CommandResult,
  type Event,
  ProjectSchema,
  rankFamilies,
} from '@crewkite/contracts';
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
       crewkite thread push <task-id> [--remote name] --confirm [--json]
       crewkite thread pr <task-id> [--title text] [--body text] [--json]
       crewkite thread list [--json]
       crewkite thread show <task-id> [--json]
       crewkite -p <message> [--thread task-id | --project project-id | --register] [--model ...] [--permission-policy ...] [--file path ...] [--json]

Every command takes --home path. Exit status: 0 done, 1 failed (an error, a lost connection or a
failed turn), 2 nothing was done (arguments or a refusal), 3 the followed turn was stopped. A new
thread asks before each action unless --permission-policy names another policy for this run. A
permission request waits for crewkite thread permit or deny, the interactive CLI or the desktop.
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

const resultLine = (
  command: string,
  result: CommandResult,
  taskId: string | null,
): CliJsonLine => ({
  v: 2,
  kind: 'result',
  command,
  outcome: result.outcome,
  reason: result.reason ?? null,
  next: result.next ?? null,
  taskId,
  ...(result.data === undefined ? {} : { data: result.data }),
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
  const match = /^([a-z]+)(?:\/([^:]+)(?::([a-z]+))?)?$/.exec(value);
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
      void io.out(jsonLine({ v: 2, kind: 'turn-end', taskId, turnId, status, failure }));
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
        const line = threadEvent(event, taskId);
        if (!line) return;
        if (follow.json) void io.out(jsonLine({ v: 2, kind: 'event', taskId, event: line }));
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
      resynced,
    )
    .then(
      (stop) => {
        unsubscribe = stop;
      },
      (error) => settled.reject(error),
    );
  return {
    done: settled.promise,
    stop: () => {
      unsubscribe?.();
      stopLost?.();
    },
  };
}

const exitFor = (status: 'done' | 'stopped' | 'failed') => CLI_EXIT[status];

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
  },
): Promise<number> {
  const before = await client.readThread(input.taskId);
  const follow = input.watch
    ? followThread(client, before, io, { text: input.text, json: input.json })
    : null;
  try {
    const stored = [];
    for (const path of input.files)
      stored.push(await client.importAttachment(input.taskId, resolve(path)));
    const result = await client.send('SendChatMessage', {
      taskId: input.taskId,
      text: input.text,
      selection: input.selection,
      files: stored,
    });
    if (input.json) await io.out(jsonLine(resultLine(input.command, result, input.taskId)));
    else if (!input.watch) await io.out(`${input.taskId}\n`);
    if (!applied(result)) {
      if (!input.json) io.err(`${result.next ?? result.reason ?? 'The message was not sent.'}\n`);
      return CLI_EXIT.notDone;
    }
    if (!follow) return 0;
    if (!input.json && result.next) io.err(`${result.next}\n`);
    return exitFor((await follow.done).status);
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

export async function runThreadCommand(args: string[], io: Io, connect: Connect): Promise<number> {
  let client: ChatClient | undefined;
  let json = false;
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
        const taskId =
          action === 'new'
            ? (await client.createThread(need(first, 'project ID'), text)).id
            : need(first, 'thread ID');
        if (action === 'new' || values['permission-policy'] !== undefined)
          await applyPolicy(client, io, taskId, policyFlag(values['permission-policy']));
        return await sendAndFollow(client, io, {
          taskId,
          text,
          selection,
          files: values.file ?? [],
          json,
          watch: values.watch === true,
          command: 'SendChatMessage',
        });
      }
      case 'watch': {
        const read = await client.readThread(need(first, 'thread ID'));
        if (!read.thread.activeTurnId && !values.follow) {
          if (json) await io.out(jsonLine({ v: 2, kind: 'thread', read }));
          else io.err('Nothing is running in this thread.\n');
          return 0;
        }
        const follow = followThread(client, read, io, {
          text: null,
          json,
          forever: values.follow === true,
        });
        try {
          return exitFor((await follow.done).status);
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
        return await report('StopChatTurn', result, taskId);
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
        if (!branch) throw new UsageError('Accept the changes on a branch first.');
        const remote = values.remote ?? 'origin';
        if (!values.confirm)
          throw new UsageError(
            `This pushes ${branch} to ${remote} with your own git credentials. Run it again with --confirm to push.`,
          );
        const result = await client.push(taskId, branch, remote);
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
      case 'list': {
        const { threads, complete } = await client.listThreads();
        if (json)
          await io.out(
            jsonLine({
              v: 2,
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
        await io.out(json ? jsonLine({ v: 2, kind: 'thread', read }) : threadSummaryText(read));
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

/** Arguments that do not parse or that the command rejects, or a refusal: nothing was done. */
export const notDone = (error: unknown) =>
  error instanceof UsageError ||
  error instanceof CommandRefused ||
  /^ERR_PARSE_ARGS_/.test((error as NodeJS.ErrnoException | null)?.code ?? '');

function failure(error: unknown, io: Io, json: boolean): number {
  const message =
    error instanceof Error && error.message ? error.message : 'The command could not run.';
  if (json) void io.out(jsonLine({ v: 2, kind: 'error', message: message.slice(0, 4096) }));
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
  let json = false;
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
    if (!taskId) {
      const projectId =
        values.project ??
        (await projectHere(client, callerDirectory(env, cwd), env, values.register === true, io));
      taskId = (await client.createThread(projectId, text)).id;
      if (!json) io.err(`Thread ${taskId}\n`);
    }
    await applyPolicy(client, io, taskId, policy);
    return await sendAndFollow(client, io, {
      taskId,
      text,
      selection,
      files: values.file ?? [],
      json,
      watch: true,
      command: 'SendChatMessage',
    });
  } catch (error) {
    return failure(error, io, json);
  } finally {
    client?.transport.close();
  }
}
