import { LMStudioClient } from '@lmstudio/sdk';
import { silentLogger } from './sdk.ts';

// The chat adapter needs a loaded model handle. The controller holds the loopback endpoint and
// the memory-only token, so the runtime client lives here beside the rest of the Local code.
export async function connectLocalModel(input: {
  endpoint: string;
  token: string | null;
  model: string;
}) {
  const runtime = new LMStudioClient({
    baseUrl: input.endpoint,
    ...(input.token === null ? {} : { apiToken: input.token }),
    verboseErrorMessages: false,
    logger: silentLogger,
  });
  const loaded = await runtime.llm.listLoaded();
  const model =
    loaded.find((value) => value.modelKey === input.model) ??
    loaded.find((value) => value.identifier === input.model) ??
    loaded[0];
  if (!model) throw Error('No model is loaded in the Local app.');
  return { model, contextLength: await model.getContextLength(), modelKey: model.modelKey };
}
