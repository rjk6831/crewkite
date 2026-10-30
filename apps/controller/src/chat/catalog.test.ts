import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnthropicNativeProfileSchema, LocalSetupSchema } from '@crewkite/contracts';
import { resolveAnthropicNativeProfile } from '../providers/anthropic/profile.ts';
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
const localSetup = (loaded: boolean, vision?: boolean) =>
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
    observation: loaded
      ? {
          ...observation,
          models: observation.models.map((model) => ({
            ...model,
            ...(vision === undefined ? {} : { vision }),
          })),
        }
      : null,
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
      'a cached observation that says the model takes images, before any connect',
      { googlePrompt: none, local: localSetup(true, true) },
      [],
      ['image/*', ...text],
    ],
    [
      'a Local model whose download list reports vision, with no connect reading',
      { local: localSetup(true, true) },
      null,
      ['image/*', ...text],
    ],
    [
      'a Local model whose download list reports none, over a connect reading that says vision',
      { local: localSetup(true, false), localVision: { modelKey: 'fixture-model', vision: true } },
      null,
      text,
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
    assert.deepEqual(
      catalog.families.map((entry) => [entry.family, entry.unlisted]),
      [
        ['openai', 'path'],
        ['anthropic', 'path'],
        ['google', 'path'],
        ['local', 'none'],
      ],
      label,
    );
  }
  // Delivery per file: native when the client lists the type, else what the family does with an
  // unlisted file, and no answer while the client has reported nothing.
  const matches = (accepts: readonly string[], type: string) =>
    accepts.some(
      (value) => value === '*/*' || value === type || value === `${type.split('/')[0]}/*`,
    );
  for (const [label, input, family, type, want] of [
    [
      'a listed type',
      { googlePrompt: { ...none, image: true }, local: localSetup(false) },
      'google',
      'image/png',
      'native',
    ],
    [
      'any type embedded',
      { googlePrompt: { ...none, embeddedContext: true }, local: localSetup(false) },
      'google',
      'video/mp4',
      'native',
    ],
    [
      'an unlisted type reaches Google by link',
      { googlePrompt: { ...none, image: true }, local: localSetup(false) },
      'google',
      'video/mp4',
      'path',
    ],
    ['Local inlines text', { local: localSetup(true) }, 'local', 'text/plain', 'native'],
    ['Local takes no video', { local: localSetup(true) }, 'local', 'video/mp4', 'none'],
    ['nothing reported yet', { local: localSetup(false) }, 'google', 'video/mp4', null],
  ] as const) {
    const catalog = buildChatCatalog({
      profiles: [],
      openAiModels: null,
      windows: [],
      nowMs: Date.parse('2026-10-25T12:00:00.000Z'),
      ...(input as Pick<ChatCatalogInput, 'local'>),
    });
    const entry = catalog.families.find((value) => value.family === family);
    const got = !entry?.accepts ? null : matches(entry.accepts, type) ? 'native' : entry.unlisted;
    assert.equal(got, want, label);
  }
});

test('a writer profile build mismatch no longer disconnects chat when the chat client accepts the build', () => {
  const writer = AnthropicNativeProfileSchema.parse(resolveAnthropicNativeProfile({}).facts);
  const mismatch = AnthropicNativeProfileSchema.parse({
    ...writer,
    available: false,
    reason: 'client-build-mismatch',
  });
  const status = (state: 'newer' | 'older', accepted: boolean) => ({
    state,
    accepted,
    version: state === 'newer' ? '9.9.9' : '0.0.1',
    tested: '1.0.0',
    minimum: '0.5.0',
    message: `fixture ${state}`,
  });
  const newer = {
    status: status('newer', true),
    profile: {
      facts: AnthropicNativeProfileSchema.parse({
        ...writer,
        clientVersion: '9.9.9',
        available: true,
        reason: 'qualification-pending',
      }),
      client: { executable: '/usr/local/bin/fixture', sha256: 'a'.repeat(64), version: '9.9.9' },
    },
  };
  const read = (clients: ChatCatalogInput['clients']) =>
    buildChatCatalog({
      profiles: [mismatch],
      clients,
      openAiModels: null,
      local: localSetup(false),
      windows: [],
      nowMs: Date.parse('2026-10-31T12:00:00.000Z'),
    }).families.find((entry) => entry.family === 'anthropic');
  for (const [label, clients, connected, reason, message] of [
    ['newer build', { anthropic: newer }, true, null, 'fixture newer'],
    [
      'older build',
      { anthropic: { status: status('older', false) } },
      false,
      'client-version-unsupported',
      'fixture older',
    ],
    ['no chat resolver', undefined, false, 'client-build-mismatch', undefined],
  ] satisfies [string, ChatCatalogInput['clients'], boolean, string | null, string | undefined][]) {
    const entry = read(clients);
    assert.equal(entry?.connected, connected, label);
    assert.equal(entry?.reason, reason, label);
    assert.equal(entry?.client?.message, message, label);
  }
});
