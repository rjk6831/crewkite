import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Controller, type ControllerOptions } from './commands/controller.ts';
import { configuredIdentity } from './host/publication.ts';
import { resolveAnthropicNativeProfile } from './providers/anthropic/profile.ts';
import { resolveNativeProfile } from './providers/openai/profile.ts';
import { serve } from './server/index.ts';

export async function startController(options: ControllerOptions) {
  const controller = new Controller({
    nativeProfiles: options.nativeProfile
      ? undefined
      : () => [resolveNativeProfile(), resolveAnthropicNativeProfile()],
    ...options,
  });
  try {
    const server = await serve(controller);
    let closing: Promise<void> | undefined;
    return {
      controller,
      socketPath: server.socketPath,
      close: () => {
        if (closing) return closing;
        const completion = Promise.withResolvers<void>();
        closing = completion.promise;
        try {
          const stopped = controller.close();
          void (async () => {
            try {
              await server.close();
            } finally {
              await stopped;
            }
          })().then(completion.resolve, completion.reject);
        } catch (error) {
          completion.reject(error);
        }
        return closing;
      },
    };
  } catch (error) {
    await controller.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const home = process.env.CREWKITE_HOME ?? join(homedir(), '.crewkite');
  try {
    const runtime = await startController({ home, identity: () => configuredIdentity(home) });
    console.log(`Controller ready at ${runtime.socketPath}`);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await runtime.close();
      process.exit(0);
    };
    process.once('SIGTERM', () => {
      void close();
    });
    process.once('SIGINT', () => {
      void close();
    });
  } catch {
    console.error('Controller could not start. Check its private home and existing owner.');
    process.exitCode = 1;
  }
}
