import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  defaultSchedule,
  OwnedCommand,
  type OwnedCommandLifecycle,
  type Schedule,
  type StreamingCommandOptions,
} from '../../host/worker.ts';
import {
  AnthropicUsageReader,
  anthropicUsageReaderAvailability,
  anthropicUsageReaderPlan,
  UsageReaderError,
} from './usage-reader.ts';

type Owner = Pick<
  OwnedCommand,
  | 'stdoutStream'
  | 'stderrStream'
  | 'closed'
  | 'exited'
  | 'inputCompleted'
  | 'failed'
  | 'ownershipUnknown'
  | 'stop'
  | 'quiescent'
>;
type Reading = ReturnType<AnthropicUsageReader['finish']>;
type Reason = 'protocol' | 'output-limit' | 'deadline' | 'stopped' | 'exit' | 'ownership';

/** The shared owner holds the fresh group and records intent before any native input. */
export function startAnthropicUsageReader(
  input: {
    operationId: string;
    executable: string;
    executableSha256: string;
    sessionId: string;
    directory: string;
    home: string;
    temporary: string;
    lifecycle: OwnedCommandLifecycle;
  },
  options: {
    now?: () => number;
    receivedAt?: () => string;
    schedule?: Schedule;
    create?: (options: StreamingCommandOptions) => Owner;
  } = {},
) {
  const plan = anthropicUsageReaderPlan({
    clientSha256: input.executableSha256,
    sessionId: input.sessionId,
  });
  // Managed hooks can run before the first frame. No supported preflight proves them absent yet.
  // Injected owners exercise this protocol offline and never authorize the default native spawn.
  if (!options.create) throw new UsageReaderError(anthropicUsageReaderAvailability.reason);
  if (!isAbsolute(input.home) || !isAbsolute(input.temporary)) throw new UsageReaderError('client');
  const now = options.now ?? (() => performance.now());
  const started = now();
  if (!Number.isFinite(started)) throw new UsageReaderError('client');
  const schedule = options.schedule ?? defaultSchedule;
  const owner = (options.create ?? ((value) => new OwnedCommand(value)))({
    streaming: true,
    operationId: input.operationId,
    executable: input.executable,
    executableIdentity: 'verified-prelaunch-sha256',
    executableSha256: plan.clientSha256,
    argv: plan.argv,
    directory: input.directory,
    environment: {
      HOME: input.home,
      TMPDIR: input.temporary,
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      NO_COLOR: '1',
    },
    lifecycle: input.lifecycle,
  });
  if (!owner.stdoutStream || !owner.stderrStream) {
    owner.stop();
    throw new UsageReaderError('protocol');
  }
  const parser = new AnthropicUsageReader(plan.sessionId);
  let reason: Reason | null = null;
  let cancelCleanup: (() => void) | undefined;
  const boundary = Promise.withResolvers<void>();
  let cleanupExpired = false;
  const stop = (value: Reason = 'stopped') => {
    reason ??= value;
    owner.stop();
    cancelCleanup ??= schedule(() => {
      cleanupExpired = true;
      boundary.resolve();
    }, 3000);
  };
  const cancelDeadline = schedule(() => stop('deadline'), plan.timeoutMs);
  const drain = async (source: AsyncIterable<Uint8Array>, stdout: boolean) => {
    let bytes = 0;
    try {
      for await (const chunk of source) {
        bytes += chunk.byteLength;
        const limit = stdout ? plan.maximumStdoutBytes : plan.maximumStderrBytes;
        if (bytes > limit) stop('output-limit');
        if (reason === null && stdout) parser.feed(chunk);
      }
    } catch (error) {
      stop(
        error instanceof UsageReaderError && error.reason === 'output-limit'
          ? 'output-limit'
          : 'protocol',
      );
    }
  };
  const output = Promise.all([drain(owner.stdoutStream, true), drain(owner.stderrStream, false)]);
  const result = (async () => {
    let reading: Reading | null = null;
    let exit: Awaited<Owner['exited']> | undefined;
    void owner.exited.then((value) => {
      exit = value;
    });
    const closed = await Promise.race([
      Promise.all([owner.closed, owner.inputCompleted, output]).then(
        () => true,
        () => {
          stop('protocol');
          return false;
        },
      ),
      boundary.promise.then(() => false),
    ]);
    let quiescent = false;
    if (closed) {
      const current = now();
      if (!Number.isFinite(current) || current < started || current - started > plan.timeoutMs)
        stop('deadline');
      quiescent = await Promise.race([
        owner.quiescent(schedule),
        boundary.promise.then(() => false),
      ]);
    }
    if (!quiescent) {
      stop('ownership');
      while (closed && !quiescent && !cleanupExpired) {
        const again = await Promise.race([
          new Promise<boolean>((resolve) => schedule(() => resolve(true), 25)),
          boundary.promise.then(() => false),
        ]);
        if (!again) break;
        quiescent = await Promise.race([
          owner.quiescent(schedule),
          boundary.promise.then(() => false),
        ]);
      }
    }
    if (!quiescent || owner.ownershipUnknown) reason = 'ownership';
    else if (owner.failed || exit?.code !== 0 || exit.signal !== null) reason ??= 'exit';
    if (reason === null) {
      try {
        reading = parser.finish((options.receivedAt ?? (() => new Date().toISOString()))());
      } catch {
        reason = 'protocol';
      }
    }
    cancelDeadline();
    cancelCleanup?.();
    return {
      reading,
      reason,
      quiescent,
      exitCode: exit?.code ?? null,
      signal: exit?.signal ?? null,
      modelPrompt: false as const,
    };
  })();
  return { result, stop: () => stop() };
}
