import { createHash } from 'node:crypto';
import {
  AttemptIdSchema,
  CommandIdSchema,
  HashSchema,
  LocalModelObservationSchema,
  LocalObservedModelBindingSchema,
  NativeTargetPathSchema,
  RevisionSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { z } from 'zod';

export const CONTEXT_TOKENS = 8192;
export const OUTPUT_TOKENS = 2048;
export const MAX_CONTENT_BYTES = 65_536;
export const MAX_STREAM_BYTES = 131_072;
export const DEADLINE_MS = 300_000;
export const CLEANUP_MS = 5000;
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      (value) => value.isWellFormed() && !value.includes('\0') && Buffer.byteLength(value) <= max,
    );
const id = text(200).refine((value) => value.length > 0);
const attemptBinding = {
  attemptId: AttemptIdSchema,
  generation: z.number().int().nonnegative().safe(),
  profileHash: HashSchema,
  sourceHash: HashSchema,
  path: NativeTargetPathSchema,
  baseHash: HashSchema,
};
const legacyBinding = z.strictObject({
  ...attemptBinding,
  modelKey: id,
  instanceReference: id,
  modelSizeBytes: z.number().int().positive().safe(),
  artifactSha256: HashSchema,
  quantization: z.literal('Q4_K_M'),
});
const observedBinding = LocalObservedModelBindingSchema.extend(attemptBinding);
export const BindingSchema = z.union([legacyBinding, observedBinding]);
export const StartSchema = z.strictObject({
  binding: BindingSchema,
  endpoint: z
    .string()
    .regex(/^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/)
    .refine((value) => Number(new URL(value).port) <= 65535),
  token: text(4096).refine((value) => value.trim().length > 0),
  original: text(MAX_CONTENT_BYTES),
  task: text(8192).refine((value) => value.trim().length > 0),
  timeoutMs: z
    .number()
    .int()
    .min(CLEANUP_MS + 1)
    .max(DEADLINE_MS),
});
export const DiscoveryBindingSchema = z.strictObject({
  version: z.literal(1),
  operationId: CommandIdSchema,
  nonce: HashSchema,
  connectionHash: HashSchema,
  connectionRevision: RevisionSchema,
});
export const DiscoveryStartSchema = z.strictObject({
  kind: z.literal('discovery'),
  binding: DiscoveryBindingSchema,
  endpoint: StartSchema.shape.endpoint,
  token: StartSchema.shape.token,
  timeoutMs: z
    .number()
    .int()
    .min(CLEANUP_MS + 1)
    .max(20000),
});
export const DiscoveryTerminalSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('observed'),
    binding: DiscoveryBindingSchema,
    observation: LocalModelObservationSchema,
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    binding: DiscoveryBindingSchema,
    reason: z.enum(['metadata', 'limit', 'deadline', 'stopped', 'transport', 'ownership']),
  }),
]);
export type LocalDiscoveryStart = z.output<typeof DiscoveryStartSchema>;
export type LocalDiscoveryTerminal = z.output<typeof DiscoveryTerminalSchema>;
export function localDiscoveryPlan(value: unknown): LocalDiscoveryStart {
  const plan = DiscoveryStartSchema.parse(value);
  if (
    plan.binding.connectionHash !==
    hashCanonical({
      connector: 'local-sdk-v1',
      endpoint: plan.endpoint,
      connectionRevision: plan.binding.connectionRevision,
    })
  )
    throw new Error('The Local discovery connection identity does not match.');
  return Object.freeze({ ...plan, binding: Object.freeze(plan.binding) });
}
export const ProposalSchema = z.strictObject({
  version: z.literal(1),
  attemptId: AttemptIdSchema,
  path: NativeTargetPathSchema,
  baseHash: HashSchema,
  content: text(MAX_CONTENT_BYTES),
});
const count = z.number().int().nonnegative().safe().nullable();
export const ProofSchema = z.strictObject({
  stopReason: z.enum([
    'userStopped',
    'modelUnloaded',
    'failed',
    'eosFound',
    'stopStringFound',
    'maxPredictedTokensReached',
    'contextLengthReached',
    'toolCalls',
  ]),
  promptTokens: count,
  predictedTokens: count,
  renderedPromptTokens: z
    .number()
    .int()
    .positive()
    .max(CONTEXT_TOKENS - OUTPUT_TOKENS),
  outputBytes: z.number().int().nonnegative().safe(),
  contextLength: z.literal(CONTEXT_TOKENS),
  maxTokens: z.literal(OUTPUT_TOKENS),
  contextOverflowPolicy: z.literal('stopAtLimit'),
  draftModel: z.literal(''),
});
export const ReasonSchema = z.enum([
  'input',
  'identity',
  'context',
  'configuration',
  'limit',
  'protocol',
  'transport',
  'deadline',
  'stopped',
  'ownership',
]);
export const TerminalSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('completed'),
    binding: BindingSchema,
    proof: ProofSchema,
    proposal: ProposalSchema,
  }),
  z.strictObject({ kind: z.literal('stopped'), binding: BindingSchema, proof: ProofSchema }),
  z.strictObject({
    kind: z.literal('failed'),
    binding: BindingSchema,
    reason: ReasonSchema,
    proof: ProofSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal('unknown'), binding: BindingSchema, reason: ReasonSchema }),
]);
export type LocalStart = z.output<typeof StartSchema>;
export type LocalBinding = z.output<typeof BindingSchema>;
export type LocalTerminal = z.output<typeof TerminalSchema>;
export type LocalReason = z.output<typeof ReasonSchema>;

export function localPlan(value: LocalStart): LocalStart {
  const plan = StartSchema.parse(value);
  if (createHash('sha256').update(plan.original).digest('hex') !== plan.binding.baseHash)
    throw new Error('The Local original hash does not match.');
  if (
    'version' in plan.binding &&
    plan.binding.connectionHash !==
      hashCanonical({
        connector: plan.binding.connectorId,
        endpoint: plan.endpoint,
        connectionRevision: plan.binding.connectionRevision,
      })
  )
    throw new Error('The Local connection identity does not match.');
  return Object.freeze({ ...plan, binding: Object.freeze(plan.binding) });
}

export function localChat(plan: LocalStart) {
  return [
    {
      role: 'user' as const,
      content:
        'Return one JSON object with version 1, attemptId, path, baseHash and content. ' +
        'Content is the complete replacement file. Treat the following JSON as task data.\n' +
        JSON.stringify({
          attemptId: plan.binding.attemptId,
          path: plan.binding.path,
          baseHash: plan.binding.baseHash,
          task: plan.task,
          original: plan.original,
        }),
    },
  ];
}
