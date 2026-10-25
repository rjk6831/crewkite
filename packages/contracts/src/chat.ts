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
// A reviewer reads the changes. An advisor gives a second opinion on the last answer. A
// challenger argues against the assumptions the last answer rests on. Those three read only. A
// fixer is the builder again, run with a review's findings, and writes like the assistant.
export const ChatRoleSchema = z.enum(['assistant', 'reviewer', 'advisor', 'challenger', 'fixer']);
/** Roles whose turns edit the scratch copy. Every other role runs read only. */
export const writesScratch = (role: z.infer<typeof ChatRoleSchema>) =>
  role === 'assistant' || role === 'fixer';
// The clients name their own levels. OpenAI offers up to ultra on some models, Anthropic up to max.
export const ChatEffortSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'ultra',
  'max',
  'default',
]);
/**
 * How the thread picks the next family when a limit stops a turn and automatic handoff is on.
 * most-left takes the family with the most allowance left. resets-first spends the allowance that
 * resets soonest while it lasts. balanced ranks by allowance left per hour until reset, so every
 * window is spent at the rate it can afford. local-first takes Local while it is connected, then
 * ranks the rest as balanced.
 */
export const ChatHandoffModeSchema = z.enum([
  'most-left',
  'resets-first',
  'balanced',
  'local-first',
]);
export type ChatHandoffMode = z.infer<typeof ChatHandoffModeSchema>;

/** The person's selection for the next turn. The controller validates it against the catalog. */
export const ChatModelSelectionSchema = z.strictObject({
  family: ChatFamilySchema,
  model: short,
  effort: ChatEffortSchema.default('default'),
});
export type ChatModelSelection = z.infer<typeof ChatModelSelectionSchema>;

/**
 * Who runs each step of the chain after a builder turn. The builder answers the person, the
 * reviewer reads the changes, the fixer is the builder again with the findings, and the challenger
 * argues against the assumptions. Builder is required; a crew without a reviewer has no chain.
 */
export const ChatCrewRoleSchema = z.enum(['builder', 'reviewer', 'challenger', 'fixer']);
export type ChatCrewRole = z.infer<typeof ChatCrewRoleSchema>;
export const ChatCrewSchema = z
  .strictObject({
    name: z.string().min(1).max(60),
    members: z
      .array(z.strictObject({ role: ChatCrewRoleSchema, selection: ChatModelSelectionSchema }))
      .min(1)
      .max(4),
  })
  .refine(
    (crew) => new Set(crew.members.map((member) => member.role)).size === crew.members.length,
    'A crew names each role at most once.',
  )
  .refine(
    (crew) => crew.members.some((member) => member.role === 'builder'),
    'A crew needs a builder.',
  );
export type ChatCrew = z.infer<typeof ChatCrewSchema>;

/**
 * How far the crew runs on its own. manual runs nothing after a builder turn. balanced runs the
 * chain and asks before risky actions. glide runs the chain to the end and stops only on a
 * failure, or on a permission the policy does not cover. Entering glide turns automatic handoff
 * on, so a usage limit moves the step to the next family.
 */
export const ChatFlightModeSchema = z.enum(['manual', 'balanced', 'glide']);
export type ChatFlightMode = z.infer<typeof ChatFlightModeSchema>;

/** Where the crew chain stands after the builder turn it follows. One chain runs at a time. */
export const ChatCrewChainSchema = z.strictObject({
  /** The builder turn the chain follows. */
  builderTurnId: ChatTurnIdSchema,
  step: z.enum(['review', 'fix', 'challenge', 'finished', 'stopped']),
  reviewRounds: z.number().int().min(0).max(3),
  fixes: z.number().int().min(0).max(2),
  /** Why the chain stopped early, in words for the person. Null while it runs or once it finishes. */
  reason: z.string().min(1).max(400).nullable().default(null),
});
export type ChatCrewChain = z.infer<typeof ChatCrewChainSchema>;

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
  /** What the client wrote before it failed: the last lines of its error output or frames. */
  detail: z.string().max(4096).optional(),
});
export type ChatFailure = z.infer<typeof ChatFailureSchema>;

export const ChatFileDiffSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().max(262_144).nullable().default(null),
});

const turnRef = { turnId: ChatTurnIdSchema };

/** Measured cost of one turn. Null where the runtime did not report the value. */
export const ChatTurnStatsSchema = z.strictObject({
  tokensIn: z.number().int().nonnegative().nullable(),
  tokensOut: z.number().int().nonnegative().nullable(),
  tokensPerSecond: z.number().nonnegative().finite().nullable(),
  firstTokenMs: z.number().int().nonnegative().nullable(),
  turnMs: z.number().int().nonnegative(),
  contextUsed: z.number().int().nonnegative().nullable(),
  contextCapacity: z.number().int().positive().nullable(),
  /** Rolling summaries the prompt carried, counting one written during this turn. */
  summaries: z.number().int().min(0).max(10_000),
});
export type ChatTurnStats = z.infer<typeof ChatTurnStatsSchema>;

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
    /** The client said the change deletes or moves a file. Balanced sends these to the person. */
    deletes: z.literal(true).optional(),
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
  // The adapter's own measure of the turn. Local reports it every turn; others may not.
  z.strictObject({ type: z.literal('turn.stats'), ...turnRef, stats: ChatTurnStatsSchema }),
  // The adapter folded earlier turns into a rolling summary to fit the model's context.
  z.strictObject({
    type: z.literal('context.compacted'),
    ...turnRef,
    summaries: z.number().int().min(1).max(10_000),
    coveredTurns: z.number().int().min(1).max(100_000),
    usedTokens: z.number().int().nonnegative(),
    capacityTokens: z.number().int().positive(),
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
  /** Set when the turn settles. A reopened view uses it where live events are gone. */
  stopReason: z.enum(['done', 'stopped', 'limit', 'error']).nullable().optional(),
  /** Process groups of the turn not yet proven gone. The next command and startup check again. */
  groups: z.array(z.number().int().positive()).max(64).optional(),
  /** The last turn.stats the adapter reported. */
  stats: ChatTurnStatsSchema.optional(),
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

/** A message waiting for the running turn to finish. The composer can still take it back. */
export const ChatQueuedMessageSchema = z.strictObject({
  id: id('msg'),
  at: timestamp,
  text: z.string().min(1).max(65_536),
  role: ChatRoleSchema.default('assistant'),
  selection: ChatModelSelectionSchema.optional(),
  attachments: z.array(z.string().min(1).max(4096)).max(32).default([]),
});
export type ChatQueuedMessage = z.infer<typeof ChatQueuedMessageSchema>;

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
  handoffMode: ChatHandoffModeSchema.default('most-left'),
  /**
   * Messages sent while a turn was running, oldest first. Each starts its own turn, in order,
   * once the thread is free. Stopping the running turn clears them.
   */
  queued: z.array(ChatQueuedMessageSchema).max(8).default([]),
  /** The crew the thread runs and how far it runs on its own. A thread with no crew is manual. */
  crew: ChatCrewSchema.nullable().default(null),
  flightMode: ChatFlightModeSchema.default('manual'),
  /** The chain after the last builder turn. Null when no chain has run in this thread. */
  crewChain: ChatCrewChainSchema.nullable().default(null),
  /** Tool kinds the person allowed for the whole thread. Adapters answer these without asking. */
  permissionGrants: z.array(ChatToolKindSchema).max(8).optional(),
  /**
   * A provider process outlived its turn. No turn runs and nothing is accepted until a later
   * check, on the next command or at startup, finds every recorded process group gone.
   */
  ownershipUnknown: z.boolean().optional(),
  /** The last branch acceptance from this thread's scratch copy. */
  lastAcceptance: z
    .strictObject({
      branch: z.string().min(1).max(200),
      at: timestamp,
      fileCount: z.number().int().nonnegative(),
      commit: z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .nullable()
        .default(null),
    })
    .nullable()
    .optional(),
  /** The last push of an accepted branch, made by the person's click with their git credentials. */
  lastPush: z
    .strictObject({
      branch: z.string().min(1).max(200),
      remote: z.string().min(1).max(100),
      commit: z.string().regex(/^[a-f0-9]{40}$/),
      at: timestamp,
      /** The pull request opened for the branch, or the compare link the person was given. */
      pullRequestUrl: z.url().max(2048).nullable().default(null),
    })
    .nullable()
    .optional(),
});
export type ChatThread = z.infer<typeof ChatThreadSchema>;

// Command payloads, listed in CommandSchema.
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
  handoffMode: ChatHandoffModeSchema.optional(),
  /** Take a queued message back before it starts. */
  dequeue: id('msg').optional(),
  /** Null clears the crew; the thread goes back to manual. */
  crew: ChatCrewSchema.nullable().optional(),
  flightMode: ChatFlightModeSchema.optional(),
});
/** Stop the running turn cleanly and start a queued message now, with the stopped turn's packet. */
export const SteerChatMessagePayloadSchema = z.strictObject({
  taskId: id('tsk'),
  messageId: id('msg'),
});
export const AcceptChatChangesPayloadSchema = z.strictObject({
  taskId: id('tsk'),
  /** A new local branch name in the form the publication path accepts: lower case, digits, / and -. */
  branch: z
    .string()
    .min(1)
    .max(200)
    .regex(/^(?!.*\/\/)[a-z0-9][a-z0-9/-]*[a-z0-9]$/),
  /** The commit message. The controller writes its own when the person leaves it out. */
  message: z.string().min(1).max(4096).optional(),
});
const branchName = AcceptChatChangesPayloadSchema.shape.branch;
/**
 * Push an accepted branch with the person's own git credentials. Only a person's click sends it,
 * after the confirmation sentence; `confirmed` records that they saw it.
 */
export const PushChatBranchPayloadSchema = z.strictObject({
  taskId: id('tsk'),
  branch: branchName,
  remote: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
    .default('origin'),
  confirmed: z.literal(true),
});
/** Open a pull request for a pushed branch through gh, or hand back the compare link. */
export const OpenChatPullRequestPayloadSchema = z.strictObject({
  taskId: id('tsk'),
  branch: branchName,
  title: z.string().min(1).max(256),
  body: z.string().max(16_384).default(''),
});
export const ReadChatBranchStatusPayloadSchema = z.strictObject({
  taskId: id('tsk'),
  branch: branchName,
});
export const ChatPushResultSchema = z.strictObject({
  branch: branchName,
  remote: z.string().min(1).max(100),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
});
export const ChatPullRequestResultSchema = z.strictObject({
  url: z.url().max(2048),
  /** gh opened the request, or gh is missing and this is the compare link to open by hand. */
  via: z.enum(['gh', 'compare-link']),
});
export const ChatBranchStatusSchema = z.strictObject({
  branch: branchName,
  /** Null when gh is missing or cannot read the repository; the reason says which. */
  runs: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(256),
        status: z.enum(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']),
        conclusion: z.string().min(1).max(64).nullable(),
        url: z.url().max(2048),
        createdAt: timestamp,
      }),
    )
    .max(20)
    .nullable(),
  reason: z.string().min(1).max(400).nullable(),
  readAt: timestamp,
});
export type ChatBranchStatus = z.infer<typeof ChatBranchStatusSchema>;
export const HandoffChatThreadPayloadSchema = z.strictObject({
  taskId: id('tsk'),
  selection: ChatModelSelectionSchema,
  reason: z.enum(['manual', 'limit']).default('manual'),
});
// Only the OpenAI list comes from a separate read. The other families list what their profile or
// setup already holds.
export const RefreshChatModelsPayloadSchema = z.strictObject({ family: z.literal('openai') });

/** Sent when a model read ends, so open pickers read the catalog again. */
export const ChatCatalogChangeSchema = z.strictObject({
  family: z.literal('openai'),
  models: z.number().int().min(0).max(64),
  /** What went wrong, in words for the person. Null when the read stored a list. */
  reason: z.string().min(1).max(400).nullable(),
});
export type ChatCatalogChange = z.infer<typeof ChatCatalogChangeSchema>;
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
      effort: ChatEffortSchema.optional(),
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
  /** The event log cursor this read reflects. A view drops stream events at or below it. */
  cursor: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
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
        /** The client lists it only on request, as with an older model kept for old threads. */
        hidden: z.boolean().optional(),
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
        /** The scope the usage observation reported. Missing when the reader did not say. */
        scope: z.enum(['provider', 'model', 'pool']).optional(),
      }),
    )
    .max(8)
    .default([]),
  /** When the usage reader last received a reading for the family. Null when it never has. */
  readAt: timestamp.nullable().optional(),
  /** The family's client is installed and its usage reads, but chat needs Connect first. */
  needsConnect: z.boolean().optional(),
  /** The last turn's stats on this family, for the rail and the Local card. */
  lastTurnStats: ChatTurnStatsSchema.nullable().optional(),
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

export type ChatCatalogEntry = z.infer<typeof ChatCatalogEntrySchema>;

// Words a window id uses for its length, its slot or its scope. None of them names a model.
const genericWindowTokens = new Set([
  'weekly',
  'daily',
  'monthly',
  'five',
  'seven',
  'hour',
  'day',
  'session',
  'all',
  'scoped',
  'wtu',
  '3p',
  '5h',
  'limit',
  'quota',
  'window',
  'model',
  'primary',
  'secondary',
]);

const windowTokens = (windowId: string) =>
  windowId
    .toLowerCase()
    .split(/[-_:]/)
    .filter((token) => token !== '' && !genericWindowTokens.has(token));

/**
 * Whether a usage window limits a model. A window the reader scoped to the provider or to a shared
 * pool limits every model. Otherwise a window whose id names a model applies only to a model whose
 * id carries every token it names. It takes every token, since an id such as
 * `<vendor>-<model>-weekly` also carries the vendor prefix that every model id of the family
 * shares. A window that names no model applies to every model, and an unknown model counts every
 * window. `reported` lists every window id the family reports. With two or more, tokens all of
 * them carry name the family's own bucket, such as a client name, and never narrow a window. A
 * lone window shares every token with itself, so it names no bucket.
 */
export function windowAppliesTo(
  window: Pick<ChatCatalogEntry['remaining'][number], 'windowId' | 'scope'>,
  model: string | null,
  reported: readonly string[] = [],
): boolean {
  if (model === null || window.scope === 'provider' || window.scope === 'pool') return true;
  const ids = [...new Set(reported)];
  const shared =
    ids.length < 2
      ? []
      : ids
          .map(windowTokens)
          .reduce((common, tokens) => common.filter((token) => tokens.includes(token)));
  const id = model.toLowerCase();
  return windowTokens(window.windowId).every(
    (token) => id.includes(token) || shared.includes(token),
  );
}

/**
 * The tightest window that limits a model: lowest known percent, with its reset time. A window
 * named for another model of the family does not count. Without a model every window counts.
 */
export function tightestAllowance(
  entry: Pick<ChatCatalogEntry, 'remaining'>,
  model: string | null = null,
): {
  percent: number | null;
  resetsAt: string | null;
} {
  const reported = entry.remaining.map((window) => window.windowId);
  const windows = entry.remaining.filter((window) => windowAppliesTo(window, model, reported));
  let tightest: { percent: number; resetsAt: string | null } | null = null;
  for (const window of windows) {
    if (window.percent === null) continue;
    if (!tightest || window.percent < tightest.percent)
      tightest = { percent: window.percent, resetsAt: window.resetsAt };
  }
  return tightest ?? { percent: null, resetsAt: windows[0]?.resetsAt ?? null };
}

/**
 * Families in the order a person would pick them: connected first, then by the thread's mode, on
 * the model each family would run, `modelFor`, which is the catalog default unless the caller
 * tracks another. A family with no known percent ranks after every known one. A family at zero
 * never ranks, since a turn there ends on the limit it already hit. `now` is injected so balanced
 * ranks the same in a test as on the clock.
 */
export function rankFamilies(
  families: readonly ChatCatalogEntry[],
  exclude: readonly ChatCatalogEntry['family'][] = [],
  modelFor: (entry: ChatCatalogEntry) => string | null = (entry) => entry.defaultModel,
  mode: ChatHandoffMode = 'most-left',
  now: number = Date.now(),
): ChatCatalogEntry[] {
  const score = (entry: ChatCatalogEntry) => tightestAllowance(entry, modelFor(entry));
  const reset = (value: string | null) => (value ? Date.parse(value) : Number.POSITIVE_INFINITY);
  // Percent left per hour until reset. A reset closer than fifteen minutes counts as fifteen, so
  // a window about to refill does not outrank everything on a tiny divisor. A window with no
  // reset time spreads over an infinite span and ranks after every timed window.
  const rate = (allowance: { percent: number; resetsAt: string | null }) =>
    allowance.percent / Math.max((reset(allowance.resetsAt) - now) / 3_600_000, 0.25);
  return families
    .filter((entry) => entry.connected && !exclude.includes(entry.family))
    .filter((entry) => score(entry).percent !== 0)
    .sort((left, right) => {
      if (mode === 'local-first' && (left.family === 'local') !== (right.family === 'local'))
        return left.family === 'local' ? -1 : 1;
      const a = score(left);
      const b = score(right);
      // A family with no reading sorts last in every mode. It may be out already.
      if (a.percent === null && b.percent !== null) return 1;
      if (b.percent === null && a.percent !== null) return -1;
      if (
        a.percent !== null &&
        b.percent !== null &&
        (mode === 'balanced' || mode === 'local-first')
      ) {
        const pace =
          rate({ percent: b.percent, resetsAt: b.resetsAt }) -
          rate({ percent: a.percent, resetsAt: a.resetsAt });
        if (pace !== 0) return pace;
      }
      // Allowance that resets soonest is lost soonest, so resets-first spends it while it lasts.
      // A window with no reset time counts as the farthest away.
      if (mode === 'resets-first' && reset(a.resetsAt) !== reset(b.resetsAt))
        return reset(a.resetsAt) - reset(b.resetsAt);
      if (a.percent !== null && b.percent !== null && a.percent !== b.percent)
        return b.percent - a.percent;
      return reset(a.resetsAt) - reset(b.resetsAt);
    });
}
