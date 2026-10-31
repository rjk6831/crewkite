import {
  type AgentEvent,
  allowsSubagents,
  type ChatCrew,
  type ChatFamily,
  type ChatRole,
  MAX_SUBAGENTS,
  type Subagent,
  type SubagentState,
} from '@crewkite/contracts';

// Subagents a provider client starts inside one turn. Each adapter reads its own client's frames
// and reports here; this module keeps the count per parent tool call and sends one
// `tool.subagents` event each time the picture for that call changes.

/**
 * Whether the crew lets this turn's client start subagents. A builder turn reads the builder's
 * switch, and a fix with no fixer in the crew runs as the builder, as the chain does. A role saved
 * without the switch, and a turn outside a crew, take the family default.
 */
export function turnAllowsSubagents(
  crew: ChatCrew | null | undefined,
  role: ChatRole,
  family: ChatFamily,
): boolean {
  const members = crew?.members ?? [];
  const find = (name: string) => members.find((member) => member.role === name);
  const member =
    role === 'assistant'
      ? find('builder')
      : role === 'fixer'
        ? (find('fixer') ?? find('builder'))
        : find(role);
  return allowsSubagents(member, family);
}

// One turn tracks at most this many subagents. A client that reports more keeps its cards and
// counts for the ones already seen.
const MAX_TRACKED = 1024;
const ACTION = 300;
const ID = 200;

const words = (value: string | null | undefined, limit: number) => {
  const text = value?.replace(/\s+/g, ' ').trim() ?? '';
  return text ? text.slice(0, limit) : null;
};

/** A client's item or tool type as words: `collabAgentToolCall` reads as `Collab agent tool call`. */
export function readableType(type: string): string {
  const spaced = type
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-./]+/g, ' ')
    .trim()
    .toLowerCase();
  const text = words(spaced, 200) ?? 'tool call';
  return text[0].toUpperCase() + text.slice(1);
}

export type SubagentChange = Readonly<{
  state?: SubagentState;
  action?: string | null;
  model?: string | null;
}>;

export class SubagentTracker {
  private readonly agents = new Map<string, { parent: string; agent: Subagent }>();
  private readonly parents = new Map<string, string[]>();
  private readonly sent = new Map<string, string>();
  private readonly turnId: string;
  private readonly send: (event: AgentEvent) => void;

  constructor(turnId: string, send: (event: AgentEvent) => void) {
    this.turnId = turnId;
    this.send = send;
  }

  /** The parent call a subagent was first seen under, or null for one this turn has not seen. */
  parentOf(id: string): string | null {
    return this.agents.get(id)?.parent ?? null;
  }

  /** Subagent IDs still running, oldest first. */
  running(): string[] {
    return [...this.agents].flatMap(([id, { agent }]) => (agent.state === 'running' ? [id] : []));
  }

  /**
   * Records what the client said about one subagent. A new one starts as running under `parent`;
   * a known one keeps the parent it was first seen under, so a later call that waits on it updates
   * the card that started it. An action or model left out keeps the last one.
   */
  update(parent: string, id: string, change: SubagentChange = {}) {
    const key = words(id, ID);
    const under = words(parent, ID);
    if (!key || !under) return;
    let entry = this.agents.get(key);
    if (!entry) {
      if (this.agents.size >= MAX_TRACKED) return;
      entry = {
        parent: under,
        agent: { id: key, state: 'running', action: null, model: null },
      };
      this.agents.set(key, entry);
      this.parents.set(under, [...(this.parents.get(under) ?? []), key]);
    }
    const { agent } = entry;
    if (change.state) agent.state = change.state;
    if (change.action !== undefined) agent.action = words(change.action, ACTION) ?? agent.action;
    if (change.model !== undefined) agent.model = words(change.model, ID) ?? agent.model;
    this.flush(entry.parent);
  }

  /** Forgets a subagent, as when a stand-in gives way to the threads the client named. */
  remove(id: string) {
    const entry = this.agents.get(id);
    if (!entry) return;
    this.agents.delete(id);
    this.parents.set(
      entry.parent,
      (this.parents.get(entry.parent) ?? []).filter((value) => value !== id),
    );
    this.flush(entry.parent);
  }

  /** Every subagent still running under `parent` settles to `state`. */
  settle(parent: string, state: Exclude<SubagentState, 'running'>) {
    for (const id of this.parents.get(parent) ?? []) {
      const agent = this.agents.get(id)?.agent;
      if (agent?.state === 'running') agent.state = state;
    }
    this.flush(parent);
  }

  /** The turn ended. Subagents still running settle to `state`. */
  close(state: Exclude<SubagentState, 'running'>) {
    for (const parent of this.parents.keys()) this.settle(parent, state);
  }

  private flush(parent: string) {
    const agents = (this.parents.get(parent) ?? []).flatMap((id) => {
      const agent = this.agents.get(id)?.agent;
      return agent ? [{ ...agent }] : [];
    });
    if (!agents.length) return;
    const running = agents.filter((agent) => agent.state === 'running').length;
    const event: AgentEvent = {
      type: 'tool.subagents',
      turnId: this.turnId,
      callId: parent,
      running,
      finished: agents.length - running,
      agents: agents.slice(0, MAX_SUBAGENTS),
    };
    const text = JSON.stringify(event);
    if (this.sent.get(parent) === text) return;
    this.sent.set(parent, text);
    this.send(event);
  }
}
