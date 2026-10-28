import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type AgentEvent,
  type ChatCatalogRead,
  ChatEffortSchema,
  type ChatFailure,
  ChatFamilySchema,
  type ChatModelSelection,
  type ChatThreadRead,
  type ChatTurn,
  CLI_TURN_EXIT,
  type CliJsonLine,
  CliJsonLineSchema,
  type CliThreadEvent,
  type CommandResult,
  type Event,
  ProjectSchema,
  rankFamilies,
} from '@crewkite/contracts';
import { crewkiteHome, loadSettings } from '../settings.ts';
import { applied, type ChatClient, CommandRefused, threadMessage } from './client.ts';

// `crewkite thread ...` and `crewkite -p`. Every command goes through the chat client, so the
// controller decides each one exactly as it decides the desktop's. Text goes to stdout, progress
// and questions to stderr, and --json writes one CliJsonLine per line.

export type Io = { out: (text: string) => void | Promise<void>; err: (text: string) => void };
export type Connect = (home: string) => Promise<ChatClient>;

export const threadHelp = `Usage: crewkite thread new <project-id> <message> [--model family[/model[:effort]]] [--file path ...] [--watch] [--json]
       crewkite thread send <task-id> <message> [--model ...] [--file path ...] [--watch] [--json]
       crewkite thread watch <task-id> [--follow] [--json]
       crewkite thread permit <task-id> <request-id> [--thread] [--json]
       crewkite thread deny <task-id> <request-id> [--json]
       crewkite thread stop <task-id> [--json]
       crewkite thread accept <task-id> <branch> [--message text] [--json]
       crewkite thread push <task-id> [--remote name] --confirm [--json]
       crewkite thread pr <task-id> [--title text] [--body text] [--json]
       crewkite thread list [--json]
       crewkite thread show <task-id> [--json]
       crewkite -p <message> [--thread task-id | --project project-id] [--model ...] [--file path ...] [--json]

Every command takes --home path. Print mode streams the reply to stdout and exits 0 when the turn
is done, 1 when it failed and 3 when it was stopped. A permission request waits for an answer from
crewkite thread permit or deny, the interactive CLI or the desktop.
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
  v: 1,
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
  let finished = false;
  const thinking = new Set<string>();
  const early = new Map<string, AgentEvent[]>();
  const finish = (status: 'done' | 'stopped' | 'failed', failure: ChatFailure | null) => {
    if (finished || !turnId) return;
    finished = true;
    if (follow.json)
      void io.out(jsonLine({ v: 1, kind: 'turn-end', taskId, turnId, status, failure }));
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
  void client.transport
    .subscribe(read.cursor, (event) => {
      const line = threadEvent(event, taskId);
      if (!line) return;
      if (follow.json) void io.out(jsonLine({ v: 1, kind: 'event', taskId, event: line }));
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
        if (!turnId && messageId && turn.userMessageId === messageId) {
          turnId = turn.id;
          // The record of a turn can follow its first events. Those wait here until it names it.
          for (const event of early.get(turn.id) ?? []) onAgent(event);
          early.clear();
        }
        if (turn.id === turnId && ended(turn))
          finish(turn.state as 'done' | 'stopped' | 'failed', turn.failure);
      } else if (line.type === 'agent.event') {
        const event = line.payload;
        if (!turnId && !follow.json)
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
    })
    .then(
      (stop) => {
        unsubscribe = stop;
      },
      (error) => settled.reject(error),
    );
  return {
    done: settled.promise,
    stop: () => unsubscribe?.(),
  };
}

const exitFor = (status: 'done' | 'stopped' | 'failed') => CLI_TURN_EXIT[status];

/** The checkout this shell is in, by its Git top level. */
function checkoutRoot(directory: string): string | null {
  const found = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return found.status === 0 ? found.stdout.trim() : null;
}

/**
 * The project for this shell's checkout. Registration returns the existing project for a path it
 * already holds, so this reads the ID; for a new checkout it registers it, which starts no work.
 */
export async function projectHere(client: ChatClient, cwd: string, io: Io): Promise<string> {
  const root = checkoutRoot(cwd);
  if (!root)
    throw new UsageError('Run print mode inside a Git checkout, or pass --project or --thread.');
  const result = await client.send('RegisterProject', { path: root });
  const project = ProjectSchema.safeParse(result.entity);
  if (!applied(result) || !project.success) throw new CommandRefused(result);
  if (result.outcome === 'applied') io.err(`Registered ${root} as project ${project.data.id}.\n`);
  return project.data.id;
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
      return CLI_TURN_EXIT.failed;
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
        return CLI_TURN_EXIT.failed;
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
        if (action === 'new' && settings.settings.permissionPolicy !== 'ask')
          await client.configure({ taskId, permissionPolicy: settings.settings.permissionPolicy });
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
          if (json) await io.out(jsonLine({ v: 1, kind: 'thread', read }));
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
              v: 1,
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
        return complete ? 0 : CLI_TURN_EXIT.failed;
      }
      case 'show': {
        const read = await client.readThread(need(first, 'thread ID'));
        await io.out(json ? jsonLine({ v: 1, kind: 'thread', read }) : threadSummaryText(read));
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

function failure(error: unknown, io: Io, json: boolean): number {
  const message =
    error instanceof Error && error.message ? error.message : 'The command could not run.';
  if (json) void io.out(jsonLine({ v: 1, kind: 'error', message: message.slice(0, 4096) }));
  else io.err(`${terminalText(message)}\n`);
  if (error instanceof CommandRefused) return CLI_TURN_EXIT.failed;
  return error instanceof UsageError ? CLI_TURN_EXIT.usage : CLI_TURN_EXIT.failed;
}

/** `crewkite -p message`: one message, its reply on stdout, and the turn's status as exit code. */
export async function runPrint(
  args: string[],
  io: Io,
  connect: Connect,
  cwd = process.cwd(),
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
      },
    });
    json = values.json === true;
    const text = values.print ?? '';
    if (text.trim() === '' || positionals.length > 0)
      throw new UsageError('Use crewkite -p "message". Quote a message that has spaces.');
    if (values.thread && values.project)
      throw new UsageError('Give --thread or --project, not both.');
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
      const projectId = values.project ?? (await projectHere(client, cwd, io));
      taskId = (await client.createThread(projectId, text)).id;
      if (settings.settings.permissionPolicy !== 'ask')
        await client.configure({ taskId, permissionPolicy: settings.settings.permissionPolicy });
      if (!json) io.err(`Thread ${taskId}\n`);
    }
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
