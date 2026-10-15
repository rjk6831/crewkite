import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type ControllerClient,
  connectController,
  createCommandKey,
  readControllerEndpoint,
} from '@crewkite/client/node';
import {
  type Command,
  type CommandResult,
  CommandSchema,
  MAX_FRAME_BYTES,
  type Snapshot,
  type Task,
} from '@crewkite/contracts';

const help = `Usage: crewkite task <list|show|watch|start|stop|resume|approve|deny> [id] [--json] [--home path]
       crewkite health [--json] [--home path]
       crewkite retry <receipt-file> [--json] [--home path]

Approval commands take an approval ID. Other task commands take a task ID.
The desktop prepares task policy and source before start.
`;
interface Output {
  out: (text: string) => void;
  err: (text: string) => void;
}

export async function runCli(
  args: string[],
  output: Output = {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
): Promise<number> {
  let client: ControllerClient | undefined;
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        home: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help || positionals.length === 0) {
      output.out(help);
      return 0;
    }
    const [area, action, id, ...extra] = positionals;
    if (extra.length || !['task', 'health', 'retry'].includes(area))
      throw new Error('Unknown command. Use --help.');
    const supported = ['list', 'show', 'watch', 'start', 'stop', 'resume', 'approve', 'deny'];
    if (
      area === 'task' &&
      (!action ||
        !supported.includes(action) ||
        (action === 'list' ? id !== undefined : id === undefined))
    )
      throw new Error('Invalid task command. Use --help.');
    if (area === 'health' && action !== undefined)
      throw new Error('Health takes no positional arguments.');
    if (area === 'retry' && (!action || id !== undefined))
      throw new Error('Retry takes one receipt file.');
    const home = resolve(values.home ?? process.env.CREWKITE_HOME ?? join(homedir(), '.crewkite'));
    const actor = { id: 'terminal', kind: 'cli' as const };
    const connected = await connectController({ ...readControllerEndpoint(home), actor });
    client = connected;
    let sent: Command | undefined;
    const request = (
      command: string,
      payload: Record<string, unknown>,
      expectedRevision?: number,
    ) => {
      sent = CommandSchema.parse({
        protocol: 1,
        key: createCommandKey(),
        actor,
        command,
        payload,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      });
      return connected.command(sent);
    };
    const print = (data: unknown, text: string) =>
      output.out(values.json ? `${JSON.stringify(data)}\n` : `${text}\n`);
    const receipt = (result: CommandResult) =>
      print(
        { command: sent, result },
        `${result.reason ?? result.outcome}\nCommand key ${sent?.key}`,
      );
    if (area === 'retry') {
      const file = openSync(action, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const state = fstatSync(file);
        if (!state.isFile() || state.size > MAX_FRAME_BYTES)
          throw new Error('Receipt must be a bounded JSON file.');
        const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (value === null || typeof value !== 'object' || !('command' in value))
          throw new Error('Receipt has no saved command.');
        sent = CommandSchema.parse(value.command);
      } finally {
        closeSync(file);
      }
      const result = await connected.command(sent);
      receipt(result);
      return succeeded(result) ? 0 : 2;
    }
    if (area === 'health') {
      const result = await request('GetHealth', {});
      print(
        result,
        result.data?.kind === 'health' ? result.data.status : (result.reason ?? result.outcome),
      );
      return succeeded(result) ? 0 : 2;
    }
    const snapshot = await client.snapshot();
    if (action === 'list') {
      print(
        { cursor: snapshot.cursor, tasks: snapshot.tasks },
        snapshot.tasks.length
          ? snapshot.tasks.map((task) => `${task.id}  ${task.state}  ${task.title}`).join('\n')
          : 'No tasks.',
      );
      return 0;
    }
    if (action === 'approve' || action === 'deny') {
      const approval = snapshot.approvals.find((item) => item.approvalId === id);
      if (!approval) throw new Error('Approval was not found.');
      const task = requireTask(snapshot, approval.taskId);
      const {
        approvalId,
        taskId,
        attemptId,
        generation,
        action: effect,
        target,
        revision,
      } = approval;
      const result = await request(
        'ResolveApproval',
        {
          binding: { approvalId, taskId, attemptId, generation, action: effect, target, revision },
          decision: action === 'approve' ? 'approved' : 'denied',
        },
        task.revision,
      );
      receipt(result);
      return succeeded(result) ? 0 : 2;
    }
    if (!id) throw new Error('A task ID is required.');
    const task = requireTask(snapshot, id);
    if (action === 'show') {
      print(
        { cursor: snapshot.cursor, task },
        `${task.id}\n${task.title}\n${task.state}, revision ${task.revision}`,
      );
      return 0;
    }
    if (action === 'watch') {
      print(
        { type: 'snapshot', cursor: snapshot.cursor, task },
        `${snapshot.cursor} ${task.state}, revision ${task.revision}`,
      );
      const unsubscribe = await client.subscribe(
        snapshot.cursor,
        (event) => {
          if (event.taskId === task.id)
            print(event, `${event.cursor} ${event.type}, revision ${event.revision}`);
        },
        (fresh) => {
          const current = fresh.tasks.find((item) => item.id === task.id);
          if (current)
            print(
              { type: 'snapshot', cursor: fresh.cursor, task: current },
              `${fresh.cursor} ${current.state}, revision ${current.revision}`,
            );
        },
      );
      const stopConnection = client.onConnection((state) => {
        if (state === 'offline')
          output.err('Controller offline. The last event cursor is retained.\n');
      });
      const waiting = Promise.withResolvers<number>();
      const stop = () => waiting.resolve(0);
      const stopExhausted = client.onReconnectExhausted(() => {
        output.err('Reconnect attempts ended. Start the controller, then run task watch again.\n');
        waiting.resolve(1);
      });
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        return await waiting.promise;
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        stopExhausted();
        unsubscribe();
        stopConnection();
      }
    }
    if (!task.runId)
      throw new Error('Prepare this task in the desktop before controlling its run.');
    const names = { start: 'StartRun', stop: 'StopRun', resume: 'ResumeRun' } as const;
    const result = await request(
      names[action as keyof typeof names],
      { taskId: task.id, runId: task.runId },
      task.revision,
    );
    receipt(result);
    return succeeded(result) ? 0 : 2;
  } catch (error) {
    output.err(`${error instanceof Error ? error.message : 'CLI command failed.'}\n`);
    return 1;
  } finally {
    client?.close();
  }
}

function requireTask(snapshot: Snapshot, id: string): Task {
  const task = snapshot.tasks.find((item) => item.id === id);
  if (!task) throw new Error('Task was not found.');
  return task;
}
function succeeded(result: CommandResult) {
  return result.outcome === 'applied' || result.outcome === 'already-applied';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runCli(process.argv.slice(2));
