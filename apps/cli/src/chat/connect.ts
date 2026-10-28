import { connectController, createCommandKey, readControllerEndpoint } from '@crewkite/client/node';
import { type ChatClient, chatClient } from './client.ts';

/** The terminal's actor. The controller binds the real actor to the authenticated connection. */
export const terminalActor = { id: 'terminal', kind: 'cli' as const };

/** One authenticated socket connection to the controller of `home`, wrapped for chat commands. */
export async function connectChat(
  home: string,
  options: { reconnectDelaysMs?: readonly number[] } = {},
): Promise<ChatClient> {
  const transport = await connectController({
    ...readControllerEndpoint(home),
    actor: terminalActor,
    ...options,
  });
  return chatClient(transport, { key: createCommandKey, actor: terminalActor });
}
