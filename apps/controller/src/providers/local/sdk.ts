import {
  type LocalModelChoiceSchema,
  LocalModelObservationSchema,
  LocalRuntimeIdentitySchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import {
  type ChatLike,
  type LLM,
  type LLMPredictionOpts,
  type LLMRespondOpts,
  LMStudioClient,
  type PredictionResult,
} from '@lmstudio/sdk';
import { z } from 'zod';
import type { Schedule } from '../../host/worker.ts';
import {
  CLEANUP_MS,
  type ConfigurationDetail,
  LOCAL_CODING_SAMPLING,
  type LocalDiscoveryStart,
  type LocalReason,
  type LocalStart,
  type LocalTerminal,
  localChat,
  localDiscoveryPlan,
  localOutputTokens,
  localPlan,
  localStructuredOutput,
  MAX_STREAM_BYTES,
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
  respond(
    chat: ChatLike,
    options: LLMRespondOpts,
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
  contextLength: z.number().int().positive().safe(),
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
  variants: z
    .array(identifier(200))
    .max(64)
    .refine((values) => new Set(values).size === values.length)
    .optional(),
});
const loadedMetadataSchema = metadataSchema.extend({
  instanceReference: identifier(200),
  contextLength: z.number().int().positive().safe(),
});
function metadataIdentity(value: z.output<typeof metadataSchema>) {
  if (
    value.selectedVariant !== undefined &&
    value.variants !== undefined &&
    !value.variants.includes(value.selectedVariant)
  )
    throw new Error();
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
        metadataIdentity(parent);
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
          if (parent.variants?.length && !parent.variants.includes(variant.modelKey))
            throw new Error();
          inventory.push(variant);
          if (inventory.length > 64) {
            reason = 'limit';
            throw new Error();
          }
        }
        if (parent.variants?.length && variants.length !== parent.variants.length) {
          reason = 'metadata';
          throw new Error();
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
      const catalogKeys = new Set<string>();
      for (const value of inventory) {
        reason = 'metadata';
        const identity = metadataIdentity(value);
        if (catalogKeys.has(value.modelKey)) throw new Error();
        catalogKeys.add(value.modelKey);
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
      const residents: {
        modelKey: string;
        instanceReference: string;
        sizeBytes: number;
        contextLength: number;
      }[] = [];
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
        residents.push({
          modelKey: info.modelKey,
          instanceReference: info.instanceReference,
          sizeBytes: info.sizeBytes,
          contextLength: info.contextLength,
        });
        const identity = metadataIdentity(info);
        let choice = choices.get(identity.metadataHash);
        const variant = inventory.find((value) => value.modelKey === info.selectedVariant);
        if (variant && !matched.has(identity.metadataHash)) {
          const variantIdentity = metadataIdentity(variant);
          if (variantIdentity.metadataHash !== identity.metadataHash) {
            // A selected variant proves presence only when its file metadata agrees.
            if (
              choice ||
              (info.modelKey !== variant.modelKey && catalogKeys.has(info.modelKey)) ||
              (variant.selectedVariant !== undefined &&
                variant.selectedVariant !== info.selectedVariant) ||
              variant.path !== info.path ||
              variant.format !== info.format ||
              variant.sizeBytes !== info.sizeBytes ||
              variant.deviceIdentifier !== info.deviceIdentifier ||
              variant.quantization?.name !== info.quantization?.name ||
              variant.quantization?.bits !== info.quantization?.bits
            )
              throw new Error();
            const installed = choices.get(variantIdentity.metadataHash);
            if (!installed || installed.instanceReference !== null) throw new Error();
            choice = {
              ...installed,
              selectionId: hashCanonical({ runtime, metadataHash: identity.metadataHash }),
              identity,
            };
            choices.delete(variantIdentity.metadataHash);
            choices.set(identity.metadataHash, choice);
          }
        }
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
        // Other residents, embeddings included, and the context size never disqualify a choice.
        // A turn binds one instance reference, and every budget follows the context it reports.
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
        residents: residents.sort((left, right) =>
          left.instanceReference.localeCompare(right.instanceReference),
        ),
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

/** Returns the context the instance reports. Once read, a later read must report the same. */
function sameModel(plan: LocalStart, value: unknown, contextLength?: number) {
  const info = infoSchema.parse(value);
  if (
    info.modelKey !== plan.binding.modelKey ||
    info.instanceReference !== plan.binding.instanceReference ||
    info.sizeBytes !== plan.binding.modelSizeBytes ||
    (contextLength !== undefined && info.contextLength !== contextLength)
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
  return info.contextLength;
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
  const outputTokens = localOutputTokens(plan);
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
  let prediction: ReturnType<LoadedModel['respond']> | null = null;
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
      // The attempt binds one instance reference. Whatever else is resident stays out of it.
      const bound = (values: LoadedModel[]) =>
        values.filter((value) => value.instanceReference === plan.binding.instanceReference);
      const models = bound(await client.llm.listLoaded());
      guard();
      if (models.length !== 1) throw new Error();
      const model = models[0];
      if (
        model.modelKey !== plan.binding.modelKey ||
        model.sizeBytes !== plan.binding.modelSizeBytes
      )
        throw new Error();
      const contextLength = sameModel(plan, await model.getModelInfo());
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
      // Tests are optional context. When they push the prompt past its budget, the task and file
      // go without them, and the token proof covers the prompt that is actually sent.
      let rendered = '';
      let tokens: number[] = [];
      let selectedTests = plan.tests;
      for (const tests of plan.tests.length ? [plan.tests, []] : [plan.tests]) {
        selectedTests = tests;
        rendered = await model.applyPromptTemplate(localChat({ ...plan, tests }));
        guard();
        if (!rendered.isWellFormed() || Buffer.byteLength(rendered) > MAX_STREAM_BYTES)
          throw new Error();
        tokens = await model.tokenize(rendered);
        guard();
        if (!tokens.length || tokens.some((token) => !Number.isSafeInteger(token) || token < 0))
          throw new Error();
        if (tokens.length + outputTokens <= contextLength) break;
      }
      if (tokens.length + outputTokens > contextLength) throw new Error();
      promptTokens = tokens.length;
      sameModel(plan, await model.getModelInfo(), contextLength);
      guard();
      stage = 'ownership';
      await options.onSubmitted?.();
      guard();
      if ('version' in plan.binding) {
        stage = 'identity';
        await runtimeMatches();
        const currentModels = bound(await client.llm.listLoaded());
        guard();
        if (currentModels.length !== 1) throw new Error();
        sameModel(plan, await model.getModelInfo(), contextLength);
        guard();
      }
      // Mark uncertainty before the SDK can open its prediction channel.
      submitted = true;
      stage = 'transport';
      const structured = localStructuredOutput(plan.binding);
      const responseOptions: LLMRespondOpts = {
        maxTokens: outputTokens,
        reasoningBudget: 1536,
        ...LOCAL_CODING_SAMPLING,
        enableThinking: true,
        contextOverflowPolicy: 'stopAtLimit',
        draftModel: '',
        stopStrings: [],
        structured: structured.format,
        onPredictionFragment: ({ content }) => {
          if (settled) return;
          outputBytes += Buffer.byteLength(content);
          if (!content.isWellFormed() || outputBytes > MAX_STREAM_BYTES) stop('limit');
        },
      };
      prediction = model.respond(localChat({ ...plan, tests: selectedTests }), responseOptions);
      if (stopping) cancel();
      const terminal = await prediction.result();
      if (settled) return;
      if (remaining() <= 0) return fail('deadline');
      stage = 'identity';
      sameModel(plan, terminal.modelInfo, contextLength);
      stage = 'configuration';
      configurationField(
        terminal.loadConfig,
        'load-fields',
        'llm.load.contextLength',
        'context-length',
        z.number().int().positive().safe(),
        (value) => value === contextLength,
      );
      configurationField(
        terminal.predictionConfig,
        'prediction-fields',
        'llm.prediction.contextOverflowPolicy',
        'overflow-policy',
        z.enum(['stopAtLimit', 'truncateMiddle', 'rollingWindow']),
        (value) => value === 'stopAtLimit',
      );
      configurationField(
        terminal.predictionConfig,
        'prediction-fields',
        'llm.prediction.temperature',
        'temperature',
        z.number(),
        (value) => value === LOCAL_CODING_SAMPLING.temperature,
      );
      configurationField(
        terminal.predictionConfig,
        'prediction-fields',
        'llm.prediction.topKSampling',
        'top-k',
        z.number().int(),
        (value) => value === LOCAL_CODING_SAMPLING.topKSampling,
      );
      for (const [key, check, expected] of [
        ['topPSampling', 'top-p', LOCAL_CODING_SAMPLING.topPSampling],
        ['minPSampling', 'min-p', LOCAL_CODING_SAMPLING.minPSampling],
        ['repeatPenalty', 'repeat-penalty', LOCAL_CODING_SAMPLING.repeatPenalty],
        ['llama.presencePenalty', 'presence-penalty', LOCAL_CODING_SAMPLING.presencePenalty],
      ] as const)
        configurationField(
          terminal.predictionConfig,
          'prediction-fields',
          `llm.prediction.${key}`,
          check,
          z.object({ checked: z.boolean(), value: z.number() }),
          (value) => value.checked && value.value === expected,
        );
      configurationField(
        terminal.predictionConfig,
        'prediction-fields',
        'llm.prediction.reasoning.enableThinking',
        'reasoning-enabled',
        z.boolean(),
        (value) => value,
      );
      configurationField(
        terminal.predictionConfig,
        'prediction-fields',
        'llm.prediction.reasoning.budgetTokens',
        'reasoning-budget',
        z.object({ checked: z.boolean(), value: z.number().int().positive().safe() }),
        (value) => value.checked && value.value === 1536,
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
        (value) => value.checked && value.value === outputTokens,
      );
      configurationField(
        terminal.predictionConfig,
        'prediction-fields',
        'llm.prediction.structured',
        'structured-output',
        z.strictObject({ type: z.literal('json'), jsonSchema: z.record(z.string(), z.unknown()) }),
        (value) => hashCanonical(value.jsonSchema) === structured.schemaHash,
      );
      stage = 'protocol';
      if (
        !terminal.content.isWellFormed() ||
        !terminal.reasoningContent.isWellFormed() ||
        !terminal.nonReasoningContent.isWellFormed() ||
        Buffer.byteLength(terminal.reasoningContent) > MAX_STREAM_BYTES ||
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
        structured: {
          schemaHash: structured.schemaHash,
          reasoningBytes: Buffer.byteLength(terminal.reasoningContent),
          nonReasoningBytes: Buffer.byteLength(terminal.nonReasoningContent),
        },
        contextLength,
        maxTokens: outputTokens,
        contextOverflowPolicy: 'stopAtLimit',
        draftModel: '',
        sampling: LOCAL_CODING_SAMPLING,
      });
      if (
        proof.promptTokens === null ||
        proof.promptTokens + outputTokens > contextLength ||
        (proof.predictedTokens !== null && proof.predictedTokens > outputTokens)
      )
        throw new Error();
      if (proof.stopReason === 'userStopped' && stopping && refusal === 'stopped')
        return finish({ kind: 'stopped', binding: plan.binding, proof });
      if (refusal && refusal !== 'stopped')
        return finish({ kind: 'failed', binding: plan.binding, reason: refusal, proof });
      if (proof.stopReason === 'maxPredictedTokensReached')
        return finish({ kind: 'failed', binding: plan.binding, reason: 'limit', proof });
      if (proof.stopReason !== 'eosFound')
        return finish({ kind: 'failed', binding: plan.binding, reason: 'protocol', proof });
      let proposal: z.output<typeof ProposalSchema>;
      try {
        proposal = ProposalSchema.parse(JSON.parse(terminal.nonReasoningContent));
        if (
          proposal.attemptId !== plan.binding.attemptId ||
          proposal.path !== plan.binding.path ||
          proposal.baseHash !== plan.binding.baseHash
        )
          throw new Error();
        // Small models often drop the final line ending. Restore the original's so the candidate
        // differs only where the edit does. Parsing again keeps the content bound.
        const ending = /\r?\n$/.exec(plan.original)?.[0];
        if (ending && !proposal.content.endsWith('\n'))
          proposal = ProposalSchema.parse({ ...proposal, content: proposal.content + ending });
      } catch {
        return finish({ kind: 'failed', binding: plan.binding, reason: 'protocol', proof });
      }
      finish({ kind: 'completed', binding: plan.binding, proof, proposal });
    } catch (error) {
      fail(stage, error instanceof ConfigurationFailure ? error.detail : undefined);
    }
  })();
  return { result, stop: () => stop() };
}
