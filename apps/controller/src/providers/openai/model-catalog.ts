import {
  ConversationModelCatalogEntriesSchema,
  ConversationModelCatalogEntrySchema,
  ConversationModelCatalogSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { z } from 'zod';
import { type DiscoveryMetadata, OpenAiDiscovery } from './discovery.ts';
import { type NativeLifecycle, startNativeSession } from './native-discovery.ts';
import type { NativeProfileResolution } from './profile.ts';

// The client lists older models only on request. The flag keeps them apart in the picker, and the
// contract's own bounds still hold for the list.
const observedModels = z
  .array(
    z.strictObject({
      ...ConversationModelCatalogEntrySchema.shape,
      hidden: z.literal(true).optional(),
    }),
  )
  .refine(
    (models) =>
      ConversationModelCatalogEntriesSchema.safeParse(
        models.map(({ hidden: _hidden, ...model }) => model),
      ).success,
    'A model list needs distinct bounded entries with supported efforts.',
  );

export const OpenAiModelCatalogObservationSchema = z.strictObject({
  version: z.literal(1),
  profileId: z.enum(['openai-file-v1', 'openai-repository-v1']),
  observedAt: ConversationModelCatalogSchema.shape.observedAt,
  profileHash: ConversationModelCatalogSchema.shape.profileHash,
  client: ConversationModelCatalogSchema.shape.client,
  locationHash: ConversationModelCatalogSchema.shape.locationHash,
  models: observedModels,
});

export type OpenAiModelCatalogObservation = z.infer<typeof OpenAiModelCatalogObservationSchema>;

function availableProfile(profile: NativeProfileResolution) {
  if (
    !['openai-file-v1', 'openai-repository-v1'].includes(profile.facts.id) ||
    profile.facts.family !== 'openai' ||
    !profile.facts.available ||
    !profile.client ||
    !profile.environment ||
    !profile.locationHash
  )
    throw new Error('OpenAI model discovery requires the exact available native profile.');
  return {
    facts: profile.facts,
    client: profile.client,
    environment: profile.environment,
    locationHash: profile.locationHash,
  };
}

export function openAiModelCatalogObservation(
  profile: NativeProfileResolution,
  metadata: DiscoveryMetadata,
  observedAt: string,
) {
  const current = availableProfile(profile);
  return OpenAiModelCatalogObservationSchema.parse({
    version: 1,
    profileId: current.facts.id,
    observedAt,
    profileHash: hashCanonical(current.facts),
    client: current.client,
    locationHash: current.locationHash,
    models: metadata.models.map((model) => ({
      model: model.model,
      efforts: model.supportedReasoningEfforts,
      defaultEffort: model.defaultReasoningEffort,
      ...(model.hidden ? { hidden: true } : {}),
    })),
  });
}

export function matchesOpenAiModelCatalogObservation(
  profile: NativeProfileResolution,
  observation: OpenAiModelCatalogObservation,
) {
  try {
    const current = availableProfile(profile);
    const catalog = OpenAiModelCatalogObservationSchema.parse(observation);
    return (
      catalog.profileHash === hashCanonical(current.facts) &&
      hashCanonical(catalog.client) === hashCanonical(current.client) &&
      catalog.locationHash === current.locationHash
    );
  } catch {
    return false;
  }
}

/**
 * A failed model read in words a person can act on. The session reason alone says too little:
 * most failures come back as `protocol`, and the request that was waiting tells them apart. A
 * client that exits early names its cause on stderr, so the last line it wrote follows, within
 * the 400 characters a reason holds.
 */
export function modelReadFailure(outcome: {
  reason: string | null;
  lastRequest: string;
  stderr?: readonly string[];
}) {
  const reason = readFailure(outcome);
  const said = outcome.stderr?.at(-1);
  return said ? `${reason} The client wrote: ${said}`.slice(0, 400) : reason;
}

function readFailure(outcome: { reason: string | null; lastRequest: string }) {
  switch (outcome.reason) {
    case 'deadline':
      return 'The OpenAI client did not list its models within 20 seconds. Refresh to try again.';
    case 'launch':
      return 'The OpenAI client could not be started. Check that it is installed, then refresh.';
    case 'output-limit':
      return 'The OpenAI client wrote more output than a model read allows. Update the client, then refresh.';
    case 'stopped':
      return 'The model read stopped before it finished. Refresh to try again.';
  }
  switch (outcome.lastRequest) {
    case 'account/read':
      return 'The OpenAI client reported no ChatGPT sign-in. Sign in with a ChatGPT plan, then refresh.';
    case 'features-list':
    case 'config/read':
    case 'configRequirements/read':
      return 'The OpenAI client settings differ from the ones CrewKite runs it with. Update the client, then refresh.';
    case 'model/list':
    case 'complete':
      return 'The OpenAI client listed no models CrewKite can offer. Update the client, then refresh.';
    default:
      return `The OpenAI client stopped answering at ${outcome.lastRequest}. Update the client, then refresh.`;
  }
}

/**
 * Read the native catalog without creating a thread or submitting a model turn. The read asks for
 * hidden models too, so a thread that started on an older model can still pick it.
 */
export function startOpenAiModelCatalogObservation(
  profile: NativeProfileResolution,
  paths: { directory: string; repositoryRoot: string },
  options: Parameters<typeof startNativeSession>[1] & {
    observedAt: () => string;
    lifecycle?: NativeLifecycle;
  },
) {
  const current = availableProfile(profile);
  const now = options.now ?? (() => performance.now());
  const handle = startNativeSession(
    {
      executable: current.client.executable,
      sha256: current.client.sha256,
      environment: current.environment,
      directory: paths.directory,
      repositoryRoot: paths.repositoryRoot,
    },
    options,
    (remaining) =>
      new OpenAiDiscovery({
        now,
        timeoutMs: remaining,
        readConfiguration: true,
        configurationDirectory: paths.directory,
        includeHidden: true,
      }),
  );
  const result = handle.result.then((outcome) => {
    if (!outcome.metadata) return { ...outcome, metadata: null };
    try {
      return {
        ...outcome,
        metadata: openAiModelCatalogObservation(profile, outcome.metadata, options.observedAt()),
      };
    } catch {
      return { ...outcome, metadata: null, reason: 'protocol' as const };
    }
  });
  return {
    get group() {
      return handle.group;
    },
    get groups() {
      return handle.groups;
    },
    result,
    stop: handle.stop,
  };
}
