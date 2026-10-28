import type { LocalHardwareStatus, Snapshot } from '@crewkite/contracts';

// Provider facts for the preview. Names are placeholders: the preview never names a real model.
// The numbers match the scripted catalog in thread/preview-data.ts so the picker, the rail strip and
// these cards tell one story.

const hash = (digit: string) => digit.repeat(64);

export function settingsPreview(routes: Snapshot['routes'], now: string) {
  const at = (minutes: number) => new Date(Date.parse(now) + minutes * 60_000).toISOString();
  const route = (family: string) => routes.filter((value) => value.family === family);
  const window = (
    family: 'openai' | 'anthropic',
    windowId: string,
    kind: 'rolling' | 'weekly',
    periodSeconds: number,
    left: number,
    resetMinutes: number,
    observedMinutes: number,
  ): Snapshot['usage'][number] => ({
    observation: {
      routeId: route(family)[0].id,
      windowId,
      kind,
      semantics: { scope: 'provider', periodSeconds },
      remaining: { value: left, unit: 'percent' },
      resetsAt: at(resetMinutes),
      observedAt: at(observedMinutes),
      source: 'fixture',
      confidence: 'reported',
    },
    state: 'fresh',
  });
  const client = {
    clientVersion: 'fixture-1',
    maximumTaskMs: 300000,
    maximumFileBytes: 65536,
    maximumSubmissions: 1,
  } as const;
  const choice = (key: string, name: string, digit: string, loaded: boolean) => ({
    selectionId: hash(digit),
    identity: {
      modelKey: key,
      displayName: name,
      format: 'gguf',
      sizeBytes: 16_000_000_000,
      quantization: { name: 'Q4_K_M', bits: 4 },
      selectedVariant: null,
      metadataHash: hash('2'),
    },
    instanceReference: loaded ? 'instance-1' : null,
    contextLength: loaded ? 8192 : null,
    state: loaded ? ('loaded-eligible' as const) : ('installed-unloaded' as const),
    reasons: [],
    qualification: 'unqualified' as const,
  });
  const snapshot: Pick<
    Snapshot,
    | 'routes'
    | 'usage'
    | 'usageReaders'
    | 'nativeProfiles'
    | 'nativeConnections'
    | 'googleAcpInstall'
    | 'googleAcpSetup'
    | 'localSetup'
  > = {
    // Google and Local have no usage route here, so their cards carry no empty gauge card.
    routes: [...route('openai'), ...route('anthropic')],
    usage: [
      window('openai', 'five-hour', 'rolling', 18_000, 0, 100, -2),
      window('openai', 'weekly', 'weekly', 604_800, 80, 2880, -2),
      window('anthropic', 'weekly', 'weekly', 604_800, 30, 120, 0),
    ],
    usageReaders: [
      {
        id: 'openai-usage-v1',
        family: 'openai',
        clientVersion: 'fixture-1',
        available: true,
        reason: 'available',
        readState: 'quiescent',
        readReason: 'observed',
        lastObservedAt: at(-2),
        lastAttemptAt: at(-2),
      },
      {
        id: 'anthropic-usage-v1',
        family: 'anthropic',
        clientVersion: 'fixture-1',
        available: true,
        reason: 'available',
        readState: 'quiescent',
        readReason: 'reported',
        trust: {
          scopeHash: hash('b'),
          clientSha256: hash('c'),
          command: '/usage',
          generationRequest: false,
          policyHooks: 'covered-by-native-client-trust',
          accepted: true,
        },
        reading: {
          source: 'native-local-command',
          status: 'reported',
          receivedAt: at(-30),
          observedAt: null,
          freshness: 'unknown',
          windows: [
            { windowId: 'five-hour', remaining: { value: 60, unit: 'percent' }, resetsAt: at(100) },
            { windowId: 'weekly', remaining: { value: 30, unit: 'percent' }, resetsAt: at(120) },
          ],
          extraUsage: null,
          model: null,
          modelTurns: 0,
          qualified: false,
        },
        readingScopeHash: hash('b'),
        operationId: null,
        lastObservedAt: null,
        lastAttemptAt: at(-30),
      },
      {
        id: 'google-usage-v1',
        family: 'google',
        clientVersion: 'fixture-1',
        available: false,
        reason: 'client-unavailable',
        lastObservedAt: null,
      },
    ],
    nativeProfiles: [
      {
        ...client,
        id: 'openai-file-v1',
        family: 'openai',
        displayName: 'OpenAI fixture',
        model: 'large-1',
        effort: 'low',
        accountClass: 'pro',
        serviceTier: 'default',
        qualifiedAt: '2026-10-01',
        creditPolicies: ['ordinary'],
        available: true,
        reason: 'available',
      },
      {
        ...client,
        id: 'anthropic-file-v1',
        family: 'anthropic',
        displayName: 'Anthropic fixture',
        model: 'large-2',
        effort: 'medium',
        effectiveEffort: 'unknown',
        accountClass: 'unknown',
        serviceTier: 'unknown',
        billingBasis: 'requires-user-attestation',
        qualifiedAt: null,
        creditPolicies: ['ordinary'],
        available: true,
        reason: 'available',
      },
      {
        ...client,
        id: 'google-file-v1',
        family: 'google',
        displayName: 'Google fixture',
        model: 'large-3',
        effort: 'low',
        effectiveEffort: 'unknown',
        accountClass: 'unknown',
        serviceTier: 'unknown',
        billingBasis: 'requires-user-attestation',
        qualifiedAt: null,
        creditPolicies: ['ordinary'],
        available: false,
        reason: 'client-unavailable',
        permissionModes: ['request-review', 'strict', 'always-proceed', 'proceed-in-sandbox'],
      },
    ],
    nativeConnections: [
      {
        family: 'anthropic',
        profileId: 'anthropic-file-v1',
        state: 'signed-in',
        authMethod: 'subscription',
        observedAt: at(-30),
        reason: null,
        next: 'Sign-in is current. No model prompt was sent.',
        billing: 'unknown',
        qualified: false,
        quota: 'unknown',
      },
    ],
    googleAcpInstall: {
      profileId: 'google-acp-v1',
      state: 'installed',
      operationId: null,
      observedAt: at(-1440),
      reason: null,
      next: 'The official client is installed.',
    },
    googleAcpSetup: {
      profileId: 'google-acp-v1',
      revision: 3,
      state: 'authentication-required',
      operationId: null,
      proofId: null,
      client: { version: 'fixture-1', sha256: hash('d'), signerTeamId: 'FIXTURETEAM' },
      auth: { method: 'oauth-personal', status: 'required' },
      reason: 'authentication-required',
      googleTerms: null,
    },
    localSetup: {
      revision: 5,
      connectionRevision: 2,
      connectorId: 'local-sdk-v1',
      endpoint: 'ws://127.0.0.1:1234',
      setupHash: hash('e'),
      connectionHash: hash('f'),
      secretConfigured: false,
      authMode: 'none',
      connected: true,
      operation: null,
      generation: 'idle',
      observation: {
        version: 1,
        runtime: { connectorId: 'local-sdk-v1', version: 'fixture-1', build: 1 },
        observationHash: hash('a'),
        models: [
          choice('local-27b', 'Local 27B', '1', true),
          choice('local-9b', 'Local 9B', '3', false),
        ],
        residentLlms: 1,
        embeddingInstances: 0,
      },
      selection: { selectionId: hash('1'), observationHash: hash('a') },
      reason: 'qualification-pending',
    },
  };
  const localHardware: LocalHardwareStatus = {
    cpuModel: 'Fixture CPU',
    logicalCores: 12,
    architecture: 'arm64',
    platform: 'darwin',
    totalMemoryBytes: 36 * 1024 ** 3,
    availableMemoryBytes: 18 * 1024 ** 3,
    sampledAt: now,
  };
  return { ...snapshot, localHardware };
}
