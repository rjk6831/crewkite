import type {
  AgentEvent,
  ChatEffort,
  ChatFailure,
  ChatFamily,
  ChatRole,
  ChatSession,
} from '@crewkite/contracts';

// A scripted chat provider for controller tests. It emits the same AgentEvent stream a real
// adapter emits, answers permissions through respondPermission and honors stop(), without
// any provider client. It matches the controller's ChatAdapter interface structurally.

export type ChatScriptStep =
  /** Stream chunks for one text item. `complete: false` leaves the item open. */
  | { kind: 'text'; itemId: string; chunks: string[]; complete?: boolean }
  /** Ask for permission and wait for respondPermission with this request ID. */
  | { kind: 'permission'; requestId: string; question: string }
  /** Park until stop(). */
  | { kind: 'wait' }
  /** End the turn with this failure. */
  | { kind: 'fail'; stopReason: 'limit' | 'error'; failure: ChatFailure };

export type ScriptedChatRequest = Readonly<{
  turnId: string;
  role: ChatRole;
  selection: Readonly<{ family: ChatFamily; model: string; effort: ChatEffort }>;
  prompt: string;
  systemContext: string;
  history: readonly Readonly<{ role: 'user' | 'assistant'; text: string }>[];
  session: ChatSession | null;
  scratch: Readonly<{ directory: string; base: string; projectName: string }>;
  now?: () => number;
}>;

type Result = {
  stopReason: 'done' | 'stopped' | 'limit' | 'error';
  failure: ChatFailure | null;
  assistantText: string;
  session: ChatSession | null;
  usage: null;
  changedPaths: string[];
};

/** Turn N plays `turns[N]`, or the last script once the list runs out. */
export function createScriptedChatAdapter(options: {
  family: ChatFamily;
  turns: readonly (readonly ChatScriptStep[])[];
}) {
  const requests: ScriptedChatRequest[] = [];
  return {
    family: options.family,
    requests,
    startTurn(request: ScriptedChatRequest, emit: (event: AgentEvent) => void) {
      const steps = options.turns[Math.min(requests.length, options.turns.length - 1)] ?? [];
      requests.push(request);
      const answers = new Map<string, string>();
      let stopped = false;
      let wake = () => {};
      const pause = () => new Promise<void>((resolve) => (wake = resolve));
      const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
      const play = async (): Promise<Result> => {
        const { turnId, selection } = request;
        // Like a native client that drops the open item on interrupt, a stop reports only
        // completed items. The controller keeps what was streamed.
        const completed: string[] = [];
        const end = (stopReason: Result['stopReason'], failure: ChatFailure | null): Result => {
          emit({ type: 'turn.completed', turnId, stopReason, failure });
          return {
            stopReason,
            failure,
            assistantText: completed.join('\n\n'),
            session:
              stopReason === 'done'
                ? {
                    family: options.family,
                    sessionId: `session-${turnId}`,
                    model: selection.model,
                    updatedAt: new Date(request.now?.() ?? 0).toISOString(),
                  }
                : null,
            usage: null,
            changedPaths: [],
          };
        };
        await tick();
        emit({
          type: 'turn.started',
          turnId,
          family: options.family,
          model: selection.model,
          effort: selection.effort,
          role: request.role,
        });
        for (const step of steps) {
          if (stopped) break;
          if (step.kind === 'fail') return end(step.stopReason, step.failure);
          if (step.kind === 'wait') while (!stopped) await pause();
          if (step.kind === 'permission') {
            emit({
              type: 'permission.requested',
              turnId,
              requestId: step.requestId,
              callId: null,
              question: step.question,
              detail: null,
              options: [
                { id: 'allow-once', label: 'Allow once', kind: 'allow-once' },
                { id: 'deny', label: 'Deny', kind: 'deny' },
              ],
            });
            while (!stopped && !answers.has(step.requestId)) await pause();
            const choice = answers.get(step.requestId);
            if (choice)
              emit({ type: 'permission.resolved', turnId, requestId: step.requestId, choice });
          }
          if (step.kind === 'text') {
            let text = '';
            for (const chunk of step.chunks) {
              await tick();
              if (stopped) break;
              text += chunk;
              emit({ type: 'text.delta', turnId, itemId: step.itemId, text: chunk });
            }
            if (!stopped && step.complete !== false) {
              emit({ type: 'text.completed', turnId, itemId: step.itemId, text });
              completed.push(text);
            }
          }
        }
        return end(stopped ? 'stopped' : 'done', null);
      };
      return {
        respondPermission(requestId: string, choice: string) {
          answers.set(requestId, choice);
          wake();
        },
        stop() {
          stopped = true;
          wake();
        },
        groups: [] as number[],
        result: play(),
      };
    },
  };
}
