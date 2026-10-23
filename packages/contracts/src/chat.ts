import { z } from 'zod';

// Shared shape of a chat thread, its turns and the live agent stream.
// Every provider adapter translates its native protocol into these events.
// The renderer knows these events and nothing provider-specific.

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`));
const text = z.string().max(65_536);
const short = z.string().min(1).max(200);
const timestamp = z.iso.datetime();

export const ChatTurnIdSchema = id('trn');
export const ChatFamilySchema = z.enum(['openai', 'anthropic', 'google', 'local']);
export const ChatRoleSchema = z.enum(['assistant', 'reviewer', 'advisor']);
export const ChatEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'default']);

/** The person's selection for the next turn. The controller validates it against the catalog. */
export const ChatModelSelectionSchema = z.strictObject({
  family: ChatFamilySchema,
  model: short,
  effort: ChatEffortSchema.default('default'),
});
export type ChatModelSelection = z.infer<typeof ChatModelSelectionSchema>;

export const ChatToolKindSchema = z.enum(['read', 'search', 'edit', 'command', 'other']);

export const ChatPermissionOptionSchema = z.strictObject({
  id: short,
  label: short,
  kind: z.enum(['allow-once', 'allow-thread', 'deny']),
});
export type ChatPermissionOption = z.infer<typeof ChatPermissionOptionSchema>;

/** Why a turn ended early. Rendered in the thread as a plain sentence with a next action. */
export const ChatFailureSchema = z.strictObject({
  stage: z.enum(['launch', 'session', 'prompt', 'stream', 'tool', 'permission', 'finish']),
  kind: z.enum([
    'client-missing',
    'client-exit',
    'signed-out',
    'usage-limit',
    'model-unavailable',
    'protocol',
    'timeout',
    'stopped',
    'internal',
  ]),
  message: z.string().min(1).max(4096),
  providerMessage: z.string().max(16_384).nullable().default(null),
  method: short.nullable().default(null),
  code: z.number().int().nullable().default(null),
  resetsAt: timestamp.nullable().default(null),
  nextAction: z.string().min(1).max(1024),
});
export type ChatFailure = z.infer<typeof ChatFailureSchema>;

export const ChatFileDiffSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().max(262_144).nullable().default(null),
});

const turnRef = { turnId: ChatTurnIdSchema };

/** One normalized event from a running agent turn. Order inside a turn is the order emitted. */
export const AgentEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('turn.started'),
    ...turnRef,
    family: ChatFamilySchema,
    model: short,
    effort: ChatEffortSchema,
    role: ChatRoleSchema,
  }),
  z.strictObject({ type: z.literal('text.delta'), ...turnRef, itemId: short, text }),
  z.strictObject({ type: z.literal('text.completed'), ...turnRef, itemId: short, text }),
  z.strictObject({ type: z.literal('thinking.delta'), ...turnRef, itemId: short, text }),
  z.strictObject({ type: z.literal('thinking.completed'), ...turnRef, itemId: short }),
  z.strictObject({
    type: z.literal('tool.started'),
    ...turnRef,
    callId: short,
    kind: ChatToolKindSchema,
    title: z.string().min(1).max(1024),
    input: z.unknown().optional(),
  }),
  z.strictObject({
    type: z.literal('tool.output'),
    ...turnRef,
    callId: short,
    chunk: text,
    truncated: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('tool.completed'),
    ...turnRef,
    callId: short,
    status: z.enum(['ok', 'error', 'denied']),
    diff: ChatFileDiffSchema.optional(),
    summary: z.string().max(4096).optional(),
  }),
  z.strictObject({
    type: z.literal('permission.requested'),
    ...turnRef,
    requestId: short,
    callId: short.nullable().default(null),
    question: z.string().min(1).max(4096),
    detail: z.string().max(16_384).nullable().default(null),
    options: z.array(ChatPermissionOptionSchema).min(1).max(6),
  }),
  z.strictObject({
    type: z.literal('permission.resolved'),
    ...turnRef,
    requestId: short,
    choice: short,
  }),
  z.strictObject({
    type: z.literal('usage.context'),
    ...turnRef,
    usedTokens: z.number().int().nonnegative(),
    capacityTokens: z.number().int().positive().nullable(),
  }),
  z.strictObject({
    type: z.literal('provider.notice'),
    ...turnRef,
    level: z.enum(['info', 'warning']),
    message: z.string().min(1).max(4096),
  }),
  z.strictObject({
    type: z.literal('turn.completed'),
    ...turnRef,
    stopReason: z.enum(['done', 'stopped', 'limit', 'error']),
    failure: ChatFailureSchema.nullable().default(null),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const ChatTurnStateSchema = z.enum([
  'queued',
  'running',
  'waiting-permission',
  'done',
  'stopped',
  'failed',
]);

/** Durable record of one turn. Lives beside the task; the live stream is in the event log. */
export const ChatTurnSchema = z.strictObject({
  id: ChatTurnIdSchema,
  taskId: id('tsk'),
  sequence: z.number().int().nonnegative(),
  role: ChatRoleSchema,
  selection: ChatModelSelectionSchema,
  userMessageId: id('msg'),
  assistantMessageId: id('msg').nullable(),
  state: ChatTurnStateSchema,
  startedAt: timestamp,
  endedAt: timestamp.nullable(),
  failure: ChatFailureSchema.nullable(),
  handoffFrom: ChatFamilySchema.nullable().default(null),
});
export type ChatTurn = z.infer<typeof ChatTurnSchema>;

/** Per-provider session identity kept on the task so a later turn can resume. */
export const ChatSessionSchema = z.strictObject({
  family: ChatFamilySchema,
  sessionId: z.string().min(1).max(512),
  model: short,
  updatedAt: timestamp,
});
export type ChatSession = z.infer<typeof ChatSessionSchema>;

export const ChatPermissionPolicySchema = z.enum(['ask', 'allow-edits', 'allow-all']);

export const ChatThreadSchema = z.strictObject({
  taskId: id('tsk'),
  scratchReady: z.boolean(),
  base: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  selection: ChatModelSelectionSchema.nullable(),
  permissionPolicy: ChatPermissionPolicySchema.default('ask'),
  sessions: z.array(ChatSessionSchema).max(8).default([]),
  activeTurnId: ChatTurnIdSchema.nullable().default(null),
  autoHandoff: z.boolean().default(false),
});
export type ChatThread = z.infer<typeof ChatThreadSchema>;

// Command payloads. Lane A wires these into CommandSchema in index.ts.
export const SendChatMessagePayloadSchema = z.strictObject({
  taskId: id('tsk'),
  text: z.string().min(1).max(65_536),
  selection: ChatModelSelectionSchema.optional(),
  role: ChatRoleSchema.default('assistant'),
  attachments: z.array(z.string().min(1).max(4096)).max(32).default([]),
});
export const ResolveChatPermissionPayloadSchema = z.strictObject({
  taskId: id('tsk'),
  turnId: ChatTurnIdSchema,
  requestId: short,
  choice: short,
});
export const StopChatTurnPayloadSchema = z.strictObject({
  taskId: id('tsk'),
  turnId: ChatTurnIdSchema,
});
export const ConfigureChatThreadPayloadSchema = z.strictObject({
  taskId: id('tsk'),
  selection: ChatModelSelectionSchema.optional(),
  permissionPolicy: ChatPermissionPolicySchema.optional(),
  autoHandoff: z.boolean().optional(),
});
export const HandoffChatThreadPayloadSchema = z.strictObject({
  taskId: id('tsk'),
  selection: ChatModelSelectionSchema,
  reason: z.enum(['manual', 'limit']).default('manual'),
});
export type ChatFamily = z.infer<typeof ChatFamilySchema>;
export type ChatRole = z.infer<typeof ChatRoleSchema>;
export type ChatEffort = z.infer<typeof ChatEffortSchema>;
export type ChatPermissionPolicy = z.infer<typeof ChatPermissionPolicySchema>;
export type ChatTurnState = z.infer<typeof ChatTurnStateSchema>;
export type ChatToolKind = z.infer<typeof ChatToolKindSchema>;

// Read shapes. The thread view loads one of these, then applies live events on top.
export const ChatMessageSchema = z.strictObject({
  id: id('msg'),
  taskId: id('tsk'),
  at: timestamp,
  cursor: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  author: z.union([
    z.strictObject({ kind: z.literal('user') }),
    z.strictObject({
      kind: z.literal('assistant'),
      turnId: ChatTurnIdSchema,
      family: ChatFamilySchema,
      model: short,
      role: ChatRoleSchema,
    }),
    z.strictObject({ kind: z.literal('system'), turnId: ChatTurnIdSchema.nullable() }),
  ]),
  text: z.string().max(262_144),
  attachments: z.array(z.string().min(1).max(4096)).max(32).default([]),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatThreadReadSchema = z.strictObject({
  thread: ChatThreadSchema,
  turns: z.array(ChatTurnSchema).max(500),
  messages: z.array(ChatMessageSchema).max(1000),
  /** Events of turns that have not finished, oldest first, so a reopened view can rebuild them. */
  liveEvents: z.array(AgentEventSchema).max(5000),
});
export type ChatThreadRead = z.infer<typeof ChatThreadReadSchema>;

export const ChatChangesReadSchema = z.strictObject({
  taskId: id('tsk'),
  base: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  files: z.array(ChatFileDiffSchema).max(2000),
});
export type ChatChangesRead = z.infer<typeof ChatChangesReadSchema>;

export const ChatCatalogEntrySchema = z.strictObject({
  family: ChatFamilySchema,
  connected: z.boolean(),
  reason: z.string().max(1024).nullable().default(null),
  models: z
    .array(
      z.strictObject({
        model: short,
        label: short,
        efforts: z.array(ChatEffortSchema).max(8),
        defaultEffort: ChatEffortSchema,
      }),
    )
    .max(64),
  defaultModel: short.nullable().default(null),
  remaining: z
    .array(
      z.strictObject({
        windowId: short,
        label: short,
        percent: z.number().min(0).max(100).nullable(),
        resetsAt: timestamp.nullable(),
        observedAt: timestamp.nullable(),
      }),
    )
    .max(8)
    .default([]),
});
export const ChatCatalogReadSchema = z.strictObject({
  families: z.array(ChatCatalogEntrySchema).max(4),
});
export type ChatCatalogRead = z.infer<typeof ChatCatalogReadSchema>;

export const ReadChatThreadPayloadSchema = z.strictObject({
  taskId: id('tsk'),
  beforeCursor: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,19})$/)
    .optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export const ReadChatChangesPayloadSchema = z.strictObject({ taskId: id('tsk') });
export const ReadChatCatalogPayloadSchema = z.strictObject({ taskId: id('tsk').optional() });
