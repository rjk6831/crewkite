import { z } from 'zod';

// Writing rules: the ordered simplicity ladder and the token-saving rules a writing turn receives.
// The controller owns this catalogue and the person's switches, so the desktop and the command
// line apply the same set. A rule is text for the model. It grants nothing, and permission,
// validation and safety obligations are never among the switches.

const projectId = z.string().regex(/^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();

/** Bumped when a rule is added, removed or reordered. A rule's own text change bumps its version. */
export const WRITING_RULES_CATALOGUE_VERSION = 1;

export type WritingRule = Readonly<{
  id: string;
  version: number;
  /** Settings lists the rule. An export-only rule appears only in a written export. */
  surface: 'settings' | 'export-only';
  defaultEnabled: boolean;
  text: string;
}>;

const rule = (
  id: string,
  surface: WritingRule['surface'],
  defaultEnabled: boolean,
  text: string,
): WritingRule => Object.freeze({ id, version: 1, surface, defaultEnabled, text });

/** In the order a turn and an export list them. The ladder comes first. */
export const WRITING_RULES: readonly WritingRule[] = Object.freeze([
  rule(
    'ladder',
    'settings',
    true,
    'Ask whether the work needs to exist. Then prefer an existing helper, the standard library, the platform or an installed dependency before new code. Validation, error handling that prevents data loss, security and accessibility are never skipped.',
  ),
  rule(
    'search-first',
    'settings',
    true,
    'Search before reading. Read the needed sections and enough surrounding code to understand the contract. Read a whole file when correctness or the task requires it.',
  ),
  rule(
    'survey-delegation',
    'settings',
    false,
    'Use a subagent for a broad survey only when delegation is allowed and useful. Return a concise summary with source locations.',
  ),
  rule(
    'response-contents',
    'settings',
    true,
    'Summarize which files changed and why. Avoid pasting complete files or diffs unless requested or needed to explain a failure.',
  ),
  rule(
    'settled-decisions',
    'settings',
    true,
    'Do not repeat settled decisions. State any new evidence or conflict that changes them.',
  ),
  rule(
    'session-switch',
    'export-only',
    false,
    'At a task switch, preserve a short handoff and suggest a fresh session when the old context is no longer useful. Use compaction only when the host supports it.',
  ),
  rule(
    'concise-replies',
    'settings',
    true,
    'Keep replies short while retaining failure evidence, required Findings counts and material safety information.',
  ),
  rule(
    'testing',
    'settings',
    true,
    'Use the narrowest checks that protect the change while working. Run the required integrated suite at task completion when authorized.',
  ),
  rule(
    'rereads',
    'settings',
    true,
    'Reuse material already read while it remains available and unchanged. Reread when it changed, was truncated, lost from context or needs verification.',
  ),
  rule(
    'bounded-output',
    'settings',
    true,
    'Bound routine command output. Preserve exit status and enough failure output to diagnose the result.',
  ),
  rule(
    'stop-at-scope',
    'settings',
    true,
    'Stop when the request and required validation are complete. Do not add unrequested refactors, files or tests. Disclose unresolved failures.',
  ),
  rule(
    'independent-calls',
    'settings',
    true,
    'Batch independent reads or tool calls when their ordering does not matter. Keep dependent actions, approvals and conflicting writes sequential.',
  ),
]);

const ruleIds = WRITING_RULES.map((entry) => entry.id) as [string, ...string[]];
export const WritingRuleIdSchema = z.enum(ruleIds);
export type WritingRuleId = z.infer<typeof WritingRuleIdSchema>;

/**
 * The rule set one writing turn received. `enabled` lists rule IDs in catalogue order and
 * `digest` is `writingRuleDigest(enabled)`, which the controller computes and records. A set keeps
 * the catalogue version and IDs it was made with, so a turn saved under an older catalogue still
 * reads.
 */
export const WritingRuleSetSchema = z.strictObject({
  catalogueVersion: z.number().int().min(1),
  enabled: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
    .max(64)
    .refine((ids) => new Set(ids).size === ids.length, 'A rule set lists each rule once.'),
  digest: hash,
});
export type WritingRuleSet = z.infer<typeof WritingRuleSetSchema>;

/** One switch the person set. A rule with no entry takes its catalogue default. */
export const WritingRulePreferenceSchema = z.strictObject({
  ruleId: WritingRuleIdSchema,
  enabled: z.boolean(),
  updatedAt: timestamp,
});
export type WritingRulePreference = z.infer<typeof WritingRulePreferenceSchema>;
export const WritingRulePreferencesSchema = z
  .array(WritingRulePreferenceSchema)
  .max(WRITING_RULES.length)
  .refine(
    (rows) => new Set(rows.map((row) => row.ruleId)).size === rows.length,
    'Each rule has at most one switch.',
  );
export type WritingRulePreferences = z.infer<typeof WritingRulePreferencesSchema>;

export const ReadWritingRulesPayloadSchema = z.strictObject({});
export const SetWritingRulePayloadSchema = z.strictObject({
  ruleId: WritingRuleIdSchema,
  enabled: z.boolean(),
});

export const WritingRulesReadSchema = z.strictObject({
  /** Every catalogue rule in catalogue order, with the switch that applies now. */
  rules: z
    .array(
      z.strictObject({
        id: WritingRuleIdSchema,
        enabled: z.boolean(),
        surface: z.enum(['settings', 'export-only']),
        text: z.string().min(1).max(1000),
        version: z.number().int().min(1),
      }),
    )
    .max(WRITING_RULES.length),
  /** The digest of the set the next writing turn receives. */
  digest: hash,
});
export type WritingRulesRead = z.infer<typeof WritingRulesReadSchema>;

/** The most bytes an export preview carries. The written file is exactly this text. */
export const WRITING_RULES_EXPORT_BYTES = 64 * 1024;

/** A path inside the project: relative, forward slashes, no empty, `.`, `..` or `.git` part. */
const projectPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      path.isWellFormed() &&
      !/\p{Cc}/u.test(path) &&
      !path.startsWith('/') &&
      !/^[a-z]:/i.test(path) &&
      !path.includes('\\') &&
      !path
        .split('/')
        .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'),
    'A destination is a relative path inside the project.',
  );

/**
 * What an export would write, shown before anything is written. `new-file` creates the
 * destination; `patch` adds the rules to a file that exists. `destinationIdentity` is the file as
 * the preview read it, so a write refuses when the file changed since.
 */
export const WritingRulesExportSchema = z.strictObject({
  destination: projectPath,
  mode: z.enum(['new-file', 'patch']),
  preview: z
    .string()
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= WRITING_RULES_EXPORT_BYTES,
      'An export preview stays within its byte bound.',
    ),
  /**
   * hashCanonical over the destination, the mode, the preview text and the rule digest. A changed
   * rule set, file or mode needs a new preview.
   */
  previewHash: hash,
  destinationIdentity: z
    .strictObject({ exists: z.boolean(), sha256: hash.nullable() })
    .refine(
      (identity) => identity.exists === (identity.sha256 !== null),
      'A destination that exists has a digest, and one that does not has none.',
    ),
});
export type WritingRulesExport = z.infer<typeof WritingRulesExportSchema>;

/** Builds the export preview for a destination. It writes nothing. */
export const PreviewWritingRulesExportPayloadSchema = z.strictObject({
  projectId,
  destination: projectPath,
});

/** Writes the previewed text. A different preview hash or a changed destination refuses it. */
export const ExportWritingRulesPayloadSchema = z.strictObject({
  projectId,
  destination: projectPath,
  previewHash: hash,
  /** The destination's sha256 as the preview read it. Null when the file did not exist. */
  expectedDestination: hash.nullable(),
  confirm: z.literal('explicit'),
});
