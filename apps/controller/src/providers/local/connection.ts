import {
  HashSchema,
  LocalAuthModeSchema,
  LocalModelBindingSchema,
  LocalModelObservationSchema,
  LocalNativeProfileSchema,
  RevisionSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { z } from 'zod';
import { platformGate } from '../platform.ts';
import { localProposalBudget } from './budget.ts';

export const LocalEndpointSchema = z
  .string()
  .regex(/^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/)
  .refine((value) => Number(value.slice(value.lastIndexOf(':') + 1)) <= 65535);
const configurationSchema = z.strictObject({
  endpoint: z.unknown(),
  authMode: LocalAuthModeSchema.optional(),
  connectionRevision: RevisionSchema,
  observation: LocalModelObservationSchema,
  selectionId: HashSchema,
});
type LocalFacts = z.output<typeof LocalNativeProfileSchema>;
export type LocalConnection = {
  endpoint: string;
  authMode: 'token' | 'none';
  connectionHash: string;
  modelBinding: z.output<typeof LocalModelBindingSchema>;
};
export type LocalConnectionResolution = { facts: LocalFacts; connection: LocalConnection | null };

export const localConnectionHash = (endpoint: string, setupHash: string) =>
  hashCanonical({ endpoint, setupHash });
export const localConfiguredConnectionHash = (
  endpoint: string,
  connectionRevision: number,
  authMode: 'token' | 'none' = 'token',
) =>
  hashCanonical({
    connector: 'local-sdk-v1',
    endpoint,
    connectionRevision,
    ...(authMode === 'none' ? { authMode } : {}),
  });

/** Explicit setup facts never trigger discovery or establish live qualification. */
export function resolveLocalConnection(
  input: unknown,
  capability: { platform: string; arch: string; secretConfigured: boolean; connected?: boolean },
): LocalConnectionResolution {
  const unavailable = (reason: LocalFacts['reason']): LocalConnectionResolution => ({
    facts: LocalNativeProfileSchema.parse({
      id: 'local-file-v1',
      family: 'local',
      displayName: 'Local file proposal',
      sdkVersion: '2.1.0',
      model: 'unknown',
      modelBinding: null,
      billing: 'local',
      contextLength: null,
      maximumOutputTokens: 2048,
      qualifiedAt: null,
      maximumTaskMs: 300000,
      maximumFileBytes: 65536,
      maximumSubmissions: 1,
      available: false,
      reason,
    }),
    connection: null,
  });
  if (!platformGate('local', capability).allowed) return unavailable('unsupported-platform');
  if (input === null || input === undefined) return unavailable('not-configured');
  const configuration = configurationSchema.safeParse(input);
  if (!configuration.success) return unavailable('model-setup-unavailable');
  const endpoint = LocalEndpointSchema.safeParse(configuration.data.endpoint);
  if (!endpoint.success) return unavailable('connection-unavailable');
  const { observation, selectionId } = configuration.data;
  const { connectionRevision } = configuration.data;
  const authMode = configuration.data.authMode ?? 'token';
  const connected = capability.connected ?? capability.secretConfigured;
  const connectionHash = localConfiguredConnectionHash(endpoint.data, connectionRevision, authMode);
  const { observationHash, ...observed } = observation;
  if (
    hashCanonical(observed) !== observationHash ||
    observation.models.some(
      (choice) =>
        choice.selectionId !==
        hashCanonical({
          runtime: observation.runtime,
          metadataHash: choice.identity.metadataHash,
        }),
    )
  )
    return unavailable('model-setup-unavailable');
  // The selected instance decides. Other residents and the size of its context do not.
  const choice = observation.models.find((model) => model.selectionId === selectionId);
  if (choice?.state !== 'loaded-eligible' || !choice.instanceReference || !choice.contextLength)
    return unavailable('model-setup-unavailable');
  // The proposal's output cap follows the context this instance reports. A context too small to
  // leave the smallest reply after the margin cannot take a proposal.
  const budget = localProposalBudget(choice.contextLength);
  if (!budget) return unavailable('model-setup-unavailable');
  const binding = LocalModelBindingSchema.safeParse({
    version: 2,
    identityKind: 'runtime-metadata',
    setupHash: hashCanonical({ version: 2, connectionHash, observationHash, selectionId }),
    connectionHash,
    connectionRevision,
    connectorId: observation.runtime.connectorId,
    runtimeVersion: observation.runtime.version,
    runtimeBuild: observation.runtime.build,
    modelKey: choice.identity.modelKey,
    instanceReference: choice.instanceReference,
    modelSizeBytes: choice.identity.sizeBytes,
    format: choice.identity.format,
    metadataHash: choice.identity.metadataHash,
    ...(authMode === 'none' ? { authMode } : {}),
  });
  if (!binding.success) return unavailable('model-setup-unavailable');
  return {
    facts: LocalNativeProfileSchema.parse({
      ...unavailable('connection-unavailable').facts,
      model: binding.data.modelKey,
      modelBinding: binding.data,
      contextLength: choice.contextLength,
      maximumOutputTokens: budget.outputTokens,
      ...(budget.reasoningTokens === null ? {} : { reasoningBudgetTokens: budget.reasoningTokens }),
      available: connected,
      reason: connected ? 'qualification-pending' : 'connection-unavailable',
    }),
    connection: {
      endpoint: endpoint.data,
      authMode,
      connectionHash,
      modelBinding: binding.data,
    },
  };
}

/**
 * The choice in a fresh read that keeps the selection. A reload or a runtime update changes the
 * selection ID, so the match is by model key, and only to one choice with a loaded instance. Null
 * clears the selection, and the person picks again.
 */
export function retainedSelection(
  modelKey: string | null,
  next: z.output<typeof LocalModelObservationSchema>,
): z.output<typeof LocalModelObservationSchema>['models'][number] | null {
  const loaded = next.models.filter(
    (model) => model.identity.modelKey === modelKey && model.instanceReference !== null,
  );
  return modelKey !== null && loaded.length === 1 ? loaded[0] : null;
}
