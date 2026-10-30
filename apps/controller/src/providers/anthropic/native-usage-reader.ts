import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import {
  defaultSchedule,
  OwnedCommand,
  type OwnedCommandLifecycle,
  type Schedule,
  type StreamingCommandOptions,
} from '../../host/worker.ts';
import {
  AnthropicUsageReader,
  anthropicUsageReaderPlan,
  maximumDetail,
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
type Reason = UsageReaderError['reason'] | 'deadline' | 'stopped' | 'exit' | 'ownership';
export type AnthropicUsageReaderContext = Readonly<{
  operationId: string;
  executable: string;
  executableSha256: string;
  /** The version the client reported for these bytes. */
  clientVersion: string;
  sessionId: string;
  directory: string;
  home: string;
  temporary: string;
}>;
const nativeTrust = z.strictObject({
  nativeTrust: z.literal('accepted'),
  scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type AnthropicUsageReaderTrust = z.infer<typeof nativeTrust>;
const usageScope = {
  version: 1,
  purpose: 'native-local-usage',
  nativeTrust: 'required',
  command: '/usage',
  generationRequest: false,
  policyHooks: 'covered-by-native-client-trust',
} as const;

// A read that fails says only which part was missing. What the client wrote is the cause, so the
// result keeps its reply text and, after a blank line, the end of its error output.
function detail(reply: string, errors: Buffer) {
  // The tail can start inside a character. Its replacement mark says nothing.
  const tail = new TextDecoder().decode(errors).replace(/^\u{FFFD}+/u, '');
  const text = [reply, tail.trim()].filter(Boolean).join('\n\n');
  return text ? text.slice(0, maximumDetail) : null;
}

/** The caller obtains explicit native-client trust for this scope before starting the command. */
export function anthropicUsageReaderScope(input: AnthropicUsageReaderContext) {
  const plan = anthropicUsageReaderPlan({
    clientSha256: input.executableSha256,
    clientVersion: input.clientVersion,
    sessionId: input.sessionId,
  });
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/.test(input.operationId) ||
    [input.executable, input.directory, input.home, input.temporary].some(
      (path) => !isAbsolute(path) || resolve(path) !== path || path.includes('\0'),
    )
  )
    throw new UsageReaderError('client');
  return {
    ...usageScope,
    scopeHash: createHash('sha256')
      .update(
        JSON.stringify({
          ...usageScope,
          operationId: input.operationId,
          executable: input.executable,
          executableSha256: plan.clientSha256,
          clientVersion: plan.clientVersion,
          sessionId: plan.sessionId,
          directory: input.directory,
          home: input.home,
          temporary: input.temporary,
          argv: plan.argv,
        }),
      )
      .digest('hex'),
  };
}

/** Invoke the local command without generation input; native policy hooks remain trusted client behavior. */
export function startAnthropicUsageReader(
  input: AnthropicUsageReaderContext & {
    trust?: AnthropicUsageReaderTrust;
    lifecycle: OwnedCommandLifecycle;
  },
  options: {
    now?: () => number;
    receivedAt?: () => string;
    schedule?: Schedule;
    create?: (options: StreamingCommandOptions) => Owner;
  } = {},
) {
  const context: AnthropicUsageReaderContext = {
    operationId: input.operationId,
    executable: input.executable,
    executableSha256: input.executableSha256,
    clientVersion: input.clientVersion,
    sessionId: input.sessionId,
    directory: input.directory,
    home: input.home,
    temporary: input.temporary,
  };
  const lifecycle = input.lifecycle;
  const scope = anthropicUsageReaderScope(context);
  const accepted = nativeTrust.safeParse(input.trust);
  if (!accepted.success || accepted.data.scopeHash !== scope.scopeHash)
    throw new UsageReaderError('native-trust-required');
  const plan = anthropicUsageReaderPlan({
    clientSha256: context.executableSha256,
    clientVersion: context.clientVersion,
    sessionId: context.sessionId,
  });
  const now = options.now ?? (() => performance.now());
  const started = now();
  if (!Number.isFinite(started)) throw new UsageReaderError('client');
  const schedule = options.schedule ?? defaultSchedule;
  const owner = (options.create ?? ((value) => new OwnedCommand(value)))({
    streaming: true,
    operationId: context.operationId,
    executable: context.executable,
    executableIdentity: 'verified-prelaunch-sha256',
    executableSha256: plan.clientSha256,
    argv: plan.argv,
    directory: context.directory,
    environment: {
      HOME: context.home,
      // The client reads its sign-in from the Keychain under this name, so without it /usage runs
      // signed out and prints no usage report.
      USER: userInfo().username,
      LOGNAME: userInfo().username,
      TMPDIR: context.temporary,
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      NO_COLOR: '1',
    },
    lifecycle,
  });
  if (!owner.stdoutStream || !owner.stderrStream) {
    owner.stop();
    throw new UsageReaderError('client');
  }
  const parser = new AnthropicUsageReader();
  let errors = Buffer.alloc(0);
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
        if (!stdout) errors = Buffer.concat([errors, chunk]).subarray(-maximumDetail);
        if (reason === null && stdout) parser.feed(chunk);
      }
    } catch (error) {
      stop(error instanceof UsageReaderError ? error.reason : 'exit');
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
          stop('exit');
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
      } catch (error) {
        reason = error instanceof UsageReaderError ? error.reason : 'exit';
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
      detail: detail(parser.reply(), errors),
      modelPrompt: false as const,
    };
  })();
  return { result, stop: () => stop() };
}
