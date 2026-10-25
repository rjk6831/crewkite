import { LMStudioClient } from '@lmstudio/sdk';
import { silentLogger } from './sdk.ts';

// The chat adapter needs a loaded model handle. The controller holds the loopback endpoint and
// the memory-only token, so the runtime client lives here beside the rest of the Local code.
// Each call opens one client for one turn. The caller disposes it when the turn ends.
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
  // The SDK throws when a client is disposed twice, so every caller shares one disposal.
  let disposal: Promise<void> | undefined;
  const dispose = () => {
    disposal ??= runtime[Symbol.asyncDispose]();
    return disposal;
  };
  try {
    const loaded = await runtime.llm.listLoaded();
    const requested =
      loaded.find((value) => value.modelKey === input.model) ??
      loaded.find((value) => value.identifier === input.model);
    const model = requested ?? loaded[0];
    if (!model) throw Error('No model is loaded in the Local app.');
    return {
      model,
      contextLength: await model.getContextLength(),
      modelKey: model.modelKey,
      // True when the asked-for model is not loaded and the first loaded one stands in.
      fellBack: requested === undefined,
      // What the runtime reports for the loaded model. Images go only to a model that says yes.
      vision: model.vision === true,
      // Uploaded images live until this client is disposed, which is the end of the turn.
      files: runtime.files,
      dispose,
    };
  } catch (error) {
    // No caller holds the client yet. Close it without waiting on a runtime that already failed.
    dispose().catch(() => {});
    throw error;
  }
}
