import {
  type ChatCatalogRead,
  type ChatThread,
  type CommandResult,
  type Snapshot,
  WRITING_RULES,
} from '@crewkite/contracts';

// Named Settings states for the browser preview. A `state` query parameter picks one.
// provider-stale, provider-blocked and provider-sign-in change the provider facts the cards read.
// rules-stale makes Write file refuse its preview the way the controller does once a rule or the
// file changed. setup-full, setup-partial and setup-empty set up the Project setup card: rules,
// notes and checks here, the design system in design/preview-design.ts and the recipes, loops and
// results in recipes/preview-recipes.ts. setup-empty turns every rule off. Every other state answers
// the writing rules as a fresh install would.

type Providers = Pick<
  Snapshot,
  'usage' | 'googleAcpSetup' | 'googleMetadataHolds' | 'nativeConnections'
>;
type Family = ChatCatalogRead['families'][number];

const command = `cmd_0${'7'.repeat(25)}`;
const at = (now: string, minutes: number) =>
  new Date(Date.parse(now) + minutes * 60_000).toISOString();

/** The provider facts a state changes. Null leaves the scripted ones. */
export function providerFacts(
  state: string | null,
  facts: Providers,
  now: string,
): Partial<Providers> | null {
  switch (state) {
    // The OpenAI reads are three hours old and the last Google model read failed.
    case 'provider-stale':
      return {
        usage: facts.usage.map((window) =>
          window.observation.routeId === facts.usage[0]?.observation.routeId
            ? {
                ...window,
                observation: { ...window.observation, observedAt: at(now, -180) },
                state: 'stale',
              }
            : window,
        ),
        googleAcpSetup: facts.googleAcpSetup && {
          ...facts.googleAcpSetup,
          state: 'ready',
          proofId: `art_0${'6'.repeat(25)}`,
          auth: { method: 'oauth-personal', status: 'authenticated' },
          reason: null,
          modelRefresh: {
            commandId: command,
            at: at(now, -25),
            outcome: 'failed',
            reason: 'acp-setup-timeout',
            evidenceId: null,
          },
        },
      };
    // An interrupted Google model read holds the gate. Its process is gone, so Recover can go.
    case 'provider-blocked':
      return {
        googleMetadataHolds: [
          { commandId: command, operation: 'acp-discover', reason: 'recoverable' },
        ],
      };
    // The Anthropic client reports no sign-in.
    case 'provider-sign-in':
      return {
        nativeConnections: facts.nativeConnections.map((connection) => ({
          ...connection,
          state: 'signed-out',
          authMethod: 'none',
          observedAt: at(now, -3),
          reason: 'not-logged-in',
          next: 'Sign in with the Anthropic client, then press Connect.',
        })),
      };
    default:
      return null;
  }
}

/** The catalog a provider state reads: Anthropic is not connected while it is signed out. */
export function providerCatalog(state: string | null, families: Family[]): Family[] {
  if (state !== 'provider-sign-in') return families;
  return families.map((entry) =>
    entry.family === 'anthropic' ? { ...entry, connected: false, reason: 'signed-out' } : entry,
  );
}

const check = (name: 'test' | 'lint' | 'typecheck', enabled: boolean) => ({
  id: `package.json:${name}`,
  label: name,
  kind: name,
  source: 'package.json' as const,
  command: `pnpm ${name}`,
  resolved: `pnpm ${name} runs ${name}: node scripts/${name}.mjs`,
  enabled,
  pin: enabled ? 'd'.repeat(64) : null,
});

/** The demo thread's checks in a setup- state: three on, two of three on, or none on. */
export function setupThread(state: string | null): Partial<ChatThread> | null {
  if (!state?.startsWith('setup-')) return null;
  const on = state === 'setup-full' ? 3 : state === 'setup-partial' ? 2 : 0;
  return {
    checks: {
      items: (['test', 'lint', 'typecheck'] as const).map((name, index) => check(name, index < on)),
      ask: null,
      approved: on > 0 ? 'e'.repeat(64) : null,
      runs: [],
      detectedAt: '2026-11-18T14:00:00.000Z',
    },
  };
}

/** The project notes a setup- state starts with. Only the full state has any. */
export const setupNotes = (state: string | null): string[] =>
  state === 'setup-full'
    ? ['Run pnpm test before every commit.', 'Prices are stored in cents.']
    : [];

/**
 * The writing rules and their export, answered in memory. The preview of AGENTS.md patches the
 * marked block of a short file, as the controller does for a file that has one.
 */
export function rulesPreview(state: string | null) {
  const switches = new Map<string, boolean>();
  const read = () => ({
    kind: 'writing-rules',
    rules: WRITING_RULES.map((rule) => ({
      id: rule.id,
      enabled:
        switches.get(rule.id) ??
        (state !== 'setup-empty' && rule.surface === 'settings' && rule.defaultEnabled),
      surface: rule.surface,
      text: rule.text,
      version: rule.version,
    })),
    digest: 'a'.repeat(64),
  });
  const preview = (destination: string) => {
    const rules = read().rules.filter((rule) => rule.enabled);
    const block = [
      '<!-- writing-rules:start -->',
      '## Writing rules',
      '',
      'The first rule restates the contribution ladder from Ponytail, which is MIT licensed. The pinned source and the notice are in docs/credits.md of the CrewKite repository.',
      '',
      ...rules.map((rule) => `- ${rule.text}`),
      '<!-- writing-rules:end -->',
    ].join('\n');
    const patch = destination === 'AGENTS.md';
    return {
      kind: 'writing-rules-export',
      destination,
      mode: patch ? 'patch' : 'new-file',
      preview: patch
        ? `# Agents\n\nKeep changes small and run the tests.\n\n${block}\n`
        : `${block}\n`,
      previewHash: 'b'.repeat(64),
      destinationIdentity: patch
        ? { exists: true, sha256: 'c'.repeat(64) }
        : { exists: false, sha256: null },
    };
  };
  return (name: string, payload: Record<string, unknown>): CommandResult | null => {
    switch (name) {
      case 'ReadWritingRules':
        return { outcome: 'applied', data: read() } as CommandResult;
      case 'SetWritingRule':
        switches.set(String(payload.ruleId), payload.enabled === true);
        return { outcome: 'applied' };
      case 'PreviewWritingRulesExport':
        return { outcome: 'applied', data: preview(String(payload.destination)) } as CommandResult;
      case 'ExportWritingRules':
        return state === 'rules-stale'
          ? {
              outcome: 'blocked',
              reason: 'export-preview-stale',
              next: 'The rules or the file changed since the preview. Preview again.',
            }
          : { outcome: 'applied' };
      default:
        return null;
    }
  };
}
