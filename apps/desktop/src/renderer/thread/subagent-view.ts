import type { ChatRole, SubagentState } from '@crewkite/contracts';
import { familyName } from '../family-name.ts';
import type { Block, SubagentActivity, TurnIdentity } from './turn-fold.ts';

// What the turn chip and a spawn card say about a turn and the subagents its client started.
// Pure, so the words and states are tested without a renderer.

/** The role a turn ran as, in the words the crew editor uses. A plain reply is the builder's. */
const chipRoles: Record<ChatRole, string> = {
  assistant: 'Builder',
  reviewer: 'Reviewer',
  advisor: 'Advisor',
  challenger: 'Challenger',
  fixer: 'Fixer',
  orchestrator: 'Orchestrator',
  ask: 'Ask',
};

export type TurnChip = {
  role: string;
  family: TurnIdentity['family'];
  familyName: string;
  model: string;
  /** Null when the client picked the level, since the label would say nothing. */
  effort: TurnIdentity['effort'] | null;
};

export function turnChip(identity: TurnIdentity): TurnChip {
  return {
    role: chipRoles[identity.role],
    family: identity.family,
    familyName: familyName(identity.family),
    model: identity.model,
    effort: identity.effort === 'default' ? null : identity.effort,
  };
}

const plural = (count: number) => `${count} ${count === 1 ? 'subagent' : 'subagents'}`;

/**
 * The state a subagent shows. Once the turn ended, one the client never closed did not finish,
 * so it reads as stopped.
 */
const shown = (state: SubagentState, ended: boolean): SubagentState =>
  ended && state === 'running' ? 'stopped' : state;

export type SubagentBadge = {
  /** The words on the badge. */
  text: string;
  /** The sentence a screen reader hears, with every count spelled out. */
  label: string;
  tone: 'running' | 'done' | 'failed';
};

/**
 * The badge for a set of subagents: a live count while any run, then the total. A failure or a
 * stop keeps its own count, so a turn that lost work never reads as clean. Null with none.
 */
export function subagentBadge(
  activities: readonly SubagentActivity[],
  ended: boolean,
): SubagentBadge | null {
  let total = 0;
  let running = 0;
  let failed = 0;
  let stopped = 0;
  for (const activity of activities) {
    total += activity.running + activity.finished;
    // The counts run past the listed agents. A finished one the list leaves out counts as done,
    // and once the turn ended a running one it leaves out counts as stopped.
    const listed = activity.agents.map((agent) => shown(agent.state, ended));
    const listedRunning = activity.agents.filter((agent) => agent.state === 'running').length;
    running += ended ? 0 : activity.running;
    failed += listed.filter((state) => state === 'failed').length;
    stopped +=
      listed.filter((state) => state === 'stopped').length +
      (ended ? Math.max(0, activity.running - listedRunning) : 0);
  }
  if (total === 0) return null;
  if (running > 0)
    return {
      text: `${running} of ${plural(total)}`,
      label: `${plural(total)}, ${running} running`,
      tone: 'running',
    };
  const lost = [failed ? `${failed} failed` : '', stopped ? `${stopped} stopped` : '']
    .filter(Boolean)
    .join(', ');
  return {
    text: plural(total),
    label: lost ? `${plural(total)}, ${lost}` : `${plural(total)}, all finished`,
    tone: lost ? 'failed' : 'done',
  };
}

/** Every spawn card's activity in the turn, in the order the cards appear. */
export const turnActivities = (blocks: readonly Block[]): SubagentActivity[] =>
  blocks.flatMap((block) => (block.kind === 'tool' && block.subagents ? [block.subagents] : []));

const stateWords: Record<SubagentState, string> = {
  running: 'Running',
  done: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped',
};

export type SubagentRow = {
  key: string;
  name: string;
  state: SubagentState;
  stateText: string;
  /** The latest action, or what the subagent is doing when it has reported none yet. */
  action: string;
  model: string | null;
};

/** The rows a spawn card lists: one per subagent, with its latest action. */
export function subagentRows(activity: SubagentActivity, ended: boolean): SubagentRow[] {
  const rows = activity.agents.map((agent, index) => {
    const state = shown(agent.state, ended);
    return {
      key: agent.id,
      name: `Subagent ${index + 1}`,
      state,
      stateText: stateWords[state],
      action: agent.action ?? (state === 'running' ? 'Starting' : 'No action reported'),
      model: agent.model,
    };
  });
  return rows;
}

/**
 * Why a role's subagent switch does nothing for a family, or null when the family's client takes
 * it. Local runs one model with no subagents of its own.
 */
export function subagentSwitchNote(family: TurnIdentity['family'] | null | undefined) {
  return family === 'local' ? 'Local starts no subagents, so there is nothing to turn off.' : null;
}

/** The line under the rows when the client reported more subagents than the card lists. */
export function unlistedLine(activity: SubagentActivity): string | null {
  const more = activity.running + activity.finished - activity.agents.length;
  return more > 0 ? `${plural(more)} more not listed.` : null;
}
