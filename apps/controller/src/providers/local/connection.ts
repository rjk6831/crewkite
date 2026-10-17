import { LocalModelBindingSchema, LocalNativeProfileSchema } from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { z } from 'zod';

export const LocalEndpointSchema = z
  .string()
  .regex(/^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/)
  .refine((value) => Number(value.slice(value.lastIndexOf(':') + 1)) <= 65535);
const modelIdentity = LocalModelBindingSchema.omit({
  setupHash: true,
  artifactSha256: true,
  quantization: true,
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
const configurationSchema = z.strictObject({ endpoint: z.unknown(), receipt: z.unknown() });
type LocalFacts = z.output<typeof LocalNativeProfileSchema>;
export type LocalConnection = {
  endpoint: string;
  connectionHash: string;
  modelBinding: z.output<typeof LocalModelBindingSchema>;
};
export type LocalConnectionResolution = { facts: LocalFacts; connection: LocalConnection | null };

export const localConnectionHash = (endpoint: string, setupHash: string) =>
  hashCanonical({ endpoint, setupHash });

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
