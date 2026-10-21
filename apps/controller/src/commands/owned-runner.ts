import {
  defaultSchedule,
  OwnedCommand,
  type Schedule,
  type StreamingCommandOptions,
} from '../host/worker.ts';
import type { OwnedProjectCommandRunner, OwnedProjectCommandTerminal } from './project-command.ts';

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
> & { discardOutput: () => void };

// The shared owner remains the only spawn and signal authority. These timers observe its
// admitted deadline and bounded cleanup; they do not admit or schedule another operation.
export function createOwnedProjectCommandRunner(options: {
  deadlineMs: number;
  schedule?: Schedule;
  now?: () => number;
  create?: (options: StreamingCommandOptions) => Owner;
}): OwnedProjectCommandRunner {
  if (
    !Number.isSafeInteger(options.deadlineMs) ||
    options.deadlineMs < 1 ||
    options.deadlineMs > 86400000
  )
    throw Error('Command deadline is invalid.');
  const schedule = options.schedule ?? defaultSchedule;
  const create =
    options.create ??
    ((input: StreamingCommandOptions): Owner => {
      const owner = new OwnedCommand(input);
      return Object.assign(owner, {
        discardOutput: () => {
          owner.child.stdout.destroy(Error('Operation output ownership is unresolved.'));
          owner.child.stderr.destroy(Error('Operation output ownership is unresolved.'));
        },
      });
    });
  return {
    launch(request, lifecycle) {
      const now = options.now ?? (() => performance.now());
      const deadline = now() + options.deadlineMs;
      const owner = create({
        streaming: true,
        operationId: request.operationId,
        executable: request.executable,
        executableIdentity: request.executableIdentity,
        executableSha256: request.executableSha256,
        argv: request.argv,
        directory: request.cwd,
        environment: request.environment,
        lifecycle,
      });
      if (!owner.stdoutStream || !owner.stderrStream)
        throw Error('Command streams are unavailable.');
      let reason: OwnedProjectCommandTerminal['reason'] = 'exit';
      let cancelCleanup: (() => void) | undefined;
      const boundary = Promise.withResolvers<void>();
      const cleanup = () => {
        if (!cancelCleanup) cancelCleanup = schedule(() => boundary.resolve(), 3000);
      };
      const stop = () => {
        if (reason === 'exit') reason = 'stopped';
        owner.stop();
        cleanup();
      };
      const cancelDeadline = schedule(
        () => {
          if (reason === 'exit') reason = 'deadline';
          owner.stop();
          cleanup();
        },
        Math.max(0, deadline - now()),
      );
      const terminal = (async (): Promise<OwnedProjectCommandTerminal> => {
        let exit: Awaited<Owner['exited']> | undefined;
        void owner.exited.then((value) => {
          exit = value;
        });
        const closed = await Promise.race([
          Promise.all([
            owner.closed,
            owner.inputCompleted.catch(() => {
              if (reason === 'exit') reason = 'launch';
              owner.stop();
              cleanup();
            }),
          ]).then(() => true),
          boundary.promise.then(() => false),
        ]);
        if (closed) {
          for (;;) {
            const unknownBefore = owner.ownershipUnknown;
            if (await owner.quiescent(schedule)) {
              cancelDeadline();
              cancelCleanup?.();
              return {
                code: exit?.code ?? null,
                signal: exit?.signal ?? null,
                quiescent: true,
                reason: owner.ownershipUnknown
                  ? 'ownership'
                  : owner.failed && reason === 'exit'
                    ? 'launch'
                    : reason,
              };
            }
            // A failed durable closure callback is not retried by a polling observer.
            if (!unknownBefore && owner.ownershipUnknown) break;
            if (reason === 'exit') reason = 'ownership';
            owner.stop();
            cleanup();
            const again = await Promise.race([
              new Promise<boolean>((resolve) => schedule(() => resolve(true), 25)),
              boundary.promise.then(() => false),
            ]);
            if (!again) break;
          }
        }
        cancelDeadline();
        cancelCleanup?.();
        owner.discardOutput();
        return {
          code: exit?.code ?? null,
          signal: exit?.signal ?? null,
          quiescent: false,
          reason: 'ownership',
        };
      })();
      return { stdout: owner.stdoutStream, stderr: owner.stderrStream, terminal, stop };
    },
  };
}
