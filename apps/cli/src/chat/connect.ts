import { readdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { connectController, createCommandKey, readControllerEndpoint } from '@crewkite/client/node';
import { type ChatClient, chatClient } from './client.ts';

/** The terminal's actor. The controller binds the real actor to the authenticated connection. */
export const terminalActor = { id: 'terminal', kind: 'cli' as const };

// One schema version per bundled migration, the same count the controller records for itself.
const bundledSchema = () =>
  readdirSync(new URL('../../../controller/migrations/', import.meta.url)).filter((name) =>
    /^\d{3}-[a-z0-9-]+\.sql$/.test(name),
  ).length;

// Whether a process accepts connections on the socket. Nothing is written, so no token goes out.
const listening = (socketPath: string) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

/**
 * Refuses a live controller on another schema before the token goes to it. One that records no
 * schema is from before the check and counts as older. A record whose socket nobody listens on is
 * left from a stopped controller, and the normal connect reports it.
 */
export async function assertSameSchema(
  endpoint: { socketPath: string; schema?: number },
  bundled = bundledSchema(),
): Promise<void> {
  if (endpoint.schema === bundled || !(await listening(endpoint.socketPath))) return;
  throw new Error(
    (endpoint.schema ?? 0) < bundled
      ? 'An older CrewKite is still running with this home. Quit it from its menu, then open CrewKite again.'
      : 'A newer CrewKite is running with this home. Use that version.',
  );
}

/** One authenticated socket connection to the controller of `home`, wrapped for chat commands. */
export async function connectChat(
  home: string,
  options: { reconnectDelaysMs?: readonly number[] } = {},
): Promise<ChatClient> {
  const endpoint = readControllerEndpoint(home);
  await assertSameSchema(endpoint);
  const transport = await connectController({
    ...endpoint,
    actor: terminalActor,
    ...options,
  });
  return chatClient(transport, { key: createCommandKey, actor: terminalActor });
}
