import type {
  AgentEvent,
  ChatEffort,
  ChatFailure,
  ChatFamily,
  ChatPermissionOption,
  ChatRole,
  ChatToolKind,
} from '@crewkite/contracts';

// One assistant turn as the thread shows it: text, thinking, tool calls and permission requests in
// the order the provider emitted them. The fold is pure so the reducer can replay it when events
// arrive out of order.

export type FileDiff = NonNullable<Extract<AgentEvent, { type: 'tool.completed' }>['diff']>;
export type ToolStatus = 'running' | 'ok' | 'error' | 'denied' | 'stopped';
export type TurnStatus = 'running' | 'waiting-permission' | 'done' | 'stopped' | 'failed';

export type TextBlock = { kind: 'text'; id: string; text: string; done: boolean };
export type ThinkingBlock = { kind: 'thinking'; id: string; text: string; done: boolean };
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
};
export type NoticeBlock = {
  kind: 'notice';
  id: string;
  level: 'info' | 'warning';
  message: string;
};
export type Block = TextBlock | ThinkingBlock | ToolBlock | PermissionBlock | NoticeBlock;

export type TurnIdentity = {
  family: ChatFamily;
  model: string;
  effort: ChatEffort;
  role: ChatRole;
};

export type TurnView = {
  id: string;
  identity: TurnIdentity | null;
  status: TurnStatus;
  ended: boolean;
  blocks: Block[];
  context: { used: number; capacity: number | null } | null;
  failure: ChatFailure | null;
};

export const blankTurn = (id: string): TurnView => ({
  id,
  identity: null,
  status: 'running',
  ended: false,
  blocks: [],
  context: null,
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
  return { ...view, blocks, status: view.ended ? view.status : liveStatus(blocks) };
}

function finish(view: TurnView, event: Extract<AgentEvent, { type: 'turn.completed' }>): TurnView {
  const status: TurnStatus =
    event.failure || event.stopReason === 'error' || event.stopReason === 'limit'
      ? 'failed'
      : event.stopReason === 'stopped'
        ? 'stopped'
        : 'done';
  const blocks = view.blocks.map((block): Block => {
    if (block.kind === 'text' || block.kind === 'thinking') return { ...block, done: true };
    if (block.kind === 'tool' && block.status === 'running') return { ...block, status: 'stopped' };
    return block;
  });
  return { ...view, blocks, ended: true, status, failure: event.failure };
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
      return withBlocks(
        view,
        put(view.blocks, id, (current) => ({
          kind: 'text',
          id,
          // A completed item carries the whole text, which repairs any delta lost on the way.
          text: done || current?.kind !== 'text' ? event.text : current.text + event.text,
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
                };
          if (event.type === 'tool.started')
            return { ...tool, toolKind: event.kind, title: event.title, input: event.input };
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
        })),
      );
    }
    case 'permission.resolved': {
      const id = `permission:${event.requestId}`;
      return withBlocks(
        view,
        view.blocks.map((block) =>
          block.id === id && block.kind === 'permission'
            ? { ...block, choice: event.choice }
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
        },
      ]);
    case 'turn.completed':
      return finish(view, event);
  }
}
