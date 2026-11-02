import type { ChatFamily, WorkspaceState } from '@crewkite/contracts';

// What each provider card says about connecting on this device. A provider connects once, by the
// person's click, and every later launch reconnects it with no click. A card asks again only when
// the provider's own credential ended, in one sentence from this table with a Connect button.

/** One sentence per provider for a credential that expired or was revoked. */
export const EXPIRED: Record<ChatFamily, string> = {
  openai: "CrewKite's Codex sign-in has expired or was signed out.",
  anthropic: 'The Claude Code sign-in on this device has expired or was signed out.',
  google: 'The Google sign-in has expired or was revoked.',
  local: 'LM Studio no longer accepts the saved token.',
};

export const LOCAL_NOT_RUNNING = 'LM Studio is not running. Local reconnects when it starts.';

const claudeCode = (version: string | null) => (version ? `Claude Code ${version}` : 'Claude Code');

export const CONNECT_COPY = {
  openaiFirst: 'CrewKite signs in to Codex in its own home. Your Codex app is not touched.',
  openaiWaiting: 'Finish the sign-in in your browser.',
  openaiFailed: 'The sign-in did not finish. Press Connect to try again.',
  openaiSignedIn: 'Signed in to Codex in CrewKite.',
  anthropicSignedIn: (version: string | null) =>
    `${claudeCode(version)} is signed in on this device.`,
  anthropicFound: (version: string | null) =>
    `${claudeCode(version)} is on this device. Connect checks its sign-in.`,
} as const;

export const connectedOnce = (header: WorkspaceState, family: ChatFamily) =>
  header.providerConnections?.connectedOnce.includes(family) ?? false;

/**
 * Which line a card shows, or null when it has nothing to say. Each provider's own credential
 * decides expiry: the Codex account read, the Claude Code sign-in check, the Google sign-in and
 * the saved Local token.
 */
export function connectState(
  header: WorkspaceState,
  family: ChatFamily,
): { line: string; action: 'connect' | 'sign-out' | 'cancel' | null } | null {
  const once = connectedOnce(header, family);
  if (family === 'openai') {
    const signIn = header.providerConnections?.openAiSignIn;
    if (signIn?.state === 'waiting') return { line: CONNECT_COPY.openaiWaiting, action: 'cancel' };
    if (signIn?.state === 'failed') return { line: CONNECT_COPY.openaiFailed, action: 'connect' };
    if (!once) return { line: CONNECT_COPY.openaiFirst, action: 'connect' };
    const reader = header.usageReaders.find((value) => value.family === 'openai');
    if (reader?.readReason === 'unsupported-account')
      return { line: EXPIRED.openai, action: 'connect' };
    return { line: CONNECT_COPY.openaiSignedIn, action: 'sign-out' };
  }
  if (family === 'anthropic') {
    const connection = header.nativeConnections.find((value) => value.family === 'anthropic');
    const version =
      header.usageReaders.find((value) => value.family === 'anthropic')?.client?.version ?? null;
    if (once)
      return connection?.state === 'signed-out'
        ? { line: EXPIRED.anthropic, action: 'connect' }
        : null;
    return connection?.state === 'signed-in'
      ? { line: CONNECT_COPY.anthropicSignedIn(version), action: 'connect' }
      : { line: CONNECT_COPY.anthropicFound(version), action: 'connect' };
  }
  if (family === 'google')
    return once && header.googleAcpSetup?.state === 'authentication-required'
      ? { line: EXPIRED.google, action: null }
      : null;
  const local = header.localSetup;
  if (!once || !local?.endpoint || local.connected) return null;
  return local.reason === 'connection-unavailable'
    ? { line: LOCAL_NOT_RUNNING, action: null }
    : null;
}
