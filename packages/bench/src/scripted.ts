import type { AgentEvent, ChatFamily, ChatRole } from '@crewkite/contracts';
import { type ChatScriptStep, createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import type { Task } from './manifest.ts';
import { git, repositoryOf } from './workspace.ts';

// The scripted side of the harness runs the whole pipeline without a provider. A plan says what a
// turn does for a task: which files it writes and what it reports. It proves the mechanics and
// says nothing about any model.

export type ScriptedTurn = {
  steps: ChatScriptStep[];
  /** Reported as the turn's own token count. Absent means the scripted client reports none. */
  tokens?: { in: number; out: number };
};
export type ScriptedPlan = (task: Task, role: ChatRole) => ScriptedTurn;

const statsFor = (
  turnId: string,
  tokens: { in: number; out: number },
  turnMs: number,
): AgentEvent => ({
  type: 'turn.stats',
  turnId,
  stats: {
    tokensIn: tokens.in,
    tokensOut: tokens.out,
    tokensPerSecond: null,
    firstTokenMs: null,
    turnMs,
    contextUsed: null,
    contextCapacity: null,
    summaries: 0,
  },
});

/** One adapter for the controller. It looks up the task the runner is working on for each turn. */
export function scriptedAdapter(
  family: ChatFamily,
  plan: ScriptedPlan,
  current: () => Task | null,
) {
  return {
    family,
    startTurn(
      request: Parameters<ReturnType<typeof createScriptedChatAdapter>['startTurn']>[0],
      emit: (event: AgentEvent) => void,
    ) {
      const task = current();
      const turn: ScriptedTurn = task
        ? plan(task, request.role)
        : { steps: [{ kind: 'text', itemId: 'reply', chunks: ['No task is running.'] }] };
      const inner = createScriptedChatAdapter({ family, turns: [turn.steps] });
      return inner.startTurn(request, (event) => {
        // The stats event comes just before the turn ends, as a client that reports usage sends it.
        if (event.type === 'turn.completed' && turn.tokens)
          emit(statsFor(event.turnId, turn.tokens, 1));
        emit(event);
      });
    },
  };
}

/**
 * A plan that writes the solution commit's files, so every task in a manifest can be pushed through
 * the full path and come out passing. Deleted files are not replayed. It answers any review with no
 * findings.
 */
export function oraclePlan(self: string): ScriptedPlan {
  return (task, role) => {
    if (role !== 'assistant')
      return { steps: [{ kind: 'text', itemId: 'review', chunks: ['No findings.\nFindings: 0'] }] };
    if (!task.solution)
      return { steps: [{ kind: 'text', itemId: 'reply', chunks: ['No solution is recorded.'] }] };
    const repository = repositoryOf(task, self);
    const changed = git(repository, [
      'diff',
      '--name-only',
      '-z',
      '--diff-filter=AM',
      task.base,
      task.solution,
    ])
      .toString('utf8')
      .split('\0')
      .filter((path) => path !== '' && !task.hidden.includes(path));
    return {
      steps: [
        ...changed.map(
          (path, index): ChatScriptStep => ({
            kind: 'tool',
            callId: `write-${index}`,
            toolKind: 'edit',
            title: `Write ${path}`,
            write: {
              path,
              content: git(repository, ['show', `${task.solution}:${path}`]).toString('utf8'),
            },
          }),
        ),
        { kind: 'text', itemId: 'reply', chunks: ['Done.'] },
      ],
    };
  };
}
