import {
  type ChatFamily,
  type ChatPermissionPolicy,
  type ChatToolKind,
  MCP_RESERVED_NAME,
  type McpSupply,
  mcpSecrets,
} from '@crewkite/contracts';

// The person's own MCP servers, as the controller lets them into a turn. The desktop supplies the
// definitions and the per-thread policies in memory. Everything below is decided here, per turn,
// from the thread's permission policy and the family. A server's own claims about itself, its
// name for a tool or its annotations, can make a call ask more often and never less.

export type McpPolicy = 'ask' | 'reads' | 'all';
const RANK: Record<McpPolicy, number> = { ask: 0, reads: 1, all: 2 };

/** One server as a turn receives it: the policy is already cut to the thread's ceiling. */
export type ThreadMcpServer = Readonly<{
  name: string;
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  policy: McpPolicy;
  readTools: readonly string[];
}>;
export type ThreadMcp = Readonly<{
  servers: readonly ThreadMcpServer[];
  /** One line per server the thread turned on and this turn leaves off, for the turn trace. */
  notes: readonly string[];
  /** Secret argument and variable values of the attached servers, scrubbed from the turn's events. */
  secrets: readonly string[];
}>;

/**
 * The most a server's policy can reach on a thread. Ask lets nothing through unasked. Allow edits
 * lets reads through, since an edit is the larger step. Only allow all lets every tool through.
 */
export const THREAD_CEILING: Record<ChatPermissionPolicy, McpPolicy> = {
  ask: 'ask',
  'allow-edits': 'reads',
  'allow-all': 'all',
};
export const ceiling = (server: McpPolicy, thread: ChatPermissionPolicy): McpPolicy =>
  RANK[server] <= RANK[THREAD_CEILING[thread]] ? server : THREAD_CEILING[thread];

/** A tool annotation set as a server reports it. Optional, and only ever narrows. */
export type McpHints = Readonly<{ readOnlyHint?: boolean; destructiveHint?: boolean }>;

const matches = (patterns: readonly string[], tool: string) =>
  patterns.some((pattern) =>
    pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : pattern === tool,
  );

/**
 * Whether a call runs without asking. Ask never does and all always does. Reads runs a tool only
 * when the person listed it as a read. A server's readOnlyHint is a claim by the server, so a hint
 * of false or a destructive hint turns a listed read back into an ask, and a hint of true does
 * nothing. The person's list is the only thing that widens.
 */
export function mcpDecision(
  policy: McpPolicy,
  readTools: readonly string[],
  tool: string,
  hints?: McpHints,
): 'allow' | 'ask' {
  if (policy === 'all') return 'allow';
  if (policy === 'ask') return 'ask';
  if (hints?.readOnlyHint === false || hints?.destructiveHint === true) return 'ask';
  return matches(readTools, tool) ? 'allow' : 'ask';
}

/** The tool name a client builds for a server's tool, `mcp__<server>__<tool>`. */
export function parseMcpTool(name: string): { server: string; tool: string } | null {
  const found = /^mcp__([a-z][a-z0-9-]*)__(.+)$/.exec(name);
  return found ? { server: found[1], tool: found[2] } : null;
}

/**
 * The answer for a client's permission ask about an MCP tool of a person's server, or null when
 * the tool is not one: a built in tool, or a thread tool, which the client's allow rule answers. A
 * tool of a server this turn did not attach asks.
 */
export function mcpToolAnswer(
  mcp: ThreadMcp | undefined,
  name: string,
  hints?: McpHints,
): 'allow' | 'ask' | null {
  const parsed = parseMcpTool(name);
  if (!parsed || parsed.server === MCP_RESERVED_NAME) return null;
  const server = mcp?.servers.find((value) => value.name === parsed.server);
  if (!server) return 'ask';
  return mcpDecision(server.policy, server.readTools, parsed.tool, hints);
}

const GOOGLE_NOTE =
  'Google reports a call by its kind and title, so these servers join only while the thread asks for everything and grants no kind.';
const OFF_NOTE: Partial<Record<ChatFamily, string>> = {
  openai: 'The OpenAI client does not send MCP tool approvals to CrewKite yet.',
  local: 'Local runs no MCP servers.',
};

export type McpTurn = Readonly<{
  family: ChatFamily;
  taskId: string;
  permissionPolicy: ChatPermissionPolicy;
  permissionGrants?: readonly ChatToolKind[];
  readOnly?: boolean;
}>;

/** What the desktop last supplied. Memory only; the desktop supplies it again after a restart. */
export class McpRegistry {
  private supply: McpSupply = { servers: [], threads: {} };

  set(next: McpSupply) {
    this.supply = next;
  }

  /** The servers one turn may start, with the policy each can reach, and the notes for the rest. */
  compose(turn: McpTurn): ThreadMcp {
    const chosen = this.supply.threads[turn.taskId] ?? {};
    const on = this.supply.servers.filter((server) => server.name in chosen);
    if (!on.length) return { servers: [], notes: [], secrets: [] };
    const off = (reason: string) => ({
      servers: [],
      secrets: [],
      notes: on.map((server) => `MCP server ${server.name} is off for this turn. ${reason}`),
    });
    if (turn.readOnly) return off('Review and advice turns read only.');
    const unrouted = OFF_NOTE[turn.family];
    if (unrouted) return off(unrouted);
    // Google reports a call by its kind and title, so CrewKite cannot tell a server's call from
    // its own. The servers join only where every call asks: the ask policy, with no kind granted.
    if (
      turn.family === 'google' &&
      (turn.permissionPolicy !== 'ask' || (turn.permissionGrants?.length ?? 0) > 0)
    )
      return off(GOOGLE_NOTE);
    return {
      servers: on.map((server) => ({
        name: server.name,
        command: server.command,
        args: [...server.args, ...server.secretArgs],
        env: server.env,
        policy:
          turn.family === 'google'
            ? 'ask'
            : ceiling(chosen[server.name] as McpPolicy, turn.permissionPolicy),
        readTools: server.readTools,
      })),
      notes: [],
      secrets: on.flatMap(mcpSecrets),
    };
  }
}

/** The Anthropic client's `--mcp-config` entries for the servers of a turn. */
export const anthropicMcpEntries = (mcp: ThreadMcp | undefined) =>
  Object.fromEntries(
    (mcp?.servers ?? []).map((server) => [
      server.name,
      {
        type: 'stdio',
        command: server.command,
        args: [...server.args],
        ...(Object.keys(server.env).length ? { env: { ...server.env } } : {}),
      },
    ]),
  );

/** The Google client's `session/new` entries for the servers of a turn. */
export const googleMcpEntries = (mcp: ThreadMcp | undefined) =>
  (mcp?.servers ?? []).map((server) => ({
    name: server.name,
    command: server.command,
    args: [...server.args],
    env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
  }));
