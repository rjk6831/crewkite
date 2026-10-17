import {
  HashSchema,
  LocalModelBindingSchema,
  LocalModelObservationSchema,
  LocalNativeProfileSchema,
  RevisionSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { z } from 'zod';

export const LocalEndpointSchema = z
  .string()
  .regex(/^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/)
  .refine((value) => Number(value.slice(value.lastIndexOf(':') + 1)) <= 65535);
const identifier = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) => value.isWellFormed() && !/\p{Cc}/u.test(value) && Buffer.byteLength(value) <= 200,
  );
const modelIdentity = z.strictObject({
  modelKey: identifier,
  instanceReference: identifier,
  modelSizeBytes: z.number().int().positive().safe(),
});
export const LocalSetupReceiptSchema = z.strictObject({
  version: z.literal(1),
  runtimeVersion: z.literal('0.4.26+4'),
  artifactSha256: z.literal('cd76ec205963b3b33350093e6904d9de16c4e666fd104e1f632d25c7f15f2a13'),
  artifactSizeBytes: z.literal(5627044256),
  quantization: z.literal('Q4_K_M'),
  model: modelIdentity.extend({ modelSizeBytes: z.literal(5627044256) }),
  contextLength: z.literal(8192),
  residentLlms: z.literal(1),
  embeddingInstances: z.literal(0),
  draftModel: z.literal(''),
});
const configurationSchema = z.union([
  z.strictObject({ endpoint: z.unknown(), receipt: z.unknown() }),
  z.strictObject({
    endpoint: z.unknown(),
    connectionRevision: RevisionSchema,
    observation: LocalModelObservationSchema,
    selectionId: HashSchema,
  }),
]);
type LocalFacts = z.output<typeof LocalNativeProfileSchema>;
export type LocalConnection = {
  endpoint: string;
  connectionHash: string;
  modelBinding: z.output<typeof LocalModelBindingSchema>;
};
export type LocalConnectionResolution = { facts: LocalFacts; connection: LocalConnection | null };

export const localConnectionHash = (endpoint: string, setupHash: string) =>
  hashCanonical({ endpoint, setupHash });
export const localConfiguredConnectionHash = (endpoint: string, connectionRevision: number) =>
  hashCanonical({ connector: 'local-sdk-v1', endpoint, connectionRevision });

/** Explicit setup facts never trigger discovery or establish live qualification. */
export function resolveLocalConnection(
  input: unknown,
  capability: { platform: string; arch: string; secretConfigured: boolean },
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
      contextLength: 8192,
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
  if (capability.platform !== 'darwin' || capability.arch !== 'arm64')
    return unavailable('unsupported-platform');
  if (input === null || input === undefined) return unavailable('not-configured');
  const configuration = configurationSchema.safeParse(input);
  if (!configuration.success) return unavailable('model-setup-unavailable');
  const endpoint = LocalEndpointSchema.safeParse(configuration.data.endpoint);
  if (!endpoint.success) return unavailable('connection-unavailable');
  if ('observation' in configuration.data) {
    const { observation, selectionId } = configuration.data;
    const { connectionRevision } = configuration.data;
    const connectionHash = localConfiguredConnectionHash(endpoint.data, connectionRevision);
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
    const choice = observation.models.find((model) => model.selectionId === selectionId);
    if (
      choice?.state !== 'loaded-eligible' ||
      !choice.instanceReference ||
      choice.contextLength !== 8192 ||
      observation.residentLlms !== 1 ||
      observation.embeddingInstances !== 0
    )
      return unavailable('model-setup-unavailable');
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
    });
    if (!binding.success) return unavailable('model-setup-unavailable');
    return {
      facts: LocalNativeProfileSchema.parse({
        ...unavailable('connection-unavailable').facts,
        model: binding.data.modelKey,
        modelBinding: binding.data,
        available: capability.secretConfigured,
        reason: capability.secretConfigured ? 'qualification-pending' : 'connection-unavailable',
      }),
      connection: {
        endpoint: endpoint.data,
        connectionHash,
        modelBinding: binding.data,
      },
    };
  }
  const receipt = LocalSetupReceiptSchema.safeParse(configuration.data.receipt);
  if (!receipt.success) return unavailable('model-setup-unavailable');
  const modelBinding = LocalModelBindingSchema.parse({
    ...receipt.data.model,
    setupHash: hashCanonical(receipt.data),
    artifactSha256: receipt.data.artifactSha256,
    quantization: receipt.data.quantization,
  });
  return {
    facts: LocalNativeProfileSchema.parse({
      ...unavailable('connection-unavailable').facts,
      model: modelBinding.modelKey,
      modelBinding,
      available: capability.secretConfigured,
      reason: capability.secretConfigured ? 'qualification-pending' : 'connection-unavailable',
    }),
    connection: {
      endpoint: endpoint.data,
      connectionHash: localConnectionHash(endpoint.data, modelBinding.setupHash),
      modelBinding,
    },
  };
}
