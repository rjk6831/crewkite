import type { AgentEvent } from '@crewkite/contracts';
import type { ChatTurnRequest } from '../adapter.ts';
import { withoutThreadToolsLine } from '../prompt.ts';
import type { ThreadToolsServer } from './broker.ts';

/** The trace line of a turn that runs without the thread tools. */
export const THREAD_TOOLS_ABSENT =
  'Thread tools absent for this turn: thread_turns, thread_turn, thread_diff, thread_checks and thread_live.';

/**
 * The thread tools server for one turn, minted once. A source that gives none leaves the turn
 * without the tools: the request is marked, the packet loses its tools line and the trace says
 * so, so the packet, the client's config and the notice agree. A turn the controller already
 * marked, or a wiring with no source, passes through.
 */
export function turnTools(
  source: ((request: ChatTurnRequest) => ThreadToolsServer | null) | undefined,
  request: ChatTurnRequest,
  emit: (event: AgentEvent) => void,
): { request: ChatTurnRequest; server: ThreadToolsServer | null } {
  if (request.threadTools === false || !source) return { request, server: null };
  const server = source(request);
  if (server) return { request, server };
  emit({
    type: 'provider.notice',
    turnId: request.turnId,
    level: 'info',
    message: THREAD_TOOLS_ABSENT,
    trace: true,
  });
  return {
    request: { ...request, threadTools: false, prompt: withoutThreadToolsLine(request.prompt) },
    server: null,
  };
}
