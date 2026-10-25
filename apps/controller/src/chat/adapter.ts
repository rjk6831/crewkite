import type {
  AgentEvent,
  ChatFailure,
  ChatFamily,
  ChatModelSelection,
  ChatPermissionPolicy,
  ChatRole,
  ChatSession,
  ChatToolKind,
} from '@crewkite/contracts';

// One interface for every provider behind the chat. The controller owns the thread, the
// scratch copy, permissions and the event log. An adapter owns one native process or
// connection for one turn and translates its protocol into AgentEvents.

export type ChatHistoryEntry = { role: 'user' | 'assistant'; text: string };

export type ChatTurnRequest = Readonly<{
  turnId: string;
  taskId: string;
  role: ChatRole;
  selection: ChatModelSelection;
  /** The user's text for this turn. A handoff packet is prepended by the controller. */
  prompt: string;
  /** CrewKite's framing for the model: project, scratch rules, what to do with results. */
  systemContext: string;
  /** Transcript so far, oldest first. Adapters with a resumable native session may ignore it. */
  history: readonly ChatHistoryEntry[];
  /** Native session to resume when the provider supports it. Null on the first turn. */
  session: ChatSession | null;
  /** The scratch copy where edits land. Never the person's checkout. */
  scratch: Readonly<{ directory: string; base: string; projectName: string }>;
  /** Private per-turn working directory under the controller home, for logs and sockets. */
  work: Readonly<{ directory: string; home: string }>;
  permissionPolicy: ChatPermissionPolicy;
  /** Tool kinds already allowed for the whole thread. Answer these without asking. */
  permissionGrants?: readonly ChatToolKind[];
  /** Review and advice turns. The adapter offers no edit or command tool and declines any ask. */
  readOnly?: boolean;
  /** Wall-clock budget for the whole turn, in milliseconds. */
  deadlineMs: number;
  /** Environment for the native client: HOME, PATH and what the profile already resolved. */
  environment: NodeJS.ProcessEnv;
  now?: () => number;
}>;

export type ChatTurnResult = Readonly<{
  stopReason: 'done' | 'stopped' | 'limit' | 'error';
  failure: ChatFailure | null;
  /** Final assistant text for this turn, all text items joined with blank lines. */
  assistantText: string;
  /** Updated native session identity, or null when the provider has none. */
  session: ChatSession | null;
  usage: { usedTokens: number; capacityTokens: number | null } | null;
  /** Paths the adapter believes it changed in scratch. The controller recomputes the real diff. */
  changedPaths: readonly string[];
}>;

export type ChatTurnHandle = Readonly<{
  /** Answer a permission.requested event. Unknown request IDs are ignored. */
  respondPermission(requestId: string, choice: string): void;
  /** Interrupt the turn through the native protocol, then terminate the owned process. */
  stop(): void;
  /** Process groups the controller must prove absent before the turn is quiescent. */
  readonly groups: readonly number[];
  readonly result: Promise<ChatTurnResult>;
}>;

export interface ChatAdapter {
  readonly family: ChatFamily;
  /**
   * Start one turn. Emit events in order. Resolve `result` once the native process is
   * finished, whether it succeeded, was stopped or failed. Never throw after returning.
   */
  startTurn(request: ChatTurnRequest, emit: (event: AgentEvent) => void): ChatTurnHandle;
}

/** Build the failure the person sees. Every adapter uses this so copy stays consistent. */
export function chatFailure(
  input: Partial<ChatFailure> & Pick<ChatFailure, 'stage' | 'kind' | 'message'>,
): ChatFailure {
  const nextAction =
    input.nextAction ??
    {
      'client-missing': 'Install or reconnect the provider client in Settings, then send again.',
      'client-exit':
        'Send again. If it repeats, open Settings for this provider and check its sign-in.',
      'signed-out': 'Sign in with the provider client, then send again.',
      'usage-limit': 'Continue on another provider, or wait for the reset.',
      'model-unavailable': 'Pick another model in the composer and send again.',
      protocol: 'Send again. If it repeats, the client version may have changed; see the details.',
      timeout: 'Send again with a smaller request, or raise the turn limit in Settings.',
      stopped: 'Send a new message to continue.',
      internal: 'Send again. If it repeats, report the details.',
      'attachment-rejected': 'Try another provider for these files.',
    }[input.kind];
  return {
    stage: input.stage,
    kind: input.kind,
    message: input.message,
    providerMessage: input.providerMessage ?? null,
    method: input.method ?? null,
    code: input.code ?? null,
    resetsAt: input.resetsAt ?? null,
    nextAction,
  };
}
