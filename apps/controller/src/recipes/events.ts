import type {
  ChatCheckRun,
  ChatCrewRole,
  ChatFamily,
  ChatTurn,
  ResultStep,
} from '@crewkite/contracts';

// What the chat service and the plan runner decide as a plan runs, one event at a time. Each
// event is sent where its fact is decided. Most go out inside the transaction that writes their
// fact, so a listener that writes in the same transaction can never disagree with the thread. Two
// go out right after it, in a transaction of their own: `asked` for a permission request, once
// the client did not answer it in the same tick, and the `plan-ended` of an orchestrator turn that
// wrote no plan, once nothing moved the work on. Every plan thread sends them, whether or not a
// recipe started it. The listener decides what to keep, and a throw undoes what it wrote.

/** One step of a plan as it opens or ends. */
export type PlanStep = {
  /** Null for a step of the whole plan: the challenge or the report. */
  slice: number | null;
  step: ResultStep;
  /** Null for a merge, which runs no turn. */
  turnId: string | null;
  /** The slice's builder turn for a lane step, the plan's orchestrator turn for a plan step. */
  anchorTurnId: string;
  /** The crew role whose model runs the step. Null for a merge. */
  role: ChatCrewRole | null;
  family: ChatFamily | null;
  model: string | null;
  effort: string | null;
};

/**
 * How a step ended. stopped: something asked it to stop, such as the person or the plan. A turn
 * the provider client ended on its own failed.
 */
export type StepOutcome = 'done' | 'failed' | 'stopped' | 'limit';

/** How a plan ended. paused: slices are left that the person can run from the plan card. */
export type PlanEnding = 'finished' | 'failed' | 'stopped' | 'paused';

/** An event without the thread and the time, as a call site builds it. */
export type PlanEventBody =
  | {
      kind: 'plan-proposed';
      orchestratorTurnId: string;
      slices: number;
      /** The plan waits for the person's Run plan. */
      waits: boolean;
    }
  | { kind: 'plan-started' }
  | ({ kind: 'step-started' } & PlanStep)
  | ({
      kind: 'step-ended';
      /**
       * What the step's turn recorded. A turn records its rules and design system as it launches,
       * after the transaction that opens it, so only the end can carry them.
       */
      rulesDigest: string | null;
      designVersionHash: string | null;
      outcome: StepOutcome;
      durationMs: number | null;
      /** The findings a review stated. Null for any other step and for a review that stated none. */
      findings: number | null;
    } & PlanStep)
  | {
      kind: 'gate';
      slice: number | null;
      anchorTurnId: string;
      trigger: ChatCheckRun['trigger'];
      /** unknown: no result stands, such as checks the person stopped or did not allow. */
      result: 'passed' | 'failed' | 'unknown';
    }
  | { kind: 'asked'; question: 'permission' | 'checks' | 'plan' }
  /**
   * The thread has no open question left: the last one was answered, or the turn that asked it
   * ended without an answer.
   */
  | { kind: 'answered' }
  | {
      kind: 'plan-ended';
      outcome: PlanEnding;
      /** The thread's line for the ending, or empty when it shows none. */
      line: string;
      /**
       * A finished plan: the findings each slice's first review stated, summed, or for a report
       * the findings its closing message kept. Null when no review ran or the count is unknown.
       */
      findings: number | null;
    }
  | { kind: 'accepted' }
  /** The person discarded a file or a hunk of the thread's copy. Changes may remain. */
  | { kind: 'changes-discarded' }
  | { kind: 'thread-deleted' };

export type PlanEvent = { taskId: string; at: string } & PlanEventBody;

/** Where a step's turn ran: the turn itself, with its family, model and effort. */
export function stepTurn(turn: Pick<ChatTurn, 'id' | 'selection'>) {
  return {
    turnId: turn.id,
    family: turn.selection.family,
    model: turn.selection.model,
    effort: turn.selection.effort,
  };
}

/**
 * Hands each event to every listener in turn, each behind its own savepoint. One that throws
 * undoes only its own writes, and the next still hears the event. A listener's first failure is
 * logged and its later ones are not, so a broken listener cannot fill the log.
 */
export function fanOut(
  store: { savepoint<T>(name: string, work: () => T): T },
  listeners: Record<string, (event: PlanEvent) => void>,
  log: (line: string) => void,
): (event: PlanEvent) => void {
  const failed = new Set<string>();
  return (event) => {
    for (const [name, listener] of Object.entries(listeners))
      try {
        store.savepoint(name, () => listener(event));
      } catch (error) {
        if (failed.has(name)) continue;
        failed.add(name);
        log(`${name}: ${String(error)}`);
      }
  };
}
