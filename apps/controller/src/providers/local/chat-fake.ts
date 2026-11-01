import type {
  ChatInput,
  ChatMessage,
  GuardToolCallController,
  LLMPredictionStats,
  PredictionResult,
  RawFunctionTool,
  Tool,
} from '@lmstudio/sdk';
import type { LoadedModelLike } from './chat.ts';

// A scripted LM Studio model for tests of the Local adapter and of the controller around it.
// Frames assumed from @lmstudio/sdk 2.1.0, `LLMDynamicHandle.act` and `internalAct` in
// dist/index.mjs. A live run against LM Studio confirms them.
// - onPredictionFragment({ roundIndex, content, tokensCount, containsDrafted, reasoningType,
//   isStructural }), reasoningType one of none, reasoning, reasoningStartTag, reasoningEndTag.
// - Each parsed tool call: guardToolCall(roundIndex, callId, controller) with
//   controller.toolCallRequest = { type: 'function', name, arguments }. The guard calls allow()
//   or deny(reason). An allowed call then runs tool.implementation(arguments, { callId, signal,
//   status, warn }), one call at a time.
// - onPredictionCompleted(result) once per round. result.stats carries stopReason,
//   promptTokensCount, predictedTokensCount, timeToFirstTokenSec and tokensPerSecond.
// - onRoundEnd(roundIndex) after the round's tool calls finish. Tool results start a new round.
// - Aborting options.signal sends `cancel` on the predict channel, and act rejects.

export const SUMMARY = 'Renaming n to count in src/a.ts was agreed.';
// `tokens` is the fragment's token count as the runtime reports it, one when left out.
export type Step =
  | { text: string; tokens?: number }
  | { reasoning: string; tokens?: number }
  | { call: string; args: Record<string, unknown> }
  | { wait: () => void };
export type Round = { steps: Step[]; stats: Partial<LLMPredictionStats> };

// The scripted rounds run across `act` calls, the way one model keeps answering a growing chat.
export function fakeModel(
  rounds: Round[],
  clock: { now: number },
  countTokens: (text: string) => number = (text) => Math.ceil(text.length / 4),
) {
  const calls: {
    chat: ChatInput;
    tools: Tool[];
    signal?: AbortSignal;
    maxTokens?: number | false;
    reasoningBudget?: number | false;
  }[] = [];
  let next = 0;
  let callId = 0;
  const model: LoadedModelLike = {
    countTokens: async (text) => countTokens(text),
    async act(chat, tools, options) {
      calls.push({
        chat,
        tools,
        signal: options.signal,
        maxTokens: options.maxTokens,
        reasoningBudget: options.reasoningBudget,
      });
      if (!tools.length) {
        const stats = { stopReason: 'eosFound' };
        options.onPredictionCompleted?.({
          nonReasoningContent: SUMMARY,
          stats,
        } as PredictionResult);
        return;
      }
      for (let roundIndex = 0; next < rounds.length; roundIndex++) {
        const round = rounds[next++];
        let content = '';
        let native = false;
        for (const step of round.steps) {
          options.signal?.throwIfAborted();
          if ('text' in step || 'reasoning' in step) {
            const fragment = 'text' in step ? step.text : step.reasoning;
            content += fragment;
            options.onPredictionFragment?.({
              roundIndex,
              content: fragment,
              reasoningType: 'text' in step ? 'none' : 'reasoning',
              tokensCount: step.tokens ?? 1,
              containsDrafted: false,
              isStructural: false,
            });
          } else if ('wait' in step)
            await new Promise((_, reject) => {
              options.signal?.addEventListener('abort', () => reject(new Error('cancelled')));
              step.wait();
            });
          else {
            native = true;
            const tool = tools.find((candidate) => candidate.name === step.call) as RawFunctionTool;
            const id = callId++;
            let allowed = false;
            await options.guardToolCall?.(roundIndex, id, {
              toolCallRequest: { type: 'function', name: step.call, arguments: step.args },
              tool,
              allow: () => {
                allowed = true;
              },
              deny: () => {},
            } as unknown as GuardToolCallController);
            if (allowed)
              await tool.implementation(step.args, {
                callId: id,
                signal: new AbortController().signal,
                status: () => {},
                warn: () => {},
              });
          }
        }
        clock.now += 1000;
        const stats = { stopReason: 'eosFound', ...round.stats };
        options.onPredictionCompleted?.({ stats } as PredictionResult);
        options.onMessage?.({
          getRole: () => 'assistant',
          getText: () => content,
          getToolCallRequests: () => [],
          getToolCallResults: () => [],
        } as unknown as ChatMessage);
        options.onRoundEnd?.(roundIndex);
        // The runtime ends `act` after a round without a native call.
        if (!native) return;
      }
    },
  };
  return { model, calls };
}
