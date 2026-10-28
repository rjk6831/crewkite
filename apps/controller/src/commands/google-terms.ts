import {
  type Command,
  type CommandResult,
  GOOGLE_TERMS_VERSION,
  GoogleAcpSetupSchema,
  googleTermsCurrent,
} from '@crewkite/contracts';
import type { Store } from '../store/index.ts';

// The Google gate (ADR 0002). A Google connection step runs only after the person acknowledged
// the current text. The acknowledgement lives in the Google setup record with its time and the
// text version, so a changed text asks again. A button, a prompt or a flag cannot stand in for it.

const GATED = new Set([
  'InstallGoogleAcp',
  'InitializeGoogleAcp',
  'AuthenticateGoogleAcp',
  'DiscoverGoogleAcp',
]);

/** Refuses a Google connection step until the current text is acknowledged. */
export function googleTermsGate(store: Store, command: Command): CommandResult | undefined {
  if (!GATED.has(command.command) || googleTermsCurrent(store.googleAcpSetup().googleTerms))
    return undefined;
  return {
    outcome: 'blocked',
    reason: 'google-terms-not-acknowledged',
    next: 'Read the Google terms summary in Settings and acknowledge it to connect Google.',
  };
}

/** Stores the acknowledgement. The text version must be the one this build shows. */
export function acknowledgeGoogleTerms(
  store: Store,
  textVersion: string,
  at: string,
): CommandResult {
  if (textVersion !== GOOGLE_TERMS_VERSION)
    return {
      outcome: 'blocked',
      reason: 'google-terms-version-changed',
      next: 'Read the current Google terms summary and acknowledge it again.',
    };
  const setup = store.googleAcpSetup();
  store.putGoogleAcpSetup(
    GoogleAcpSetupSchema.parse({ ...setup, googleTerms: { version: textVersion, at } }),
  );
  return { outcome: 'applied' };
}
