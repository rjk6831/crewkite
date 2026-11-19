import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { LocalModelObservationSchema } from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import type { ChatInput, LLMActionOpts, Tool } from '@lmstudio/sdk';
import type { z } from 'zod';
import type { LoadedModelLike, LocalConnect } from './chat.ts';

// Local over any OpenAI-compatible server: Ollama, llama.cpp, vLLM and LM Studio's own /v1 routes.
// The server lists models at /v1/models and answers /v1/chat/completions. It reports no tokenizer
// and rarely the window it runs with, so the numbers here are estimates and the card says so.
// No key is sent: these servers run on this machine or the local network without one.

type Fetch = typeof fetch;
type Observation = z.output<typeof LocalModelObservationSchema>;

/** The window assumed when the server reports none. It is Ollama's default, the smallest in use. */
const DEFAULT_CONTEXT = 4096;
// The observation holds at most eight loaded instances, so only the first eight models are offered
// as ready. Any more are listed as not loaded.
const READY_MODELS = 8;
const LISTED_MODELS = 64;
const READ_MS = 5000;
// The chat schema bounds an observation at 128 KiB. A model id is cut well inside that.
const ID_BYTES = 200;

const RUNTIME = { connectorId: 'local-sdk-v1', version: 'OpenAI-compatible', build: 0 } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

async function getJson(endpoint: string, path: string, fetcher: Fetch, signal: AbortSignal) {
  const response = await fetcher(`${endpoint}${path}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(READ_MS)]),
    redirect: 'error',
  });
  if (!response.ok) throw Error(`The server answered ${response.status} for ${path}.`);
  return (await response.json()) as unknown;
}

/** Every address a host name resolves to. Tests pass their own. */
export type Resolve = (host: string) => Promise<string[]>;
const systemResolve: Resolve = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

// This computer and the private ranges the endpoint contract takes as written addresses.
const LOCAL_RANGES = new BlockList();
for (const [address, prefix, type] of [
  ['127.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
] as const)
  LOCAL_RANGES.addSubnet(address, prefix, type);

export const OUTSIDE_LOCAL_NETWORK =
  'The endpoint resolves to an address outside this computer and the local network, so Local did not connect.';

/**
 * Refuse an endpoint whose host is not on this computer or the local network. The contract takes
 * `localhost` and `.local` names as written, and a name can resolve anywhere, so each address it
 * resolves to has to be local before the first request goes out.
 */
async function assertLocalHost(endpoint: string, resolve: Resolve) {
  const host = new URL(endpoint).hostname.replace(/^\[(.*)\]$/, '$1');
  const addresses = isIP(host) ? [host] : await resolve(host);
  const local = (address: string) => {
    const family = isIP(address);
    return family !== 0 && LOCAL_RANGES.check(address, family === 6 ? 'ipv6' : 'ipv4');
  };
  if (!addresses.length || !addresses.every(local)) throw Error(OUTSIDE_LOCAL_NETWORK);
}

/**
 * The models the server lists, each with the window it reports for that model, if any. Connect,
 * Refresh and each turn list them first, so the host is checked there.
 */
export async function listOpenAiModels(
  endpoint: string,
  fetcher: Fetch = fetch,
  signal: AbortSignal = new AbortController().signal,
  resolve: Resolve = systemResolve,
) {
  // shortcut: fetch resolves the name again for each request, so a name whose answer changes
  // after this check is not caught. Upgrade: send through an undici Agent whose connect lookup
  // returns the addresses checked here.
  await assertLocalHost(endpoint, resolve);
  const body = await getJson(endpoint, '/v1/models', fetcher, signal);
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : null;
  if (!data) throw Error('The server did not list models at /v1/models.');
  // llama.cpp reports the window it runs with here. Others have no such route.
  const props = await getJson(endpoint, '/props', fetcher, signal).catch(() => null);
  const shared = isRecord(props)
    ? positive(
        isRecord(props.default_generation_settings) ? props.default_generation_settings.n_ctx : 0,
      )
    : null;
  const seen = new Set<string>();
  const models: { id: string; size: number; context: number }[] = [];
  for (const entry of data) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue;
    const id = entry.id;
    if (!id || id !== id.trim() || Buffer.byteLength(id) > ID_BYTES || seen.has(id)) continue;
    if (/\p{Cc}/u.test(id) || !id.isWellFormed()) continue;
    seen.add(id);
    const meta = isRecord(entry.meta) ? entry.meta : {};
    models.push({
      id,
      size: positive(meta.size) ?? 1,
      context:
        positive(entry.max_model_len) ??
        positive(entry.context_length) ??
        positive(meta.n_ctx) ??
        shared ??
        DEFAULT_CONTEXT,
    });
    if (models.length === LISTED_MODELS) break;
  }
  return models;
}

/** The same read in the shape the Local setup keeps, so the card and the picker work unchanged. */
export function openAiObservation(models: Awaited<ReturnType<typeof listOpenAiModels>>) {
  const choices = models.map((model, index) => {
    const metadataHash = hashCanonical({ id: model.id, size: model.size });
    const identity = {
      modelKey: model.id,
      displayName: model.id,
      // shortcut: the server does not name the file format, and Ollama and llama.cpp serve GGUF.
      // Upgrade: read it from /api/show or /props when the server offers it.
      format: 'gguf',
      sizeBytes: model.size,
      quantization: null,
      selectedVariant: null,
      metadataHash,
    };
    const ready = index < READY_MODELS;
    return {
      selectionId: hashCanonical({ runtime: RUNTIME, metadataHash }),
      identity,
      instanceReference: ready ? model.id : null,
      contextLength: ready ? model.context : null,
      state: ready ? ('loaded-eligible' as const) : ('installed-unloaded' as const),
      reasons: [],
      qualification: 'unqualified' as const,
    };
  });
  const base = {
    version: 1 as const,
    runtime: RUNTIME,
    models: choices,
    residentLlms: Math.min(models.length, READY_MODELS),
    embeddingInstances: 0,
  };
  return LocalModelObservationSchema.parse({ ...base, observationHash: hashCanonical(base) });
}

/** Read the server once. A server that answers but lists no model still connects. */
export async function readOpenAiObservation(
  endpoint: string,
  fetcher: Fetch = fetch,
  signal?: AbortSignal,
  resolve?: Resolve,
): Promise<Observation> {
  return openAiObservation(await listOpenAiModels(endpoint, fetcher, signal, resolve));
}

type Round = {
  content: string;
  reasoning: string;
  calls: { id: string; name: string; arguments: string }[];
  finish: string | null;
  promptTokens?: number;
  completionTokens?: number;
  firstTokenSec?: number;
};

const STOP_REASONS: Record<string, string> = {
  stop: 'eosFound',
  length: 'maxPredictedTokensReached',
  tool_calls: 'toolCalls',
  function_call: 'toolCalls',
};

/** Read one streamed chat completion, handing each text piece to `onText` as it arrives. */
async function streamRound(
  response: Response,
  onText: (kind: 'reasoning' | 'none', text: string) => void,
  began: number,
): Promise<Round> {
  const round: Round = { content: '', reasoning: '', calls: [], finish: null };
  if (!response.body) throw Error('The server sent no stream.');
  const decoder = new TextDecoder();
  let buffer = '';
  const take = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const event: unknown = JSON.parse(data);
    if (!isRecord(event)) return;
    if (isRecord(event.error)) throw Error(String(event.error.message ?? 'The server failed.'));
    if (isRecord(event.usage)) {
      round.promptTokens = positive(event.usage.prompt_tokens) ?? round.promptTokens;
      round.completionTokens = positive(event.usage.completion_tokens) ?? round.completionTokens;
    }
    const choice = Array.isArray(event.choices) ? event.choices[0] : null;
    if (!isRecord(choice)) return;
    if (typeof choice.finish_reason === 'string') round.finish = choice.finish_reason;
    const delta = isRecord(choice.delta) ? choice.delta : {};
    const thought = delta.reasoning_content ?? delta.reasoning;
    const first = () => {
      round.firstTokenSec ??= (Date.now() - began) / 1000;
    };
    if (typeof thought === 'string' && thought) {
      first();
      round.reasoning += thought;
      onText('reasoning', thought);
    }
    if (typeof delta.content === 'string' && delta.content) {
      first();
      round.content += delta.content;
      onText('none', delta.content);
    }
    if (Array.isArray(delta.tool_calls))
      for (const call of delta.tool_calls) {
        if (!isRecord(call)) continue;
        const index = typeof call.index === 'number' ? call.index : round.calls.length;
        round.calls[index] ??= { id: '', name: '', arguments: '' };
        const slot = round.calls[index];
        if (typeof call.id === 'string') slot.id = call.id;
        const fn = isRecord(call.function) ? call.function : {};
        if (typeof fn.name === 'string') slot.name += fn.name;
        if (typeof fn.arguments === 'string') slot.arguments += fn.arguments;
      }
  };
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      take(buffer.slice(0, end).trim());
      buffer = buffer.slice(end + 1);
    }
  }
  take(buffer.trim());
  round.calls = round.calls.filter(Boolean);
  return round;
}

type WireMessage = {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
};

/**
 * A loaded model over /v1/chat/completions. `act` keeps the contract of the LM Studio SDK's `act`
 * that the Local chat adapter relies on: rounds of streamed text, native tool calls that pass the
 * guard before they run, and a stats record for each round.
 */
export function openAiModel(
  endpoint: string,
  model: string,
  fetcher: Fetch = fetch,
): LoadedModelLike {
  return {
    // shortcut: no tokenizer route exists. Three bytes a token never undercounts text and code.
    // Upgrade: ask the server for a count where it offers one (llama.cpp POST /tokenize).
    countTokens: async (text) => Math.ceil(Buffer.byteLength(text) / 3),
    act: async (chat: ChatInput, tools: Tool[], options: LLMActionOpts) => {
      const messages: WireMessage[] = (Array.isArray(chat) ? chat : []).map((entry) => ({
        role: String(entry.role),
        content: typeof entry.content === 'string' ? entry.content : '',
      }));
      const definitions = tools.flatMap((tool) =>
        tool.type === 'rawFunction'
          ? [
              {
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parametersJsonSchema,
                },
              },
            ]
          : [],
      );
      const signal = options.signal ?? new AbortController().signal;
      const maxRounds = options.maxPredictionRounds ?? 1;
      let withTools = definitions.length > 0;
      // The chat adapter keys its tool cards by this number, so it counts across rounds.
      let callNumber = 0;
      for (let round = 0; round < maxRounds; round++) {
        // The last round has no tools, so the model must answer in text.
        const offer = withTools && round < maxRounds - 1;
        const began = Date.now();
        const request = (tooled: boolean) =>
          fetcher(`${endpoint}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model,
              messages,
              stream: true,
              stream_options: { include_usage: true },
              ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
              ...(tooled ? { tools: definitions } : {}),
            }),
            signal,
            redirect: 'error',
          });
        let response = await request(offer);
        // A model without tool support is refused with a 400. It is asked again as plain text, and
        // the adapter reads tool calls the model writes into its reply.
        if (response.status === 400 && offer) {
          const refusal = await response.text();
          if (!/tool/i.test(refusal))
            throw Error(`The server answered 400: ${refusal.slice(0, 500)}`);
          withTools = false;
          response = await request(false);
        }
        if (!response.ok)
          throw Error(
            `The server answered ${response.status}: ${(await response.text()).slice(0, 500)}`,
          );
        let streamed = 0;
        const result = await streamRound(
          response,
          (kind, text) => {
            streamed++;
            options.onPredictionFragment?.({
              content: text,
              // The server counts the round's tokens at its end. A piece stands for about one.
              tokensCount: 1,
              containsDrafted: false,
              reasoningType: kind === 'reasoning' ? 'reasoning' : 'none',
              isStructural: false,
              roundIndex: round,
            });
          },
          began,
        );
        const calls = result.calls.filter((call) => call.name);
        const assistantCalls = calls.map((call, index) => ({
          id: call.id || `call_${round}_${index}`,
          name: call.name,
          arguments: call.arguments,
        }));
        const asked = assistantCalls.map((call) => {
          let parsed: unknown;
          let error: Error | null = null;
          try {
            parsed = call.arguments.trim() ? JSON.parse(call.arguments) : {};
            if (!isRecord(parsed)) throw Error('The arguments are not a JSON object.');
          } catch (failure) {
            error = failure instanceof Error ? failure : Error('The arguments are not JSON.');
          }
          return { call, parsed: isRecord(parsed) ? parsed : {}, error };
        });
        const stopReason = calls.length
          ? 'toolCalls'
          : (STOP_REASONS[result.finish ?? ''] ?? 'failed');
        messages.push({
          role: 'assistant',
          content: result.content || null,
          ...(calls.length
            ? {
                tool_calls: assistantCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments || '{}' },
                })),
              }
            : {}),
        });
        const answers: { id: string; content: string }[] = [];
        for (const { call, parsed, error } of asked) {
          const callId = callNumber++;
          const request = {
            type: 'function' as const,
            id: call.id,
            name: call.name,
            arguments: parsed,
          };
          let answer: string;
          if (error) {
            // A handler that gives no answer leaves the error's own words, never the text of a
            // missing value.
            const handled = await options.handleInvalidToolRequest?.(error as never, request);
            answer = handled === undefined || handled === null ? '' : String(handled);
            answer ||= error.message;
          } else {
            const tool = tools.find((candidate) => candidate.name === call.name);
            if (!tool) {
              answer = `There is no tool named ${call.name}.`;
            } else {
              let denied: string | null = null;
              await options.guardToolCall?.(round, callId, {
                toolCallRequest: request,
                tool,
                allow: () => {},
                allowAndOverrideParameters: () => {},
                deny: (reason?: string) => {
                  denied = reason ?? 'The call was denied.';
                },
              } as never);
              answer =
                denied === null
                  ? String(
                      await tool.implementation(parsed, {
                        callId,
                        signal,
                        status: () => {},
                        warn: () => {},
                      } as never),
                    )
                  : denied;
            }
          }
          answers.push({ id: call.id, content: answer });
          messages.push({ role: 'tool', tool_call_id: call.id, content: answer });
        }
        options.onMessage?.({
          getRole: () => 'assistant',
          getText: () => result.content,
          getToolCallRequests: () =>
            assistantCalls.map((call, index) => ({
              name: call.name,
              arguments: asked[index].parsed,
            })),
          getToolCallResults: () => [],
        } as never);
        if (answers.length)
          options.onMessage?.({
            getRole: () => 'tool',
            getText: () => '',
            getToolCallRequests: () => [],
            getToolCallResults: () => answers.map((answer) => ({ content: answer.content })),
          } as never);
        options.onRoundEnd?.(round);
        const predicted = result.completionTokens ?? streamed;
        const seconds = (Date.now() - began) / 1000;
        options.onPredictionCompleted?.({
          nonReasoningContent: result.content,
          reasoningContent: result.reasoning,
          content: result.content,
          stats: {
            stopReason,
            ...(result.promptTokens === undefined
              ? {}
              : { promptTokensCount: result.promptTokens }),
            predictedTokensCount: predicted,
            ...(result.promptTokens === undefined
              ? {}
              : { totalTokensCount: result.promptTokens + predicted }),
            ...(result.firstTokenSec === undefined
              ? {}
              : { timeToFirstTokenSec: result.firstTokenSec }),
            ...(seconds > 0 ? { tokensPerSecond: predicted / seconds } : {}),
          },
        } as never);
        if (!calls.length) return;
      }
    },
  };
}

/**
 * Open a turn on an OpenAI-compatible endpoint. The model asked for is used when the server lists
 * it. Otherwise the first listed model answers and the adapter tells the person.
 */
export async function connectOpenAiModel(input: {
  endpoint: string;
  model: string;
  fetch?: Fetch;
  signal?: AbortSignal;
}): ReturnType<LocalConnect> {
  const fetcher = input.fetch ?? fetch;
  const listed = await listOpenAiModels(input.endpoint, fetcher, input.signal);
  const requested = listed.find((entry) => entry.id === input.model);
  const chosen = requested ?? listed[0];
  if (!chosen) throw Error('No model is loaded on the local server.');
  return {
    model: openAiModel(input.endpoint, chosen.id, fetcher),
    contextLength: chosen.context,
    // The server takes a thinking toggle at most, never a reasoning budget.
    reasoningBudget: false,
    modelKey: chosen.id,
    fellBack: requested === undefined,
    vision: false,
    files: {
      prepareImageBase64: async () => {
        throw Error('This endpoint takes no images.');
      },
    },
    dispose: async () => {},
  };
}
