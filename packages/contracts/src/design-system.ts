import { z } from 'zod';

// A project's design system. The canonical copy is a file in the project at a path the person
// picks, so people and every tool read the same source. The controller records each saved version
// and its hash, delivers the current one to every writing role, and checks changed files against
// its tokens. Tokens follow the W3C design tokens community format where it fits: `$type`,
// `$value` and `$description`, with dimension and duration values as `{ value, unit }`. Colors are
// CSS color strings, which is what every import source already holds.

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) => value.isWellFormed() && !/\p{Cc}/u.test(value),
      'One line of text without control characters.',
    );
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
    'A design system file is a relative path inside the project.',
  );

/** The most bytes a design system takes as JSON. */
export const DESIGN_SYSTEM_BYTES = 256 * 1024;
/** The most tokens one group holds. */
export const MAX_GROUP_TOKENS = 200;
/** The most findings one design check reports. */
export const MAX_DESIGN_FINDINGS = 500;

export const TokenNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const TokenGroupSchema = z.enum(['color', 'type', 'spacing', 'radius', 'shadow', 'motion']);
export type TokenGroup = z.infer<typeof TokenGroupSchema>;
/** A token by group and name, such as `color.accent` or `spacing.md`. */
export const TokenPathSchema = z
  .string()
  .regex(/^(?:color|type|spacing|radius|shadow|motion)\.[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

const description = { $description: line(500).optional() };
const color = line(100);
const dimension = z.strictObject({ value: z.number(), unit: z.enum(['px', 'rem']) });
const shadowLayer = z.strictObject({
  color,
  offsetX: dimension,
  offsetY: dimension,
  blur: dimension,
  spread: dimension,
  inset: z.boolean().optional(),
});
const unit = z.number().min(0).max(1);

const ColorTokenSchema = z.strictObject({
  $type: z.literal('color'),
  $value: color,
  ...description,
});
const DimensionTokenSchema = z.strictObject({
  $type: z.literal('dimension'),
  $value: dimension,
  ...description,
});
const FontFamilyTokenSchema = z.strictObject({
  $type: z.literal('fontFamily'),
  $value: z.union([line(100), z.array(line(100)).min(1).max(20)]),
  ...description,
});
const FontWeightTokenSchema = z.strictObject({
  $type: z.literal('fontWeight'),
  $value: z.union([
    z.number().int().min(1).max(1000),
    z.enum([
      'thin',
      'hairline',
      'extra-light',
      'ultra-light',
      'light',
      'normal',
      'regular',
      'book',
      'medium',
      'semi-bold',
      'demi-bold',
      'bold',
      'extra-bold',
      'ultra-bold',
      'black',
      'heavy',
      'extra-black',
      'ultra-black',
    ]),
  ]),
  ...description,
});
const DurationTokenSchema = z.strictObject({
  $type: z.literal('duration'),
  $value: z.strictObject({ value: z.number().nonnegative(), unit: z.enum(['ms', 's']) }),
  ...description,
});
const CubicBezierTokenSchema = z.strictObject({
  $type: z.literal('cubicBezier'),
  $value: z.tuple([unit, z.number(), unit, z.number()]),
  ...description,
});
const ShadowTokenSchema = z.strictObject({
  $type: z.literal('shadow'),
  $value: z.union([shadowLayer, z.array(shadowLayer).min(1).max(8)]),
  ...description,
});
const NumberTokenSchema = z.strictObject({
  $type: z.literal('number'),
  $value: z.number(),
  ...description,
});

export const TokenSchema = z.discriminatedUnion('$type', [
  ColorTokenSchema,
  DimensionTokenSchema,
  FontFamilyTokenSchema,
  FontWeightTokenSchema,
  DurationTokenSchema,
  CubicBezierTokenSchema,
  ShadowTokenSchema,
  NumberTokenSchema,
]);
export type Token = z.infer<typeof TokenSchema>;

const group = <T extends z.ZodType>(token: T) =>
  z
    .record(TokenNameSchema, token)
    .refine(
      (tokens) => Object.keys(tokens).length <= MAX_GROUP_TOKENS,
      `A group holds at most ${MAX_GROUP_TOKENS} tokens.`,
    );

const doLines = z.array(line(300)).max(20);
export const DesignComponentSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: line(80),
  do: doLines,
  dont: doLines,
  example: z.string().min(1).max(2000),
});
export type DesignComponent = z.infer<typeof DesignComponentSchema>;
export const DesignRuleSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  text: line(500),
  do: doLines,
  dont: doLines,
  example: z.string().min(1).max(2000),
});
export type DesignRule = z.infer<typeof DesignRuleSchema>;

const uniqueIds = (items: readonly { id: string }[]) =>
  new Set(items.map((item) => item.id)).size === items.length;

export const DesignSystemSchema = z
  .strictObject({
    schema: z.literal(1),
    tokens: z.strictObject({
      color: group(ColorTokenSchema),
      /** Families, weights, sizes and line heights. */
      type: group(
        z.discriminatedUnion('$type', [
          FontFamilyTokenSchema,
          FontWeightTokenSchema,
          DimensionTokenSchema,
          NumberTokenSchema,
        ]),
      ),
      spacing: group(DimensionTokenSchema),
      radius: group(DimensionTokenSchema),
      shadow: group(ShadowTokenSchema),
      motion: group(z.discriminatedUnion('$type', [DurationTokenSchema, CubicBezierTokenSchema])),
    }),
    components: z.array(DesignComponentSchema).max(100).refine(uniqueIds, 'Component IDs differ.'),
    rules: z.array(DesignRuleSchema).max(100).refine(uniqueIds, 'Rule IDs differ.'),
  })
  .refine(
    (system) => new TextEncoder().encode(JSON.stringify(system)).byteLength <= DESIGN_SYSTEM_BYTES,
    'A design system stays within its byte bound.',
  );
export type DesignSystem = z.infer<typeof DesignSystemSchema>;

/** Where the project's design system lives and which saved version is current. */
export const DesignSystemRecordSchema = z.strictObject({
  projectId: id('prj'),
  path: projectPath,
  version: z.number().int().min(1),
  /** hashCanonical(system) of the saved version. Findings and turns name a version by it. */
  versionHash: hash,
  /** Writing roles receive the system. On by default once a system exists. */
  delivery: z.boolean(),
  updatedAt: timestamp,
});
export type DesignSystemRecord = z.infer<typeof DesignSystemRecordSchema>;

export const DesignFindingIdSchema = id('dsf');
export const DesignFindingRuleSchema = z.enum([
  'raw-color',
  'off-scale-spacing',
  'unknown-font',
  'off-scale-radius',
  'unknown-shadow',
]);
/**
 * open: new. sent: given to the fixer. allowed: kept once with a reason. updated: a saved version
 * covers it. resolved: the file no longer has it.
 */
export const DesignFindingStateSchema = z.enum(['open', 'sent', 'allowed', 'updated', 'resolved']);
export const DesignFindingSchema = z
  .strictObject({
    id: DesignFindingIdSchema,
    taskId: id('tsk'),
    file: projectPath,
    line: z.number().int().min(1),
    rule: DesignFindingRuleSchema,
    /** The literal the check found, such as `#3b82f6` or `13px`. */
    found: line(200),
    nearestToken: TokenPathSchema.nullable(),
    state: DesignFindingStateSchema,
    reason: line(500).nullable(),
    /** The design system version the file was checked against. */
    versionHash: hash,
  })
  .refine(
    (finding) => finding.state !== 'allowed' || finding.reason !== null,
    'A finding allowed once says why.',
  );
export type DesignFinding = z.infer<typeof DesignFindingSchema>;

/** Saves a new version after the person confirmed the diff. A stale expected version refuses. */
export const SaveDesignSystemPayloadSchema = z.strictObject({
  projectId: id('prj'),
  path: projectPath,
  body: DesignSystemSchema,
  /** The version the edit started from. Zero for the first save. */
  expectedVersion: z.number().int().nonnegative(),
  confirm: z.literal('explicit'),
});
const changed = z.array(z.string().min(1).max(200)).max(2000);
/** What a save changed, by token path, `component:<id>` and `rule:<id>`. */
export const DesignSystemSavedSchema = z.strictObject({
  record: DesignSystemRecordSchema,
  added: changed,
  changed,
  removed: changed,
});
export type DesignSystemSaved = z.infer<typeof DesignSystemSavedSchema>;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const VIEW_ORIGIN = 'http://127.0.0.1';
const onOrigin = (path: string) => {
  try {
    return new URL(path, VIEW_ORIGIN).origin === VIEW_ORIGIN;
  } catch {
    return false;
  }
};
const loopback = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && LOOPBACK.has(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
};

/** The most views one preview shoots. */
export const MAX_PREVIEW_VIEWS = 6;
/** One page of the preview. The image the reviewer gets carries its name. */
export const DesignPreviewViewSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  path: z
    .string()
    .min(1)
    .max(500)
    .refine(
      (path) =>
        path.isWellFormed() &&
        !/[\p{Cc}\s\\]/u.test(path) &&
        path.startsWith('/') &&
        !path.startsWith('//') &&
        onOrigin(path),
      'A view path starts with one / and stays on the preview address.',
    ),
});
/**
 * The local server the screenshot check shoots after a writing turn. The command serves the
 * project from the thread's copy and follows the rules for a check command a person adds. The
 * address is plain http on this computer, so a view can never reach another host.
 */
export const DesignPreviewSchema = z.strictObject({
  command: line(500),
  url: z
    .string()
    .max(200)
    .refine(loopback, 'The preview answers on http at localhost, 127.0.0.1 or [::1].'),
  views: z
    .array(DesignPreviewViewSchema)
    .min(1)
    .max(MAX_PREVIEW_VIEWS)
    .refine(
      (views) => new Set(views.map((view) => view.name)).size === views.length,
      'View names differ.',
    ),
});
export type DesignPreview = z.infer<typeof DesignPreviewSchema>;
/** Declares the project's preview, or removes it with null. It needs a saved design system. */
export const SetDesignPreviewPayloadSchema = z.strictObject({
  projectId: id('prj'),
  preview: DesignPreviewSchema.nullable(),
});

export const ReadDesignSystemPayloadSchema = z.strictObject({ projectId: id('prj') });
export const DesignSystemReadSchema = z.strictObject({
  projectId: id('prj'),
  /** Null before the first save. */
  record: DesignSystemRecordSchema.nullable(),
  system: DesignSystemSchema.nullable(),
  /**
   * The file at `record.path` against the recorded hash. invalid: it no longer parses as a design
   * system. Null before the first save.
   */
  file: z.enum(['current', 'changed', 'missing', 'invalid']).nullable(),
  /** The declared preview. Null when there is none. */
  preview: DesignPreviewSchema.nullable().default(null),
});
export type DesignSystemRead = z.infer<typeof DesignSystemReadSchema>;

/** What an import reads. design-system adopts a canonical design system file as it stands. */
export const DesignSystemSourceSchema = z.enum([
  'css-variables',
  'tailwind-config',
  'tokens-json',
  'design-md',
  'design-system',
]);
/** Reads a project file into a draft. It saves nothing. */
export const ImportDesignSystemPayloadSchema = z.strictObject({
  projectId: id('prj'),
  source: DesignSystemSourceSchema,
  path: projectPath,
});
/**
 * Asks for a draft from a description in the person's words. It saves nothing. It is a mutation,
 * so a retried key answers from its receipt and does not ask a model twice.
 */
export const DraftDesignSystemPayloadSchema = z.strictObject({
  projectId: id('prj'),
  description: z.string().min(1).max(4000),
});
/** A draft from an import or a description. Nothing is saved until SaveDesignSystem. */
export const DesignSystemDraftSchema = z
  .strictObject({
    source: z.enum([...DesignSystemSourceSchema.options, 'description']),
    /** The file an import read. Null for a draft from a description. */
    path: projectPath.nullable(),
    system: DesignSystemSchema,
    /** Values the draft could not map to a token. */
    skipped: z.number().int().nonnegative(),
  })
  .refine(
    (draft) => (draft.source === 'description') === (draft.path === null),
    'An imported draft names its file, and a described one names none.',
  );
export type DesignSystemDraft = z.infer<typeof DesignSystemDraftSchema>;

export const SetDesignSystemDeliveryPayloadSchema = z.strictObject({
  projectId: id('prj'),
  enabled: z.boolean(),
});
export const RunDesignCheckPayloadSchema = z.strictObject({ taskId: id('tsk') });
export const ReadDesignFindingsPayloadSchema = z.strictObject({ taskId: id('tsk') });
/** A thread's findings, oldest first. */
export const DesignFindingsSchema = z.strictObject({
  taskId: id('tsk'),
  /** The version the newest check used. Null before any check ran. */
  versionHash: hash.nullable(),
  findings: z.array(DesignFindingSchema).max(MAX_DESIGN_FINDINGS),
});
export type DesignFindings = z.infer<typeof DesignFindingsSchema>;
/**
 * update-system opens a draft that covers the finding. The system changes only when the person
 * confirms that draft through SaveDesignSystem.
 */
export const ResolveDesignFindingPayloadSchema = z
  .strictObject({
    findingId: DesignFindingIdSchema,
    action: z.enum(['send-to-fixer', 'allow-once', 'update-system']),
    reason: line(500).optional(),
  })
  .refine(
    (payload) => payload.action !== 'allow-once' || payload.reason !== undefined,
    'Allowing a finding once needs a reason.',
  );
