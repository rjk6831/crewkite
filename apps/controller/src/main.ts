import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Controller, type ControllerOptions } from './commands/controller.ts';
import { configuredIdentity } from './host/publication.ts';
import { serve } from './server/index.ts';

export async function startController(options: ControllerOptions) {
  const controller = new Controller(options);
  try {
    const server = await serve(controller);
    return {
      controller,
      socketPath: server.socketPath,
      close: async () => {
        try {
          await server.close();
        } finally {
          controller.close();
        }
      },
    };
  } catch (error) {
    controller.close();
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
