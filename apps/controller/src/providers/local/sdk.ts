import {
  type LocalModelChoiceSchema,
  LocalModelObservationSchema,
  LocalRuntimeIdentitySchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import {
  type LLM,
  type LLMPredictionOpts,
  LMStudioClient,
  type PredictionResult,
} from '@lmstudio/sdk';
import { z } from 'zod';
import type { Schedule } from '../../host/worker.ts';
import {
  CLEANUP_MS,
  CONTEXT_TOKENS,
  type ConfigurationDetail,
  type LocalDiscoveryStart,
  type LocalReason,
  type LocalStart,
  type LocalTerminal,
  localChat,
  localDiscoveryPlan,
  localPlan,
  MAX_STREAM_BYTES,
  OUTPUT_TOKENS,
  ProofSchema,
  ProposalSchema,
} from './profile.ts';

export type LoadedModel = Pick<
  LLM,
  | 'modelKey'
  | 'instanceReference'
  | 'sizeBytes'
  | 'getModelInfo'
  | 'getBasePredictionConfig'
  | 'getInstanceProcessingState'
  | 'applyPromptTemplate'
> & {
  tokenize(input: string): Promise<number[]>;
  complete(
    prompt: string,
    options: LLMPredictionOpts,
  ): {
    cancel(): Promise<void>;
    result(): Promise<PredictionResult>;
  };
};
export type LocalClient = {
  llm: { listLoaded(): Promise<LoadedModel[]> };
  embedding: { listLoaded(): Promise<unknown[]> };
  system?: { getLMStudioVersion(): Promise<{ version: string; build: number }> };
};
export type LocalDiscoveryClient = LocalClient & {
  system: {
    getLMStudioVersion(): Promise<{ version: string; build: number }>;
    listDownloadedModels(domain: 'llm'): Promise<unknown[]>;
    listDownloadedModelVariants(modelKey: string): Promise<unknown[]>;
  };
};
export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
export function localClientOptions(
  value: LocalStart | LocalDiscoveryStart,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const plan = 'kind' in value ? localDiscoveryPlan(value) : localPlan(value);
  // The SDK inherits this token when apiToken is omitted. The owned child excludes it.
  if (plan.authMode === 'none' && Object.hasOwn(environment, 'LM_API_TOKEN'))
    throw new Error('The Local no-authentication environment is unavailable.');
  return {
    baseUrl: plan.endpoint,
    ...(plan.authMode === 'none' ? {} : { apiToken: plan.token }),
    verboseErrorMessages: false,
    logger: silentLogger,
  };
}
export const createLocalClient = (plan: LocalStart | LocalDiscoveryStart) =>
  new LMStudioClient(localClientOptions(plan));
const infoSchema = z.object({
  type: z.literal('llm'),
  modelKey: z.string(),
  instanceReference: z.string(),
  sizeBytes: z.number().int().positive().safe(),
  format: z.enum(['gguf', 'safetensors']),
  deviceIdentifier: z.null(),
  contextLength: z.literal(CONTEXT_TOKENS),
});
const identifier = (bytes: number) =>
  z
    .string()
    .min(1)
    .max(bytes)
    .refine(
      (value) =>
        value.isWellFormed() && !/\p{Cc}/u.test(value) && Buffer.byteLength(value) <= bytes,
    );
const metadataSchema = z.object({
  type: z.literal('llm'),
  modelKey: identifier(200),
  displayName: identifier(200),
  path: identifier(1024).refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  ),
  format: identifier(64),
  sizeBytes: z.number().int().positive().safe(),
  deviceIdentifier: identifier(200).nullable(),
  quantization: z
    .object({ name: identifier(64), bits: z.number().int().min(1).max(64) })
    .optional(),
  selectedVariant: identifier(200).optional(),
  variants: z.array(identifier(200)).max(64).optional(),
});
const loadedMetadataSchema = metadataSchema.extend({
  instanceReference: identifier(200),
  contextLength: z.number().int().positive().safe(),
});
function metadataIdentity(value: z.output<typeof metadataSchema>) {
  const metadata = {
    modelKey: value.modelKey,
    path: value.path,
    format: value.format,
    sizeBytes: value.sizeBytes,
    deviceIdentifier: value.deviceIdentifier,
    quantization: value.quantization ?? null,
    selectedVariant: value.selectedVariant ?? null,
  };
  return {
    modelKey: value.modelKey,
    displayName: value.displayName,
    format: value.format,
    sizeBytes: value.sizeBytes,
    quantization: value.quantization ?? null,
    selectedVariant: value.selectedVariant ?? null,
    metadataHash: hashCanonical(metadata),
  };
}

/** Inventory is runtime metadata. It does not establish model-file identity or qualification. */
export type LocalDiscoveryResult =
  | { kind: 'observed'; observation: z.output<typeof LocalModelObservationSchema> }
  | { kind: 'unavailable'; reason: 'metadata' | 'limit' | 'deadline' | 'stopped' | 'transport' };
export async function discoverLocalModels(
  client: LocalDiscoveryClient,
  options: {
    now?: () => number;
    schedule?: Schedule;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<LocalDiscoveryResult> {
  const timeout = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15000)
    return { kind: 'unavailable', reason: 'limit' };
  const now = options.now ?? (() => performance.now());
  const began = now();
  let previous = began;
  let reason: 'metadata' | 'limit' | 'deadline' | 'stopped' | 'transport' = 'transport';
  let interruption: 'deadline' | 'stopped' | null = null;
  const guard = () => {
    const current = now();
    if (interruption) reason = interruption;
    else if (options.signal?.aborted) reason = 'stopped';
    else if (!Number.isFinite(current) || current < previous || current - began >= timeout)
      reason = 'deadline';
    else {
      previous = current;
      return;
    }
    throw new Error();
  };
  const bounded = (value: unknown, limit: number) => {
    if (!Array.isArray(value) || value.length > limit) {
      reason = 'limit';
      throw new Error();
    }
    return value as unknown[];
  };
  const work = async (): Promise<LocalDiscoveryResult> => {
    try {
      if (!Number.isFinite(began)) return { kind: 'unavailable', reason: 'deadline' };
      guard();
      const version = await client.system.getLMStudioVersion();
      guard();
      reason = 'metadata';
      const runtime = LocalRuntimeIdentitySchema.parse({ connectorId: 'local-sdk-v1', ...version });
      reason = 'transport';
      const downloaded = await client.system.listDownloadedModels('llm');
      guard();
      const inventory: z.output<typeof metadataSchema>[] = [];
      for (const raw of bounded(downloaded, 64)) {
        reason = 'metadata';
        const parent = metadataSchema.parse(raw);
        let variants = [raw];
        if (parent.variants?.length) {
          reason = 'transport';
          variants = await client.system.listDownloadedModelVariants(parent.modelKey);
          guard();
          if (!variants.length) {
            reason = 'metadata';
            throw new Error();
          }
        }
        for (const rawVariant of bounded(variants, 64)) {
          reason = 'metadata';
          const variant = metadataSchema.parse(rawVariant);
          inventory.push(variant);
          if (inventory.length > 64) {
            reason = 'limit';
            throw new Error();
          }
        }
      }
      reason = 'transport';
      const models = await client.llm.listLoaded();
      guard();
      bounded(models, 8);
      const embeddings = await client.embedding.listLoaded();
      guard();
      bounded(embeddings, 8);
      type Choice = z.output<typeof LocalModelChoiceSchema>;
      const choices = new Map<string, Choice>();
      for (const value of inventory) {
        const identity = metadataIdentity(value);
        reason = 'metadata';
        if (choices.has(identity.metadataHash)) throw new Error();
        const reasons: Choice['reasons'] = [];
        if (!['gguf', 'safetensors'].includes(value.format)) reasons.push('unsupported-format');
        if (value.deviceIdentifier !== null) reasons.push('remote-model');
        choices.set(identity.metadataHash, {
          selectionId: hashCanonical({ runtime, metadataHash: identity.metadataHash }),
          identity,
          instanceReference: null,
          contextLength: null,
          state: reasons.length ? 'incompatible' : 'installed-unloaded',
          reasons,
          qualification: 'unqualified',
        });
      }
      const instances = new Set<string>();
      const matched = new Set<string>();
      for (const model of models) {
        reason = 'transport';
        const rawInfo = await model.getModelInfo();
        guard();
        reason = 'metadata';
        const info = loadedMetadataSchema.parse(rawInfo);
        if (
          instances.has(info.instanceReference) ||
          model.modelKey !== info.modelKey ||
          model.instanceReference !== info.instanceReference ||
          model.sizeBytes !== info.sizeBytes
        )
          throw new Error();
        instances.add(info.instanceReference);
        const identity = metadataIdentity(info);
        let choice = choices.get(identity.metadataHash);
        if (!choice) {
          choice = {
            selectionId: hashCanonical({ runtime, metadataHash: identity.metadataHash }),
            identity,
            instanceReference: null,
            contextLength: null,
            state: 'incompatible',
            reasons: ['not-downloaded'],
            qualification: 'unqualified',
          };
          choices.set(identity.metadataHash, choice);
          if (choices.size > 64) {
            reason = 'limit';
            throw new Error();
          }
        }
        if (matched.has(identity.metadataHash)) {
          if (!choice.reasons.includes('identity-ambiguous'))
            choice.reasons.push('identity-ambiguous');
          choice.instanceReference = null;
          choice.contextLength = null;
          choice.state = 'incompatible';
          continue;
        }
        matched.add(identity.metadataHash);
        choice.instanceReference = info.instanceReference;
        choice.contextLength = info.contextLength;
        if (
          !['gguf', 'safetensors'].includes(info.format) &&
          !choice.reasons.includes('unsupported-format')
        )
          choice.reasons.push('unsupported-format');
        if (info.deviceIdentifier !== null && !choice.reasons.includes('remote-model'))
          choice.reasons.push('remote-model');
        if (models.length !== 1) choice.reasons.push('multiple-resident-models');
        if (embeddings.length) choice.reasons.push('resident-embedding');
        if (info.contextLength !== CONTEXT_TOKENS) choice.reasons.push('context');
        reason = 'transport';
        const state = await model.getInstanceProcessingState();
        guard();
        if (state.status !== 'idle' || state.queued !== 0) choice.reasons.push('busy');
        const base = await model.getBasePredictionConfig();
        guard();
        if (base.draftModel !== '') choice.reasons.push('draft');
        const current = await model.getModelInfo();
        guard();
        reason = 'metadata';
        const confirmed = loadedMetadataSchema.parse(current);
        if (
          metadataIdentity(confirmed).metadataHash !== identity.metadataHash ||
          confirmed.instanceReference !== info.instanceReference ||
          confirmed.contextLength !== info.contextLength
        )
          throw new Error();
        choice.state = choice.reasons.length ? 'incompatible' : 'loaded-eligible';
      }
      reason = 'transport';
      const currentModels = await client.llm.listLoaded();
      guard();
      bounded(currentModels, 8);
      const currentEmbeddings = await client.embedding.listLoaded();
      guard();
      bounded(currentEmbeddings, 8);
      const currentRuntime = await client.system.getLMStudioVersion();
      guard();
      reason = 'metadata';
      const handles = (values: LoadedModel[]) =>
        values
          .map((model) => ({
            modelKey: model.modelKey,
            instanceReference: model.instanceReference,
            sizeBytes: model.sizeBytes,
          }))
          .sort((left, right) => left.instanceReference.localeCompare(right.instanceReference));
      if (
        currentRuntime.version !== runtime.version ||
        currentRuntime.build !== runtime.build ||
        hashCanonical(handles(currentModels)) !== hashCanonical(handles(models)) ||
        currentEmbeddings.length !== embeddings.length
      )
        throw new Error();
      guard();
      const value = {
        version: 1 as const,
        runtime,
        models: [...choices.values()].sort((left, right) =>
          left.selectionId.localeCompare(right.selectionId),
        ),
        residentLlms: models.length,
        embeddingInstances: embeddings.length,
      };
      reason = 'limit';
      if (Buffer.byteLength(JSON.stringify(value)) + 128 > 131072) throw new Error();
      reason = 'metadata';
      return {
        kind: 'observed',
        observation: LocalModelObservationSchema.parse({
          ...value,
          observationHash: hashCanonical(value),
        }),
      };
    } catch {
      return { kind: 'unavailable', reason };
    }
  };
  let interrupt!: (reason: 'deadline' | 'stopped') => void;
  const interrupted = new Promise<LocalDiscoveryResult>((resolve) => {
    interrupt = (reason) => {
      interruption ??= reason;
      resolve({ kind: 'unavailable', reason: interruption });
    };
  });
  const schedule =
    options.schedule ??
    ((callback, delay) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    });
  const cancel = schedule(() => interrupt('deadline'), timeout);
  const abort = () => interrupt('stopped');
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    return await Promise.race([work(), interrupted]);
  } finally {
    interruption ??= 'stopped';
    cancel();
    options.signal?.removeEventListener('abort', abort);
  }
}
const fieldsSchema = z.object({
  fields: z.array(z.object({ key: z.string().max(200), value: z.unknown() })).max(256),
});
// Raw SDK configuration is unstable. Failure details must not copy its values.
class ConfigurationFailure extends Error {
  readonly detail: ConfigurationDetail;
  constructor(
    check: ConfigurationDetail['check'],
    status: ConfigurationDetail['status'],
    stage: ConfigurationDetail['stage'] = 'terminal',
  ) {
    super('The Local configuration proof is unavailable.');
    this.detail = { version: 1, stage, check, status };
  }
}
function configurationValue<T>(
  value: unknown,
  check: ConfigurationDetail['check'],
  schema: z.ZodType<T>,
  matches: (value: T) => boolean,
) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ConfigurationFailure(check, 'malformed');
  if (!matches(parsed.data)) throw new ConfigurationFailure(check, 'mismatch');
}
function configurationField<T>(
  config: unknown,
  section: 'load-fields' | 'prediction-fields',
  key: string,
  check: ConfigurationDetail['check'],
  schema: z.ZodType<T>,
  matches: (value: T) => boolean,
  defaultValue?: T,
) {
  const parsed = fieldsSchema.safeParse(config);
  if (!parsed.success) throw new ConfigurationFailure(section, 'malformed');
  const fields = parsed.data.fields;
  if (new Set(fields.map((item) => item.key)).size !== fields.length)
    throw new ConfigurationFailure(section, 'duplicate');
  const entry = fields.find((item) => item.key === key);
  if (!entry && defaultValue === undefined) throw new ConfigurationFailure(check, 'missing');
  configurationValue(entry ? entry.value : defaultValue, check, schema, matches);
}

function sameModel(plan: LocalStart, value: unknown) {
  const info = infoSchema.parse(value);
  if (
    info.modelKey !== plan.binding.modelKey ||
    info.instanceReference !== plan.binding.instanceReference ||
    info.sizeBytes !== plan.binding.modelSizeBytes
  )
    throw new Error();
  if ('version' in plan.binding) {
    const metadata = metadataSchema.parse(value);
    if (
      metadataIdentity(metadata).metadataHash !== plan.binding.metadataHash ||
      metadata.format !== plan.binding.format
    )
      throw new Error();
  } else if (info.format !== 'gguf') throw new Error();
}

/** A lost client cannot prove that the externally owned runtime stopped generating. */
export function startLocalPrediction(
  value: LocalStart,
  options: {
    createClient?: (plan: LocalStart) => LocalClient;
    now?: () => number;
    schedule?: Schedule;
    onSubmitted?: () => void | Promise<void>;
  } = {},
) {
  const plan = localPlan(value);
  const now = options.now ?? (() => performance.now());
  const began = now();
  if (!Number.isFinite(began)) throw new Error('The Local clock is invalid.');
  const deadline = began + plan.timeoutMs;
  let previous = began;
  const remaining = () => {
    const current = now();
    if (!Number.isFinite(current) || current < previous) return 0;
    previous = current;
    return Math.max(0, deadline - current);
  };
  const schedule =
    options.schedule ??
    ((work, delay) => {
      const timer = setTimeout(work, delay);
      return () => clearTimeout(timer);
    });
  let submitted = false,
    stopping = false,
    settled = false,
    cancelSent = false;
  let refusal: LocalReason | null = null;
  let prediction: ReturnType<LoadedModel['complete']> | null = null;
  let outputBytes = 0,
    promptTokens = 0;
  const timers: Array<() => void> = [];
  let resolveResult!: (value: LocalTerminal) => void;
  const result = new Promise<LocalTerminal>((resolve) => {
    resolveResult = resolve;
  });
  const finish = (terminal: LocalTerminal) => {
    if (settled) return;
    settled = true;
    for (const cancel of timers) cancel();
    resolveResult(terminal);
  };
  const fail = (reason: LocalReason, detail?: ConfigurationDetail) =>
    finish(
      submitted
        ? { kind: 'unknown', binding: plan.binding, reason, ...(detail ? { detail } : {}) }
        : {
            kind: 'failed',
            binding: plan.binding,
            reason,
            proof: null,
            ...(detail ? { detail } : {}),
          },
    );
  const cancel = () => {
    if (!prediction || cancelSent || settled) return;
    cancelSent = true;
    try {
      void prediction.cancel().catch(() => fail('transport'));
    } catch {
      fail('transport');
    }
  };
  const stop = (reason: LocalReason = 'stopped') => {
    if (settled || stopping) return;
    stopping = true;
    refusal ??= reason;
    if (!submitted) return fail(reason);
    cancel();
    timers.push(schedule(() => fail(reason), Math.min(CLEANUP_MS, remaining())));
  };
  const guard = () => {
    if (settled) throw new Error();
    if (remaining() <= CLEANUP_MS) {
      stop('deadline');
      throw new Error();
    }
  };
  timers.push(schedule(() => stop('deadline'), plan.timeoutMs - CLEANUP_MS));
  void (async () => {
    let stage: LocalReason = 'identity';
    try {
      guard();
      const client = (options.createClient ?? createLocalClient)(plan);
      const runtimeMatches = async () => {
        if (!('version' in plan.binding)) return;
        if (!client.system) throw new Error();
        const runtime = LocalRuntimeIdentitySchema.parse({
          connectorId: 'local-sdk-v1',
          ...(await client.system.getLMStudioVersion()),
        });
        guard();
        if (
          runtime.version !== plan.binding.runtimeVersion ||
          runtime.build !== plan.binding.runtimeBuild
        )
          throw new Error();
      };
      await runtimeMatches();
      guard();
      const models = await client.llm.listLoaded();
      guard();
      const embeddings = await client.embedding.listLoaded();
      guard();
      if (models.length !== 1 || embeddings.length !== 0) throw new Error();
      const model = models[0];
      if (
        model.modelKey !== plan.binding.modelKey ||
        model.instanceReference !== plan.binding.instanceReference ||
        model.sizeBytes !== plan.binding.modelSizeBytes
      )
        throw new Error();
      sameModel(plan, await model.getModelInfo());
      guard();
      const state = await model.getInstanceProcessingState();
      guard();
      if (state.status !== 'idle' || state.queued !== 0) throw new Error();
      stage = 'configuration';
      const base = await model.getBasePredictionConfig();
      guard();
      const baseConfig = z.object({ draftModel: z.string() }).safeParse(base);
      if (!baseConfig.success)
        throw new ConfigurationFailure(
          'base-draft',
          base && typeof base === 'object' && !('draftModel' in base) ? 'missing' : 'malformed',
          'base',
        );
      if (baseConfig.data.draftModel !== '')
        throw new ConfigurationFailure('base-draft', 'mismatch', 'base');
      stage = 'context';
      const rendered = await model.applyPromptTemplate(localChat(plan));
      guard();
      if (!rendered.isWellFormed() || Buffer.byteLength(rendered) > MAX_STREAM_BYTES)
        throw new Error();
      const tokens = await model.tokenize(rendered);
      guard();
      if (
        !tokens.length ||
        tokens.some((token) => !Number.isSafeInteger(token) || token < 0) ||
        tokens.length + OUTPUT_TOKENS > CONTEXT_TOKENS
      )
        throw new Error();
      promptTokens = tokens.length;
      sameModel(plan, await model.getModelInfo());
      guard();
      stage = 'ownership';
      await options.onSubmitted?.();
      guard();
      if ('version' in plan.binding) {
        stage = 'identity';
        await runtimeMatches();
        const currentModels = await client.llm.listLoaded();
        guard();
        const currentEmbeddings = await client.embedding.listLoaded();
        guard();
        if (
          currentModels.length !== 1 ||
          currentEmbeddings.length !== 0 ||
          currentModels[0].instanceReference !== model.instanceReference
        )
          throw new Error();
        sameModel(plan, await model.getModelInfo());
        guard();
      }
      // Mark uncertainty before the SDK can open its prediction channel.
      submitted = true;
      stage = 'transport';
      prediction = model.complete(rendered, {
        maxTokens: OUTPUT_TOKENS,
        contextOverflowPolicy: 'stopAtLimit',
        draftModel: '',
        stopStrings: [],
        onPredictionFragment: ({ content }) => {
          if (settled) return;
          outputBytes += Buffer.byteLength(content);
          if (!content.isWellFormed() || outputBytes > MAX_STREAM_BYTES) stop('limit');
        },
      });
      if (stopping) cancel();
      const terminal = await prediction.result();
      if (settled) return;
      if (remaining() <= 0) return fail('deadline');
      stage = 'identity';
      sameModel(plan, terminal.modelInfo);
      stage = 'configuration';
      configurationField(
        terminal.loadConfig,
        'load-fields',
        'llm.load.contextLength',
        'context-length',
        z.number().int().positive().safe(),
        (value) => value === CONTEXT_TOKENS,
      );
      configurationField(
        terminal.predictionConfig,
        'prediction-fields',
        'llm.prediction.contextOverflowPolicy',
        'overflow-policy',
        z.enum(['stopAtLimit', 'truncateMiddle', 'rollingWindow']),
        (value) => value === 'stopAtLimit',
      );
      // Engine protocol removes prediction-time draft keys. Its loaded configuration owns drafting.
      // SDK 2.1 defines absent load selectors as false and the absent draft model as empty.
      const draftFlags = [
        'draftMtp',
        'draftSimple',
        'draftDflashSidecar',
        'draftDsparkSidecar',
        'draftMtpSidecar',
      ];
      const draftFields = new Set([
        ...draftFlags,
        'draftModel',
        'draftMaxTokens',
        'draftMinTokens',
        'draftMinContinueProbability',
      ]);
      const draftPrefix = 'llm.load.speculativeDecoding.';
      if (
        terminal.loadConfig.fields.some(
          ({ key }) =>
            key.startsWith(draftPrefix) && !draftFields.has(key.slice(draftPrefix.length)),
        )
      )
        throw new ConfigurationFailure('load-draft-disabled', 'mismatch');
      for (const key of draftFlags)
        configurationField(
          terminal.loadConfig,
          'load-fields',
          draftPrefix + key,
          'load-draft-disabled',
          z.boolean(),
          (value) => !value,
          false,
        );
      configurationField(
        terminal.loadConfig,
        'load-fields',
        `${draftPrefix}draftModel`,
        'load-draft-disabled',
        z.string(),
        (value) => value === '',
        '',
      );
      configurationField(
        terminal.predictionConfig,
        'prediction-fields',
        'llm.prediction.speculativeDecoding.draftModel',
        'draft-disabled',
        z.string(),
        (value) => value === '',
        '',
      );
      const draftCount = z.number().int().nonnegative().safe().optional();
      configurationValue(
        terminal.stats,
        'draft-stats',
        z.object({
          usedDraftModelKey: z.string().optional(),
          totalDraftTokensCount: draftCount,
          acceptedDraftTokensCount: draftCount,
          rejectedDraftTokensCount: draftCount,
          ignoredDraftTokensCount: draftCount,
        }),
        (value) =>
          (value.usedDraftModelKey === undefined || value.usedDraftModelKey === '') &&
          Object.entries(value).every(
            ([key, count]) => key === 'usedDraftModelKey' || count === undefined || count === 0,
          ),
      );
      configurationValue(
        terminal.roundIndex,
        'round-index',
        z.number().int().nonnegative().safe(),
        (value) => value === 0,
      );
      configurationField(
        terminal.predictionConfig,
        'prediction-fields',
        'llm.prediction.maxPredictedTokens',
        'max-tokens',
        z.object({ checked: z.boolean(), value: z.number().int().positive().safe() }),
        (value) => value.checked && value.value === OUTPUT_TOKENS,
      );
      stage = 'protocol';
      if (
        !terminal.content.isWellFormed() ||
        !terminal.nonReasoningContent.isWellFormed() ||
        Buffer.byteLength(terminal.nonReasoningContent) > MAX_STREAM_BYTES ||
        Buffer.byteLength(terminal.content) > MAX_STREAM_BYTES
      )
        throw new Error();
      outputBytes = Math.max(outputBytes, Buffer.byteLength(terminal.content));
      const proof = ProofSchema.parse({
        stopReason: terminal.stats.stopReason,
        promptTokens: terminal.stats.promptTokensCount ?? null,
        predictedTokens: terminal.stats.predictedTokensCount ?? null,
        renderedPromptTokens: promptTokens,
        outputBytes,
        contextLength: CONTEXT_TOKENS,
        maxTokens: OUTPUT_TOKENS,
        contextOverflowPolicy: 'stopAtLimit',
        draftModel: '',
      });
      if (
        (proof.promptTokens !== null && proof.promptTokens !== promptTokens) ||
        (proof.predictedTokens !== null && proof.predictedTokens > OUTPUT_TOKENS)
      )
        throw new Error();
      if (proof.stopReason === 'userStopped' && stopping && refusal === 'stopped')
        return finish({ kind: 'stopped', binding: plan.binding, proof });
      if (refusal && refusal !== 'stopped')
        return finish({ kind: 'failed', binding: plan.binding, reason: refusal, proof });
      if (proof.stopReason !== 'eosFound')
        return finish({ kind: 'failed', binding: plan.binding, reason: 'protocol', proof });
      const proposal = ProposalSchema.parse(JSON.parse(terminal.nonReasoningContent));
      if (
        proposal.attemptId !== plan.binding.attemptId ||
        proposal.path !== plan.binding.path ||
        proposal.baseHash !== plan.binding.baseHash
      )
        throw new Error();
      finish({ kind: 'completed', binding: plan.binding, proof, proposal });
    } catch (error) {
      fail(stage, error instanceof ConfigurationFailure ? error.detail : undefined);
    }
  })();
  return { result, stop: () => stop() };
}
