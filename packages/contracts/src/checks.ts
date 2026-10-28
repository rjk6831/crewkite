import { z } from 'zod';

// Project checks in the chat loop. The controller detects them from the scratch copy, the person
// switches each one, and the crew chain runs the enabled ones. Nothing here carries a command
// line a client could run: a check is shown as text and the controller resolves it again at run.

const timestamp = z.iso.datetime();
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const ChatCheckKindSchema = z.enum(['test', 'lint', 'typecheck', 'custom']);
export const ChatCheckSourceSchema = z.enum([
  'package.json',
  'pyproject.toml',
  'Makefile',
  'Cargo.toml',
  'custom',
]);

/** One check the thread knows. `command` is display text; the controller derives the argv. */
export const ChatCheckSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/),
  label: z.string().min(1).max(80),
  kind: ChatCheckKindSchema,
  source: ChatCheckSourceSchema,
  command: z.string().min(1).max(500),
  enabled: z.boolean(),
});
export type ChatCheck = z.infer<typeof ChatCheckSchema>;

/** Output kept whole in the artifact store. The run only names it. */
export const ChatCheckOutputSchema = z.strictObject({
  id: z.string().regex(/^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  hash,
  bytes: z.number().int().nonnegative(),
});

export const CHECK_TAIL_CHARACTERS = 1000;
export const CHECK_RUNS_KEPT = 9;

export const ChatCheckRunSchema = z.strictObject({
  id: z.string().regex(/^chk_[0-9a-f]{32}$/),
  checkId: ChatCheckSchema.shape.id,
  label: ChatCheckSchema.shape.label,
  command: ChatCheckSchema.shape.command,
  /** What started the run: a fix turn, the last slice of a plan, or a merged copy. */
  trigger: z.enum(['fix', 'plan', 'combined']),
  status: z.enum(['running', 'passed', 'failed', 'stopped']),
  /** Why a run failed or stopped, in words for the person. */
  reason: z.string().min(1).max(300).nullable(),
  startedAt: timestamp,
  durationMs: z.number().int().nonnegative().nullable(),
  exitCode: z.number().int().nullable(),
  /** The newest output, redacted. The whole output is in the artifacts. */
  tail: z.string().max(CHECK_TAIL_CHARACTERS),
  stdout: ChatCheckOutputSchema.nullable(),
  stderr: ChatCheckOutputSchema.nullable(),
});
export type ChatCheckRun = z.infer<typeof ChatCheckRunSchema>;

export const ChatChecksStateSchema = z.strictObject({
  items: z.array(ChatCheckSchema).max(16),
  /** The newest runs, oldest first. */
  runs: z.array(ChatCheckRunSchema).max(CHECK_RUNS_KEPT),
  detectedAt: timestamp.nullable(),
});
export type ChatChecksState = z.infer<typeof ChatChecksStateSchema>;

/** One edit to a thread's checks, sent with ConfigureChatThread. */
export const ChatChecksEditSchema = z.strictObject({
  /** Read the scratch copy again. Detected checks keep their switch; custom ones stay. */
  refresh: z.literal(true).optional(),
  switch: z.strictObject({ id: ChatCheckSchema.shape.id, enabled: z.boolean() }).optional(),
  /** A command to add, as plain words with no shell syntax. */
  add: z.string().min(1).max(500).optional(),
  remove: ChatCheckSchema.shape.id.optional(),
});
export type ChatChecksEdit = z.infer<typeof ChatChecksEditSchema>;
