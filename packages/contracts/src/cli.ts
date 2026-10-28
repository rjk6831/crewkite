import { z } from 'zod';
import {
  AgentEventSchema,
  ChatCrewRoleSchema,
  ChatFailureSchema,
  ChatFamilySchema,
  ChatMessageSchema,
  ChatModelSelectionSchema,
  ChatPermissionPolicySchema,
  ChatSavedHandoffModeSchema,
  ChatThreadReadSchema,
  ChatThreadSchema,
  ChatTurnIdSchema,
  ChatTurnSchema,
} from './chat.ts';

// The lines `crewkite thread ... --json` and `crewkite -p ... --json` write, one JSON object per
// line. A script reads `kind` first. `v` names one fixed shape of every line, the chat shapes it
// embeds included: CLI_JSON_LINE_SHAPE pins the hash of that shape, and a change to any of them
// fails the CLI's schema test until `v` and the hash move together. The lines describe what the
// controller said; none of them is an instruction to it.

const cursor = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const taskId = z.string().regex(/^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const line = { v: z.literal(1) };

/** One stream event of one thread. A stored message arrives as a `message`. */
export const CliThreadEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('agent.event'), cursor, payload: AgentEventSchema }),
  z.strictObject({ type: z.literal('chat.turn'), cursor, payload: ChatTurnSchema }),
  z.strictObject({ type: z.literal('chat.thread'), cursor, payload: ChatThreadSchema }),
  z.strictObject({ type: z.literal('message'), cursor, payload: ChatMessageSchema }),
]);
export type CliThreadEvent = z.infer<typeof CliThreadEventSchema>;

export const CliJsonLineSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...line, kind: z.literal('event'), taskId, event: CliThreadEventSchema }),
  /** What the controller answered to one command, with its own reason and next step. */
  z.strictObject({
    ...line,
    kind: z.literal('result'),
    command: z.string().min(1).max(100),
    outcome: z.string().min(1).max(100),
    reason: z.string().max(4096).nullable(),
    next: z.string().max(4096).nullable(),
    taskId: taskId.nullable(),
    data: z.unknown().optional(),
  }),
  /** A turn the command watched has ended. Print mode exits with this status. */
  z.strictObject({
    ...line,
    kind: z.literal('turn-end'),
    taskId,
    turnId: ChatTurnIdSchema,
    status: z.enum(['done', 'stopped', 'failed']),
    failure: ChatFailureSchema.nullable(),
  }),
  z.strictObject({ ...line, kind: z.literal('thread'), read: ChatThreadReadSchema }),
  z.strictObject({
    ...line,
    kind: z.literal('threads'),
    threads: z
      .array(
        z.strictObject({
          taskId,
          projectId: z.string().min(1).max(64),
          title: z.string().min(1).max(200),
          activity: z.enum(['idle', 'running', 'waiting', 'failed']),
        }),
      )
      .max(100_000),
    complete: z.boolean(),
  }),
  z.strictObject({ ...line, kind: z.literal('error'), message: z.string().min(1).max(4096) }),
]);
export type CliJsonLine = z.infer<typeof CliJsonLineSchema>;

/** The `v` of every line, and the hash of the shape it names. Change them together. */
export const CLI_JSON_LINE_VERSION = 1;
export const CLI_JSON_LINE_SHAPE =
  '812f00297f6c6db0a183134fcd580ae785d31f59f083ef91ccb782093598ecfa';

/**
 * Exit codes of every CLI command. 0: the request applied, or the followed turn finished. 1: it
 * failed while running: an error, a failed read, a lost connection, or a followed turn that failed.
 * 2: nothing was done: arguments that do not parse or that the command rejects, or a request the
 * controller refused, with its reason printed. 3: the followed turn was stopped.
 */
export const CLI_EXIT = { done: 0, failed: 1, notDone: 2, stopped: 3 } as const;

/** What a key binding can do in the interactive CLI. */
export const CliKeyActionSchema = z.enum([
  'send',
  'newline',
  'stop',
  'threads',
  'changes',
  'settings',
  'help',
]);
export type CliKeyAction = z.infer<typeof CliKeyActionSchema>;
/** A key as the CLI names it: modifiers, then one key, such as `ctrl+t` or `alt+enter`. */
export const CliKeySchema = z
  .string()
  .regex(
    /^(?:(?:ctrl|alt|shift)\+){0,3}(?:enter|escape|tab|up|down|left|right|pageup|pagedown|home|end|[a-z0-9])$/,
  );

/**
 * `~/.crewkite/cli.json`, the CLI's own settings. The thread defaults use the schemas the desktop
 * saves its defaults with, so a model, a permission policy or a handoff mode reads the same in
 * both. Nothing here grants a permission or raises a limit: the controller checks each value
 * again when a command carries it.
 */
export const CliSettingsSchema = z.strictObject({
  theme: z.enum(['system', 'dark', 'light']).default('system'),
  /** full draws the kite spinner. reduced and off keep it still, as reduced motion does. */
  animation: z.enum(['full', 'reduced', 'off']).default('full'),
  keybindings: z.partialRecord(CliKeyActionSchema, z.array(CliKeySchema).min(1).max(4)).default({}),
  /** The provider and model a new thread starts on. Null lets the CLI pick a connected one. */
  selection: ChatModelSelectionSchema.nullable().default(null),
  /**
   * The policy the interactive mode offers for a new thread. It applies only after the person
   * confirms it for that thread; a new thread starts on the controller's default, ask each time.
   */
  permissionPolicy: ChatPermissionPolicySchema.default('ask'),
  handoffMode: ChatSavedHandoffModeSchema.default('most-left'),
  /** A family's default model, as the provider cards in Settings save it. */
  familyModels: z.partialRecord(ChatFamilySchema, z.string().min(1).max(200)).default({}),
  /** Crew presets keep only the roles pinned to a model, keyed by preset name. */
  crewPresets: z
    .record(
      z.string().min(1).max(60),
      z.partialRecord(ChatCrewRoleSchema, ChatModelSelectionSchema),
    )
    .default({}),
});
export type CliSettings = z.infer<typeof CliSettingsSchema>;
