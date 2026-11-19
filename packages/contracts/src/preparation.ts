import { z } from 'zod';

// Dependency preparation: an independent copy of the project's installed dependencies for each
// writable copy CrewKite runs checks in. A record says what was copied and from which inputs. It
// does not claim the install matched the lockfile. A change to any input makes it stale, and
// nothing installs packages on its own.

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
const name = z.string().regex(/^[a-z0-9][a-z0-9_.@+-]{0,199}$/);
/** A manifest path inside the project, such as `package.json` or `packages/app/package.json`. */
const manifestPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      path.isWellFormed() &&
      !/\p{Cc}/u.test(path) &&
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.split('/').some((part) => !part || part === '.' || part === '..'),
    'A manifest is named by its relative path inside the project.',
  );

/** The thread's task ID, the lane's slice, or the acceptance attempt the copy belongs to. */
const scopeKey = z.string().min(1).max(200);

/** The most manifests one preparation records: the root and each workspace package. */
export const MAX_PREPARATION_MANIFESTS = 1000;

export const DependencyPreparationIdSchema = id('prp');
export const DependencyLayoutSchema = z.enum([
  'none',
  'npm',
  'pnpm',
  'pnpm-workspace',
  'unsupported',
]);
export type DependencyLayout = z.infer<typeof DependencyLayoutSchema>;
/** Which copy the preparation serves: the thread's copy, one plan lane, or an Accept candidate. */
export const DependencyPreparationScopeSchema = z.enum(['thread', 'lane', 'acceptance']);
export const DependencyPreparationStateSchema = z.enum([
  'preparing',
  'prepared',
  'stale',
  'failed',
  'unsupported',
]);
/** Why a preparation is stale, failed or unsupported. */
export const DependencyPreparationReasonSchema = z.enum([
  'stale-manifest',
  'stale-lockfile',
  'stale-workspace',
  'stale-runtime',
  'size-limit',
  'unsupported-layout',
  'yarn-pnp',
  'external-link',
  'tracked-dependency-root',
  'native-addon',
  'not-installed',
  'copy-failed',
]);
export type DependencyPreparationReason = z.infer<typeof DependencyPreparationReasonSchema>;

export const DependencyPreparationSchema = z
  .strictObject({
    id: DependencyPreparationIdSchema,
    taskId: id('tsk'),
    scope: DependencyPreparationScopeSchema,
    scopeKey,
    state: DependencyPreparationStateSchema,
    layout: DependencyLayoutSchema,
    /** What the copy was made from. Any change to these makes the preparation stale. */
    inputs: z.strictObject({
      /** sha256 of each manifest, keyed by its path. */
      manifestDigests: z
        .record(manifestPath, hash)
        .refine(
          (digests) => Object.keys(digests).length <= MAX_PREPARATION_MANIFESTS,
          `A preparation records at most ${MAX_PREPARATION_MANIFESTS} manifests.`,
        ),
      lockfileDigest: hash.nullable(),
      workspaceDigest: hash.nullable(),
      /** The Node runtime the checks run with, such as `node@24.22.0`. */
      runtime: name,
      /** The package manager the lockfile names, such as `pnpm@10.4.1`. Null with no lockfile. */
      packageManager: name.nullable(),
      platform: name,
      arch: name,
    }),
    /** The inventory digest of the copied dependency tree. Null until a copy completes. */
    treeDigest: hash.nullable(),
    bytes: z.number().int().nonnegative().nullable(),
    limitBytes: z.number().int().positive(),
    reason: DependencyPreparationReasonSchema.nullable(),
    preparedAt: timestamp.nullable(),
  })
  .refine(
    (record) =>
      (record.state === 'preparing' || record.state === 'prepared') === (record.reason === null),
    'A stale, failed or unsupported preparation says why.',
  );
export type DependencyPreparation = z.infer<typeof DependencyPreparationSchema>;

/** The most preparations one read returns, oldest first. */
export const MAX_THREAD_PREPARATIONS = 256;

/** Copies the installed dependencies into one copy. Only the person starts it; nothing installs. */
export const PrepareDependenciesPayloadSchema = z.strictObject({
  taskId: id('tsk'),
  scope: DependencyPreparationScopeSchema,
  scopeKey,
  consent: z.literal('explicit'),
});
/** A thread's preparations, narrowed to one scope or one copy. A key needs its scope. */
export const ReadDependencyPreparationPayloadSchema = z
  .strictObject({
    taskId: id('tsk'),
    scope: DependencyPreparationScopeSchema.optional(),
    scopeKey: scopeKey.optional(),
  })
  .refine(
    (payload) => payload.scopeKey === undefined || payload.scope !== undefined,
    'A copy is named by its scope and key.',
  );
export const DependencyPreparationsReadSchema = z.strictObject({
  taskId: id('tsk'),
  preparations: z.array(DependencyPreparationSchema).max(MAX_THREAD_PREPARATIONS),
});
export type DependencyPreparationsRead = z.infer<typeof DependencyPreparationsReadSchema>;

/** What a check, a lane or Accept shows when its copy has no current preparation. */
export const DEPENDENCIES_NEED_PREPARATION = 'Dependencies need preparation.';
/** What a preparation refused for size shows. Nothing is copied over the limit. */
export const DEPENDENCIES_OVER_LIMIT =
  'The installed dependencies are larger than the copy limit. Nothing was copied.';

const REASON_WORDS: Partial<Record<DependencyPreparationReason, string>> = {
  'stale-manifest': 'A package.json changed.',
  'stale-lockfile': 'The lockfile changed.',
  'stale-workspace': 'The workspace layout changed.',
  'stale-runtime': 'The Node runtime or package manager changed.',
  'unsupported-layout': 'This project layout is not supported.',
  'yarn-pnp': 'Yarn Plug and Play is not supported.',
  'external-link': 'A dependency or workspace links outside the project.',
  'tracked-dependency-root': 'The project tracks a node_modules folder in Git.',
  'native-addon': 'A package builds a native addon, which this copy cannot qualify.',
  'not-installed': 'The dependencies are not installed or do not match the lockfile.',
  'copy-failed': 'The copy could not be made.',
};

/**
 * What a copy whose preparation is not current shows, in the words every consumer uses: the need
 * line and what changed for a stale one, the reason for a failed or unsupported one.
 */
export const preparationLine = (record: Pick<DependencyPreparation, 'state' | 'reason'>) =>
  record.reason === 'size-limit'
    ? DEPENDENCIES_OVER_LIMIT
    : record.state === 'stale'
      ? `${DEPENDENCIES_NEED_PREPARATION} ${record.reason ? REASON_WORDS[record.reason] : ''}`.trim()
      : `${record.reason ? REASON_WORDS[record.reason] : 'The dependencies are not prepared.'}`;
