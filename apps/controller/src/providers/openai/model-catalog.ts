import {
  ConversationModelCatalogEntriesSchema,
  ConversationModelCatalogSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { z } from 'zod';
import { type DiscoveryMetadata, OpenAiDiscovery } from './discovery.ts';
import { type NativeLifecycle, startNativeSession } from './native-discovery.ts';
import type { NativeProfileResolution } from './profile.ts';

export const OpenAiModelCatalogObservationSchema = z.strictObject({
  version: z.literal(1),
  profileId: z.enum(['openai-file-v1', 'openai-repository-v1']),
  observedAt: ConversationModelCatalogSchema.shape.observedAt,
  profileHash: ConversationModelCatalogSchema.shape.profileHash,
  client: ConversationModelCatalogSchema.shape.client,
  locationHash: ConversationModelCatalogSchema.shape.locationHash,
  models: ConversationModelCatalogEntriesSchema,
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

/** Read the native catalog without creating a thread or submitting a model turn. */
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
