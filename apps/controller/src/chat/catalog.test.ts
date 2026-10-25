import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalSetupSchema } from '@crewkite/contracts';
import { LOCAL_TEXT_TYPES } from '../providers/local/chat.ts';
import { buildChatCatalog, type ChatCatalogInput } from './catalog.ts';

const text = [...LOCAL_TEXT_TYPES];
const observation = {
  version: 1,
  runtime: { connectorId: 'local-sdk-v1', version: 'fixture-version', build: 1 },
  observationHash: 'e'.repeat(64),
  models: [
    {
      selectionId: 'd'.repeat(64),
      identity: {
        modelKey: 'fixture-model',
        displayName: 'Fixture model',
        format: 'gguf',
        sizeBytes: 17,
        quantization: null,
        selectedVariant: null,
        metadataHash: 'c'.repeat(64),
      },
      instanceReference: 'fixture-instance',
      contextLength: 8192,
      state: 'loaded-eligible',
      reasons: [],
      qualification: 'unqualified',
    },
  ],
  residentLlms: 1,
  embeddingInstances: 0,
};
const localSetup = (loaded: boolean) =>
  LocalSetupSchema.parse({
    revision: 1,
    connectionRevision: 1,
    connectorId: 'local-sdk-v1',
    endpoint: 'ws://127.0.0.1:1234',
    setupHash: null,
    connectionHash: 'b'.repeat(64),
    secretConfigured: true,
    connected: true,
    operation: null,
    observation: loaded ? observation : null,
    selection: null,
    generation: 'idle',
    reason: null,
  });

test('the catalog reports the file types each client said it takes, and null before it said', () => {
  const none = { image: false, audio: false, embeddedContext: false };
  for (const [label, input, google, local] of [
    ['nothing observed yet', { local: localSetup(false) }, null, null],
    [
      'images only, and a Local model whose vision is unknown',
      { googlePrompt: { ...none, image: true }, local: localSetup(true) },
      ['image/*'],
      text,
    ],
    [
      'every block, and a Local model with vision',
      {
        googlePrompt: { image: true, audio: true, embeddedContext: true },
        local: localSetup(true),
        localVision: { modelKey: 'fixture-model', vision: true },
      },
      ['image/*', 'audio/*', '*/*'],
      ['image/*', ...text],
    ],
    [
      'no blocks, and vision reported for a model no longer loaded',
      {
        googlePrompt: none,
        local: localSetup(true),
        localVision: { modelKey: 'other-model', vision: true },
      },
      [],
      text,
    ],
  ] as const) {
    const catalog = buildChatCatalog({
      profiles: [],
      openAiModels: null,
      windows: [],
      nowMs: Date.parse('2026-10-25T12:00:00.000Z'),
      ...(input as Pick<ChatCatalogInput, 'local'>),
    });
    const accepts = (family: string) =>
      catalog.families.find((entry) => entry.family === family)?.accepts;
    assert.deepEqual(accepts('google'), google, label);
    assert.deepEqual(accepts('local'), local, label);
  }
});
