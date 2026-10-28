import {
  type CommandResult,
  GOOGLE_TERMS_CHECKBOX,
  GOOGLE_TERMS_SUMMARY,
  GOOGLE_TERMS_VERSION,
  googleTermsCurrent,
  type WorkspaceState,
} from '@crewkite/contracts';

export type GoogleGateDeps = {
  read: () => Promise<Pick<WorkspaceState, 'googleAcpSetup'>>;
  send: (command: string, payload: unknown) => Promise<CommandResult>;
  /** Shows the question and answers true only on an explicit yes. */
  ask: (question: string) => Promise<boolean>;
};

/**
 * The Google terms gate for the interactive CLI. It runs before a Google connection or the first
 * Google turn. A current acknowledgement passes at once. Otherwise it shows the same summary and
 * checkbox text as the desktop card and sends AcknowledgeGoogleTerms only on an explicit yes.
 * The controller refuses Google without it, so a false answer here only saves a round trip.
 */
export async function beforeGoogleConnection(deps: GoogleGateDeps): Promise<boolean> {
  const { googleAcpSetup } = await deps.read();
  if (googleTermsCurrent(googleAcpSetup?.googleTerms)) return true;
  const yes = await deps.ask(`${GOOGLE_TERMS_SUMMARY.join(' ')} ${GOOGLE_TERMS_CHECKBOX} (y/n)`);
  if (!yes) return false;
  const result = await deps.send('AcknowledgeGoogleTerms', { textVersion: GOOGLE_TERMS_VERSION });
  return result.outcome === 'applied' || result.outcome === 'already-applied';
}
