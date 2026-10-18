import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { groupAbsent, type Schedule } from '../../host/worker.ts';
import {
  BindingSchema,
  CLEANUP_MS,
  DiscoveryTerminalSchema,
  type LocalDiscoveryStart,
  type LocalDiscoveryTerminal,
  type LocalStart,
  type LocalTerminal,
  localDiscoveryPlan,
  localOutputTokens,
  localPlan,
  localStructuredOutput,
  MAX_STREAM_BYTES,
  TerminalSchema,
} from './profile.ts';

const messageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), binding: BindingSchema }),
  z.strictObject({ type: z.literal('terminal'), terminal: TerminalSchema }),
  z.strictObject({ type: z.literal('discovery'), terminal: DiscoveryTerminalSchema }),
]);
export type LocalLifecycle<Phase extends 'task' | 'discovery' = 'task'> = {
  beforePhase: (phase: Phase) => void;
  owned: (phase: Phase, group: number) => void;
  quiescent: (phase: Phase, group: number) => void;
};
type ClientOptions = {
  now?: () => number;
  schedule?: Schedule;
  spawn?: typeof spawn;
  groupAbsent?: typeof groupAbsent;
  signal?: (group: number, signal: NodeJS.Signals) => void;
};
type TaskOptions = ClientOptions & { onSubmitted: () => undefined; lifecycle: LocalLifecycle };
type DiscoveryOptions = ClientOptions & { lifecycle: LocalLifecycle<'discovery'> };
function synchronous(work: () => unknown) {
  const marker = work();
  if (marker !== undefined) {
    void Promise.resolve(marker).catch(() => {});
    throw new Error('Local ownership callbacks must finish synchronously.');
  }
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const KILL_MS = 1000;

/** This owner can close its SDK client. Only a bound runtime terminal releases generation ownership. */
export function startLocalReplacement(value: LocalStart, directory: string, options: TaskOptions) {
  const handle = startLocalClient({ kind: 'task', plan: localPlan(value), options }, directory);
  return {
    ...handle,
    result: handle.result.then((result) => ({
      ...result,
      terminal: TerminalSchema.parse(result.terminal),
    })),
  };
}
export function startLocalDiscovery(
  value: LocalDiscoveryStart,
  directory: string,
  options: DiscoveryOptions,
) {
  const handle = startLocalClient(
    { kind: 'discovery', plan: localDiscoveryPlan(value), options },
    directory,
  );
  return {
    ...handle,
    result: handle.result.then((result) => ({
      ...result,
      terminal: DiscoveryTerminalSchema.parse(result.terminal),
    })),
  };
}
function startLocalClient(
  operation:
    | { kind: 'task'; plan: LocalStart; options: TaskOptions }
    | { kind: 'discovery'; plan: LocalDiscoveryStart; options: DiscoveryOptions },
  directory: string,
) {
  const { plan, options } = operation;
  const lifecycle = {
    before: () =>
      operation.kind === 'task'
        ? operation.options.lifecycle.beforePhase('task')
        : operation.options.lifecycle.beforePhase('discovery'),
    owned: (group: number) =>
      operation.kind === 'task'
        ? operation.options.lifecycle.owned('task', group)
        : operation.options.lifecycle.owned('discovery', group),
    quiescent: (group: number) =>
      operation.kind === 'task'
        ? operation.options.lifecycle.quiescent('task', group)
        : operation.options.lifecycle.quiescent('discovery', group),
  };
  const root = lstatSync(directory);
  if (
    process.platform === 'win32' ||
    !isAbsolute(directory) ||
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== process.getuid?.() ||
    root.mode & 0o077
  )
    throw new Error('The Local client directory must be private.');
  const now = options.now ?? (() => performance.now());
  const began = now();
  if (!Number.isFinite(began)) throw new Error('The Local clock is invalid.');
  const deadline = began + plan.timeoutMs;
  let previous = began;
  const remaining = () => {
    const current = now();
    if (!Number.isFinite(current) || current < previous) return 0;
    previous = current;
    return Math.max(0, deadline - current);
  };
  const schedule =
    options.schedule ??
    ((work, delay) => {
      const timer = setTimeout(work, delay);
      return () => clearTimeout(timer);
    });
  if (remaining() <= CLEANUP_MS) throw new Error('The Local deadline expired.');
  synchronous(lifecycle.before);
  if (remaining() <= CLEANUP_MS) throw new Error('The Local deadline expired.');
  const child = (options.spawn ?? spawn)(
    process.execPath,
    [fileURLToPath(new URL('./sdk-child.ts', import.meta.url))],
    {
      cwd: directory,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { HOME: directory, TMPDIR: directory, LANG: 'C.UTF-8' },
    },
  ) as ChildProcessWithoutNullStreams;
  const group = child.pid ?? 0;
  let submitted = false,
    ready = false,
    stopping = false,
    closed = false,
    settled = false,
    owned = false,
    ownershipFailed = false,
    cleaning = false;
  let killedAt: number | undefined;
  let terminal: LocalTerminal | LocalDiscoveryTerminal | null = null;
  let stopReason: 'stopped' | 'ownership' | 'deadline' | null = null;
  let invalid = false,
    spawned = false,
    spawnFailed = false;
  let pending = Buffer.alloc(0),
    bytes = 0,
    stderrBytes = 0;
  const timers: Array<() => void> = [];
  let resolveResult!: (value: {
    terminal: LocalTerminal | LocalDiscoveryTerminal;
    clientQuiescent: boolean;
  }) => void;
  const result = new Promise<Parameters<typeof resolveResult>[0]>((resolve) => {
    resolveResult = resolve;
  });
  const absent = () => spawnFailed || (group > 0 && (options.groupAbsent ?? groupAbsent)(group));
  const unknown = (): LocalTerminal | LocalDiscoveryTerminal =>
    operation.kind === 'task'
      ? { kind: 'unknown', binding: operation.plan.binding, reason: 'ownership' }
      : { kind: 'unavailable', binding: operation.plan.binding, reason: 'ownership' };
  const settle = () => {
    if (settled) return;
    settled = true;
    for (const cancel of timers) cancel();
    const clientQuiescent =
      spawnFailed ||
      (closed &&
        absent() &&
        child.stdout.readableEnded &&
        child.stderr.readableEnded &&
        (child.stdin.writableFinished || child.stdin.closed));
    if (clientQuiescent && owned) {
      try {
        synchronous(() => lifecycle.quiescent(group));
      } catch {
        ownershipFailed = true;
      }
    }
    if (!clientQuiescent || !owned || ownershipFailed || remaining() === 0) terminal = unknown();
    const fallback: LocalTerminal | LocalDiscoveryTerminal =
      operation.kind === 'discovery'
        ? {
            kind: 'unavailable',
            binding: operation.plan.binding,
            reason: stopReason ?? 'ownership',
          }
        : !submitted && clientQuiescent
          ? { kind: 'failed', binding: operation.plan.binding, reason: 'ownership', proof: null }
          : unknown();
    resolveResult({ terminal: terminal ?? fallback, clientQuiescent });
  };
  const signal = (name: NodeJS.Signals) => {
    if (group > 0 && !absent())
      try {
        (options.signal ?? ((group, name) => process.kill(-group, name)))(group, name);
      } catch {}
  };
  const settleAtCutoff = () => {
    // An exited group can precede delivery of its final stream-close event.
    if (group > 0 && !closed && absent()) timers.push(schedule(settle, 0));
    else settle();
  };
  const cutoff = () => {
    if (settled) return;
    if (absent()) return settleAtCutoff();
    // Timers run before the poll phase that reaps children. When synchronous work holds the
    // loop past the cutoff, KILL and this check run in one pass, microseconds apart. Node runs
    // one timer list per duration at a time, so an older cutoff list can even run before the
    // KILL. Deciding after one poll phase lets the kill go out and the child be reaped. A group
    // still present then gets the usual gap between KILL and cutoff, counted from the kill and
    // capped by the deadline.
    setImmediate(() => {
      if (settled) return;
      if (absent()) return settleAtCutoff();
      const late = killedAt === undefined ? 0 : killedAt + CLEANUP_MS - KILL_MS - now();
      const wait = Math.min(late, remaining());
      if (wait > 0) timers.push(schedule(settleAtCutoff, wait));
      else settle();
    });
  };
  const cleanup = () => {
    if (settled) return;
    try {
      child.stdin.end();
    } catch {}
    if (closed && absent()) return settle();
    if (cleaning) return;
    cleaning = true;
    signal('SIGTERM');
    timers.push(
      schedule(
        () => {
          killedAt = now();
          signal('SIGKILL');
        },
        Math.min(KILL_MS, remaining()),
      ),
    );
    timers.push(schedule(cutoff, Math.min(CLEANUP_MS, remaining())));
  };
  const stop = (reason: 'stopped' | 'ownership' | 'deadline' = 'stopped') => {
    if (settled || stopping) return;
    stopping = true;
    stopReason = reason;
    if (operation.kind === 'discovery') terminal = null;
    try {
      child.stdin.write(`${JSON.stringify('stop')}\n`);
    } catch {}
    timers.push(schedule(cleanup, Math.min(CLEANUP_MS / 2, remaining())));
  };
  const invalidate = () => {
    invalid = true;
    terminal = null;
    stop('ownership');
  };
  child.once('spawn', () => {
    spawned = true;
  });
  child.on('error', () => {
    if (group <= 0 && !spawned) {
      spawnFailed = true;
      invalidate();
      settle();
    } else if (terminal) cleanup();
    else invalidate();
  });
  child.stdin.on('error', () => {
    if (terminal) cleanup();
    else invalidate();
  });
  child.stdout.on('data', (chunk: Buffer) => {
    if (settled || invalid) return;
    bytes += chunk.length;
    if (bytes > (operation.kind === 'discovery' ? 131_072 : 262_144)) return invalidate();
    pending = Buffer.concat([pending, chunk]);
    let end = pending.indexOf(10);
    while (end >= 0 && !invalid) {
      const line = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      end = pending.indexOf(10);
      try {
        if (terminal || remaining() === 0) throw new Error();
        const message = messageSchema.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)),
        );
        if (operation.kind === 'discovery') {
          if (
            message.type !== 'discovery' ||
            stopping ||
            !owned ||
            !same(message.terminal.binding, operation.plan.binding)
          )
            throw new Error();
          terminal = message.terminal;
          cleanup();
          continue;
        }
        if (message.type === 'discovery') throw new Error();
        if (message.type === 'ready') {
          if (
            !owned ||
            ready ||
            stopping ||
            !same(message.binding, plan.binding) ||
            remaining() <= CLEANUP_MS
          )
            throw new Error();
          ready = true;
          // A journal callback must finish synchronously before generation permission is sent.
          try {
            synchronous(operation.options.onSubmitted);
          } catch {
            ownershipFailed = true;
            throw new Error();
          }
          if (remaining() <= CLEANUP_MS || stopping || invalid || closed || settled)
            throw new Error();
          // The durable admission marker precedes permission to open the prediction channel.
          submitted = true;
          child.stdin.write(`${JSON.stringify('submit')}\n`);
        } else {
          const value = message.terminal;
          if (
            !same(value.binding, plan.binding) ||
            ('proof' in value &&
              value.proof !== null &&
              (value.proof.maxTokens !== localOutputTokens(operation.plan) ||
                value.proof.structured?.schemaHash !==
                  localStructuredOutput(operation.plan.binding).schemaHash)) ||
            (submitted && value.kind === 'failed' && value.proof === null) ||
            (!submitted && value.kind !== 'failed')
          )
            throw new Error();
          if (
            value.kind === 'completed' &&
            (value.proof.stopReason !== 'eosFound' ||
              value.proof.outputBytes > MAX_STREAM_BYTES ||
              value.proposal.attemptId !== operation.plan.binding.attemptId ||
              value.proposal.path !== operation.plan.binding.path ||
              value.proposal.baseHash !== operation.plan.binding.baseHash)
          )
            throw new Error();
          if (value.kind === 'stopped' && (!stopping || value.proof.stopReason !== 'userStopped'))
            throw new Error();
          terminal = value;
          cleanup();
        }
      } catch {
        invalidate();
      }
    }
  });
  child.stdout.on('error', invalidate);
  child.stderr.on('error', invalidate);
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 16_384) invalidate();
  });
  // A client exit status cannot erase a terminal already acknowledged by the runtime.
  child.once('exit', () => {
    if (!closed) cleanup();
  });
  child.once('close', () => {
    if (settled) return;
    closed = true;
    if (pending.length) terminal = null;
    if (absent()) settle();
    else cleanup();
  });
  timers.push(schedule(() => stop('deadline'), Math.max(0, remaining() - CLEANUP_MS)));
  timers.push(
    schedule(() => {
      cleanup();
      settle();
    }, remaining()),
  );
  try {
    if (group <= 0 || stopping || settled || closed || remaining() <= CLEANUP_MS) throw new Error();
    synchronous(() => lifecycle.owned(group));
    owned = true;
    if (stopping || invalid || settled || closed || remaining() <= CLEANUP_MS) throw new Error();
    child.stdin.write(`${JSON.stringify(plan)}\n`);
  } catch {
    ownershipFailed = true;
    invalidate();
  }
  return { group, result, stop: () => stop() };
}
