import type {
  AgentEvent,
  ChatEffort,
  ChatFailure,
  ChatFamily,
  ChatOutputLimit,
  ChatPermissionAnswer,
  ChatPermissionOption,
  ChatRole,
  ChatToolKind,
  ChatTurnStats,
} from '@crewkite/contracts';

// One assistant turn as the thread shows it: text, thinking, tool calls and permission requests in
// the order the provider emitted them. The fold is pure so the reducer can replay it when events
// arrive out of order.

export type FileDiff = NonNullable<Extract<AgentEvent, { type: 'tool.completed' }>['diff']>;
export type ToolStatus = 'running' | 'ok' | 'error' | 'denied' | 'stopped';
export type TurnStatus = 'running' | 'waiting-permission' | 'done' | 'stopped' | 'failed';

export type TextBlock = { kind: 'text'; id: string; text: string; done: boolean };
export type ThinkingBlock = { kind: 'thinking'; id: string; text: string; done: boolean };
/** The subagents a tool call started, as the client last reported them. */
export type SubagentActivity = Omit<
  Extract<AgentEvent, { type: 'tool.subagents' }>,
  'type' | 'turnId' | 'callId'
>;
export type ToolBlock = {
  kind: 'tool';
  id: string;
  toolKind: ChatToolKind;
  title: string;
  input: unknown;
  output: string;
  truncated: boolean;
  status: ToolStatus;
  diff: FileDiff | null;
  summary: string | null;
  subagents: SubagentActivity | null;
  /** Who answered the call's ask when nobody asked the person, such as a thread grant. */
  note?: string;
};
export type PermissionBlock = {
  kind: 'permission';
  id: string;
  requestId: string;
  callId: string | null;
  question: string;
  detail: string | null;
  options: ChatPermissionOption[];
  choice: string | null;
  /** Who answered. Missing means the person. */
  answeredBy?: ChatPermissionAnswer;
  /** Why the ask reached the person although the thread allowed its kind. */
  reason?: string;
};
export type NoticeBlock = {
  kind: 'notice';
  id: string;
  level: 'info' | 'warning';
  message: string;
  /** The client said it about itself. It is not model output and belongs to the turn trace. */
  trace: boolean;
};
/** The adapter folded earlier turns into a rolling summary to fit the model's context. */
export type CompactedBlock = {
  kind: 'compacted';
  id: string;
  summaries: number;
  coveredTurns: number;
  capacity: number;
};
export type Block =
  | TextBlock
  | ThinkingBlock
  | ToolBlock
  | PermissionBlock
  | NoticeBlock
  | CompactedBlock;

export type TurnIdentity = {
  family: ChatFamily;
  model: string;
  effort: ChatEffort;
  role: ChatRole;
  /** The plan slice whose lane opened the turn, from the stored turn. */
  slice?: number;
};

/**
 * The role a turn shows. A read-only plan slice runs in the ask role so every adapter keeps it
 * read only, and it still does a builder's work for its slice, so it reads as the builder.
 */
export const shownRole = (identity: Pick<TurnIdentity, 'role' | 'slice'>): ChatRole =>
  identity.slice !== undefined && identity.role === 'ask' ? 'assistant' : identity.role;

/** The badge a turn's reply shows: the role's, with the slice it ran for. */
export function replyLabel(identity: TurnIdentity | null): string | null {
  if (!identity) return null;
  const role = roleLabels[shownRole(identity)];
  if (identity.slice === undefined) return role;
  return role ? `Slice ${identity.slice} ${role.toLowerCase()}` : `Slice ${identity.slice}`;
}

export type TurnView = {
  id: string;
  identity: TurnIdentity | null;
  status: TurnStatus;
  ended: boolean;
  blocks: Block[];
  context: { used: number; capacity: number | null } | null;
  stats: ChatTurnStats | null;
  /** Set when the reply stopped at its output limit. */
  outputLimit: ChatOutputLimit | null;
  failure: ChatFailure | null;
  /** The thread's line that says why a stopped turn stopped. */
  stopNote?: string;
  /** The brief a plan slice turn ran on. It shows folded under the chip. */
  brief?: string;
};

/** The folded label of a slice turn's brief, such as `Slice 1 brief`. */
export function briefLabel(identity: TurnIdentity | null): string {
  const slice = identity?.slice === undefined ? 'Slice' : `Slice ${identity.slice}`;
  const kind =
    identity?.role === 'reviewer'
      ? 'review brief'
      : identity?.role === 'fixer'
        ? 'fix brief'
        : 'brief';
  return `${slice} ${kind}`;
}

/** The badge a role shows on its reply. The builder's own reply has none. */
export const roleLabels: Record<ChatRole, string | null> = {
  assistant: null,
  reviewer: 'Reviewer',
  advisor: 'Advisor',
  challenger: 'Challenger',
  fixer: 'Fixer',
  orchestrator: 'Orchestrator',
  ask: 'Side question',
};

/**
 * The Markdown a reply was written in: its text blocks in order, as the model wrote them. Copy
 * reply puts this on the clipboard, so a table or a code fence pastes as source and not as the
 * rendered view.
 */
export function replySource(blocks: readonly Block[]): string {
  return blocks
    .flatMap((block) => (block.kind === 'text' && block.text.trim() !== '' ? [block.text] : []))
    .join('\n\n')
    .trim();
}

export const blankTurn = (id: string): TurnView => ({
  id,
  identity: null,
  status: 'running',
  ended: false,
  blocks: [],
  context: null,
  stats: null,
  outputLimit: null,
  failure: null,
});

function put(
  blocks: readonly Block[],
  id: string,
  make: (current: Block | undefined) => Block,
): Block[] {
  const index = blocks.findLastIndex((block) => block.id === id);
  if (index === -1) return [...blocks, make(undefined)];
  return blocks.map((block, position) => (position === index ? make(block) : block));
}

const liveStatus = (blocks: readonly Block[]): TurnStatus =>
  blocks.some((block) => block.kind === 'permission' && block.choice === null)
    ? 'waiting-permission'
    : 'running';

function withBlocks(view: TurnView, blocks: Block[]): TurnView {
  const shown = answeredLines(blocks);
  return { ...view, blocks: shown, status: view.ended ? view.status : liveStatus(shown) };
}

/** An answer nobody asked the person for. A cancelled ask was never answered. */
export const automatic = (block: PermissionBlock) =>
  block.choice !== null &&
  block.choice !== 'cancelled' &&
  block.answeredBy !== undefined &&
  block.answeredBy !== 'person';

/** The one line an automatic answer shows. */
export function answerNote(block: PermissionBlock, toolKind?: ChatToolKind): string {
  if (block.options.find((option) => option.id === block.choice)?.kind === 'deny')
    return 'Declined: this turn only reads';
  if (block.answeredBy === 'thread-grant') return 'Allowed for this thread';
  if (block.answeredBy === 'policy') return 'Allowed by the Permissions policy';
  if (block.answeredBy === 'read-only') return 'Allowed: read-only command in the scratch copy';
  return toolKind === 'command'
    ? 'Allowed: read-only command in the scratch copy'
    : 'Allowed: edit inside the scratch copy';
}

/**
 * An ask CrewKite or the client answered on its own folds into one line on its tool card, so it
 * never looks like a choice the person made. Until the tool card exists the ask keeps its block,
 * which shows the same line. A client may ask before the tool starts, so this runs on every fold.
 */
function answeredLines(blocks: Block[]): Block[] {
  const notes = new Map<string, PermissionBlock>();
  for (const block of blocks)
    if (block.kind === 'permission' && block.callId && automatic(block))
      notes.set(`tool:${block.callId}`, block);
  if (!notes.size) return blocks;
  const tools = new Set(
    blocks.flatMap((block) => (block.kind === 'tool' && notes.has(block.id) ? [block.id] : [])),
  );
  if (!tools.size) return blocks;
  return blocks.flatMap((block): Block[] => {
    if (block.kind === 'permission' && automatic(block) && tools.has(`tool:${block.callId}`))
      return [];
    const asked = block.kind === 'tool' ? notes.get(block.id) : undefined;
    if (block.kind === 'tool' && asked)
      return [{ ...block, note: answerNote(asked, block.toolKind) }];
    return [block];
  });
}

// Adapters report a stop with a failure of kind 'stopped'. A stop is no failure: the turn ends as
// stopped, and the thread's stop line says why.
export const isStop = (failure: ChatFailure | null | undefined) => failure?.kind === 'stopped';

function finish(view: TurnView, event: Extract<AgentEvent, { type: 'turn.completed' }>): TurnView {
  const failure = isStop(event.failure) ? null : event.failure;
  const status: TurnStatus =
    failure || event.stopReason === 'error' || event.stopReason === 'limit'
      ? 'failed'
      : event.stopReason === 'stopped' || isStop(event.failure)
        ? 'stopped'
        : 'done';
  return { ...settle(view, status), failure, outputLimit: event.outputLimit ?? null };
}

/**
 * The turn as it reads once it ended. Nothing in it runs any more, so a tool still marked running
 * shows as stopped. The controller can know a turn ended before or without its completion event,
 * so the thread settles the turn from the stored state too.
 */
export function settle(view: TurnView, status: TurnStatus): TurnView {
  const blocks = view.blocks.map((block): Block => {
    if (block.kind === 'text' || block.kind === 'thinking') return { ...block, done: true };
    if (block.kind === 'tool' && block.status === 'running') return { ...block, status: 'stopped' };
    return block;
  });
  return { ...view, blocks, ended: true, status };
}

/** Two or more finished reads and searches in a row, shown as one line that opens into the cards. */
export type ToolRun = { kind: 'run'; id: string; tools: ToolBlock[] };

// A read or search that finished cleanly has nothing to act on, so a run of them collapses. A
// running card, an edit, a command, a failure and a call that asked first keep their own card.
const routine = (block: ToolBlock, asked: ReadonlySet<string>) =>
  (block.toolKind === 'read' || block.toolKind === 'search') &&
  block.status === 'ok' &&
  block.diff === null &&
  block.note === undefined &&
  !asked.has(block.id);

// A text item with no text yet, and a thinking block that ended with none, such as a redacted one
// or a summary that never came. They draw nothing, so they must not split a run either.
const blank = (block: Block, ended: boolean) =>
  (block.kind === 'text' && block.text === '') ||
  (block.kind === 'thinking' && block.text.trim() === '' && (block.done || ended));

/**
 * The blocks a request already shows, so each request reads as one state. A call that waits on an
 * unanswered request, or that never got an answer before the turn ended, shows through its request
 * card alone: its tool card would add a second running or stopped line for the same command. A
 * request the client asked again for the same call gives way to the newer one while unanswered.
 */
function shownByRequest(blocks: readonly Block[]): Set<string> {
  const hidden = new Set<string>();
  const latest = new Map<string, string>();
  for (const block of blocks)
    if (block.kind === 'permission' && block.callId) latest.set(block.callId, block.id);
  for (const block of blocks) {
    if (block.kind !== 'permission' || !block.callId || block.choice !== null) continue;
    if (latest.get(block.callId) !== block.id) hidden.add(block.id);
    else hidden.add(`tool:${block.callId}`);
  }
  return hidden;
}

/** The blocks of a turn as the thread lays them out. Only the view changes; the turn stays as is. */
export function viewBlocks(blocks: readonly Block[], ended: boolean): (Block | ToolRun)[] {
  const asked = new Set(
    blocks.flatMap((block) =>
      block.kind === 'permission' && block.callId ? [`tool:${block.callId}`] : [],
    ),
  );
  const hidden = shownByRequest(blocks);
  const laid: (Block | ToolRun)[] = [];
  let run: ToolBlock[] = [];
  const close = () => {
    if (run.length > 1) laid.push({ kind: 'run', id: `run:${run[0].id}`, tools: run });
    else laid.push(...run);
    run = [];
  };
  for (const block of blocks) {
    if (blank(block, ended) || hidden.has(block.id)) continue;
    if (block.kind === 'tool' && routine(block, asked)) {
      run.push(block);
      continue;
    }
    close();
    laid.push(block);
  }
  close();
  return laid;
}

export function runLabel(run: ToolRun): string {
  const reads = run.tools.filter((tool) => tool.toolKind === 'read').length;
  const searches = run.tools.length - reads;
  const read = `${reads} ${reads === 1 ? 'file' : 'files'}`;
  const searched = searches === 1 ? 'once' : `${searches} times`;
  if (searches === 0) return `Read ${read}`;
  return reads === 0 ? `Searched ${searched}` : `Read ${read}, searched ${searched}`;
}

export function applyEvent(view: TurnView, event: AgentEvent): TurnView {
  switch (event.type) {
    case 'turn.started':
      return {
        ...view,
        identity: {
          family: event.family,
          model: event.model,
          effort: event.effort,
          role: event.role,
        },
      };
    case 'text.delta':
    case 'text.completed': {
      const done = event.type === 'text.completed';
      const id = `text:${event.itemId}`;
      // The newest block of this item, the item's own or one opened when its id came back.
      const at = view.blocks.findLastIndex(
        (block) => block.id === id || block.id.startsWith(`${id}:`),
      );
      const current = view.blocks[at];
      const own = current?.id ?? id;
      // A text item that already finished takes nothing more in its place. A client that uses
      // the same item id again for a later message gets a new block where the text arrives, so
      // the turn reads in the order it ran. The same completed text again changes nothing.
      if (current?.kind === 'text' && current.done) {
        if (done && current.text === event.text) return view;
        const later = `${id}:${view.blocks.length}`;
        return withBlocks(view, [
          ...view.blocks,
          { kind: 'text', id: later, text: event.text, done },
        ]);
      }
      return withBlocks(
        view,
        put(view.blocks, own, (previous) => ({
          kind: 'text',
          id: own,
          // A completed item carries the whole text, which repairs any delta lost on the way.
          text: done || previous?.kind !== 'text' ? event.text : previous.text + event.text,
          done,
        })),
      );
    }
    case 'thinking.delta':
    case 'thinking.completed': {
      const done = event.type === 'thinking.completed';
      const id = `thinking:${event.itemId}`;
      return withBlocks(
        view,
        put(view.blocks, id, (current) => {
          const text = current?.kind === 'thinking' ? current.text : '';
          return { kind: 'thinking', id, text: done ? text : text + event.text, done };
        }),
      );
    }
    case 'tool.started':
    case 'tool.output':
    case 'tool.subagents':
    case 'tool.completed': {
      const id = `tool:${event.callId}`;
      return withBlocks(
        view,
        put(view.blocks, id, (current) => {
          const tool: ToolBlock =
            current?.kind === 'tool'
              ? current
              : {
                  kind: 'tool',
                  id,
                  toolKind: 'other',
                  title: 'Tool call',
                  input: undefined,
                  output: '',
                  truncated: false,
                  status: 'running',
                  diff: null,
                  summary: null,
                  subagents: null,
                };
          if (event.type === 'tool.started')
            return { ...tool, toolKind: event.kind, title: event.title, input: event.input };
          // Each report is the whole picture for the call, so the newest replaces the last.
          if (event.type === 'tool.subagents')
            return {
              ...tool,
              subagents: { running: event.running, finished: event.finished, agents: event.agents },
            };
          if (event.type === 'tool.output')
            return {
              ...tool,
              output: tool.output + event.chunk,
              truncated: tool.truncated || event.truncated === true,
            };
          return {
            ...tool,
            status: event.status,
            diff: event.diff ?? tool.diff,
            summary: event.summary ?? tool.summary,
          };
        }),
      );
    }
    case 'permission.requested': {
      const id = `permission:${event.requestId}`;
      return withBlocks(
        view,
        put(view.blocks, id, (current) => ({
          kind: 'permission',
          id,
          requestId: event.requestId,
          callId: event.callId,
          question: event.question,
          detail: event.detail,
          options: event.options,
          choice: current?.kind === 'permission' ? current.choice : null,
          ...(current?.kind === 'permission' && current.answeredBy
            ? { answeredBy: current.answeredBy }
            : {}),
          ...(event.reason ? { reason: event.reason } : {}),
        })),
      );
    }
    case 'permission.resolved': {
      const id = `permission:${event.requestId}`;
      return withBlocks(
        view,
        view.blocks.map((block) =>
          block.id === id && block.kind === 'permission'
            ? {
                ...block,
                choice: event.choice,
                ...(event.answeredBy ? { answeredBy: event.answeredBy } : {}),
              }
            : block,
        ),
      );
    }
    case 'usage.context':
      return {
        ...view,
        context: { used: event.usedTokens, capacity: event.capacityTokens },
      };
    case 'provider.notice':
      return withBlocks(view, [
        ...view.blocks,
        {
          kind: 'notice',
          id: `notice:${view.blocks.length}`,
          level: event.level,
          message: event.message,
          trace: event.trace === true,
        },
      ]);
    case 'turn.stats':
      return { ...view, stats: event.stats };
    case 'context.compacted': {
      // One card per summary write. A replayed event lands on the same card.
      const id = `compacted:${event.summaries}`;
      return withBlocks(
        view,
        put(view.blocks, id, () => ({
          kind: 'compacted',
          id,
          summaries: event.summaries,
          coveredTurns: event.coveredTurns,
          capacity: event.capacityTokens,
        })),
      );
    }
    case 'turn.completed':
      return finish(view, event);
  }
}
