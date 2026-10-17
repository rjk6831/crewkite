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
  type LocalReason,
  type LocalStart,
  type LocalTerminal,
  localChat,
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
};
export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
export const createLocalClient = (plan: LocalStart) =>
  new LMStudioClient({
    baseUrl: plan.endpoint,
    apiToken: plan.token,
    verboseErrorMessages: false,
    logger: silentLogger,
  });
const infoSchema = z.object({
  type: z.literal('llm'),
  modelKey: z.string(),
  instanceReference: z.string(),
  sizeBytes: z.number().int().positive().safe(),
  format: z.literal('gguf'),
  deviceIdentifier: z.null(),
  contextLength: z.literal(CONTEXT_TOKENS),
});
const fieldsSchema = z.object({
  fields: z.array(z.object({ key: z.string().max(200), value: z.unknown() })).max(256),
});
function field(config: unknown, key: string) {
  const fields = fieldsSchema.parse(config).fields;
  if (new Set(fields.map((item) => item.key)).size !== fields.length) throw new Error();
  const entry = fields.find((item) => item.key === key);
  if (!entry) throw new Error();
  return entry.value;
}
function sameModel(plan: LocalStart, value: unknown) {
  const info = infoSchema.parse(value);
  if (
    info.modelKey !== plan.binding.modelKey ||
    info.instanceReference !== plan.binding.instanceReference ||
    info.sizeBytes !== plan.binding.modelSizeBytes
  )
    throw new Error();
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
  const fail = (reason: LocalReason) =>
    finish(
      submitted
        ? { kind: 'unknown', binding: plan.binding, reason }
        : { kind: 'failed', binding: plan.binding, reason, proof: null },
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
      if (base.draftModel !== '') throw new Error();
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
      if (
        field(terminal.loadConfig, 'llm.load.contextLength') !== CONTEXT_TOKENS ||
        field(terminal.predictionConfig, 'llm.prediction.contextOverflowPolicy') !==
          'stopAtLimit' ||
        field(terminal.predictionConfig, 'llm.prediction.speculativeDecoding.draftModel') !== '' ||
        terminal.roundIndex !== 0
      )
        throw new Error();
      z.object({ checked: z.literal(true), value: z.literal(OUTPUT_TOKENS) }).parse(
        field(terminal.predictionConfig, 'llm.prediction.maxPredictedTokens'),
      );
      stage = 'protocol';
      if (
        !terminal.content.isWellFormed() ||
        !terminal.nonReasoningContent.isWellFormed() ||
        Buffer.byteLength(terminal.nonReasoningContent) > MAX_STREAM_BYTES ||
        Buffer.byteLength(terminal.content) > MAX_STREAM_BYTES ||
        terminal.stats.usedDraftModelKey
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
    } catch {
      fail(stage);
    }
  })();
  return { result, stop: () => stop() };
}
