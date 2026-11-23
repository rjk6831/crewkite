import {
  type CommandResult,
  GOOGLE_RECOVERY_HOLD_COPY,
  type WorkspaceState,
} from '@crewkite/contracts';
import { useEffect, useRef, useState } from 'react';
import { operationName, recoveryLine, stuckHolds } from './settings/provider-evidence.ts';
import type { Workspace } from './source.ts';

// Recover can release a row whose group is gone, and with the person's consent an interrupted
// sign-in. For a number that still answers it runs the probe and the process table check again,
// which is what releases the row once a restart has freed the number.
const releasable = new Set([
  'recoverable',
  'authentication-needs-person',
  'owner-present',
  'owner-unconfirmed',
]);

const refusal = (result: CommandResult) =>
  result.outcome === 'stale-revision'
    ? 'The setup changed since this card read it. Press Recover again.'
    : (result.next ?? 'Recover could not run.');

/**
 * Guided recovery on the Google card. Recover and sign-in are separate steps with separate
 * results. Sign-in shows only when the setup itself says it is needed, so a browser opens only on
 * fresh evidence. The card's facts already state each hold, so this section holds Recover and its
 * result. The model read sits in the card's shared action row.
 */
export function GoogleRecovery({
  header,
  workspace,
}: {
  header: WorkspaceState;
  workspace: Workspace;
}) {
  const [busy, setBusy] = useState(false);
  const [released, setReleased] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const setup = header.googleAcpSetup;
  const stuck = stuckHolds(header);
  const offerRecover = stuck.some((row) => releasable.has(row.reason));
  const holdKey = stuck.map((row) => row.commandId).join(' ');
  const live = workspace.connection === 'connected' && !workspace.preview;
  // A result line describes the holds it answered. New holds make it stale.
  useEffect(() => {
    if (holdKey) setReleased(null);
  }, [holdKey]);
  if (!stuck.length && !released && setup?.state !== 'authentication-required') return null;

  async function recover() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await workspace.metadataCommand({
        command: 'RecoverGoogleMetadata',
        expectedRevision: setup?.revision ?? 0,
        payload: { consent: 'explicit' },
      });
      const done = result.outcome === 'applied' || result.outcome === 'already-applied';
      if (!done) setFailure(refusal(result));
      else if (result.data?.kind === 'google-metadata-recovery')
        setReleased(recoveryLine({ ...result.data, held: [] }));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The command could not be sent.');
    } finally {
      setBusy(false);
      // The Recover button goes away once nothing is left to release. Focus stays in the section.
      heading.current?.focus();
    }
  }

  return (
    <section className="st-block" aria-label="Google recovery">
      <div className="st-subhead">
        <h3 ref={heading} tabIndex={-1}>
          Recovery
        </h3>
      </div>
      <ol className="st-steps">
        {stuck.length > 0 && (
          <li>
            {stuck.map((row) => (
              <p key={row.commandId}>
                {operationName[row.operation]}: {GOOGLE_RECOVERY_HOLD_COPY[row.reason]}
              </p>
            ))}
            {offerRecover && (
              <div className="st-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={!live || busy}
                  onClick={() => void recover()}
                >
                  {busy ? 'Recovering…' : 'Recover'}
                </button>
              </div>
            )}
          </li>
        )}
        {released && (
          <li>
            <p role="status">{released}</p>
          </li>
        )}
        {setup?.state === 'authentication-required' && (
          <li>
            <p className="st-note">
              {setup.auth.status === 'unknown'
                ? 'The earlier sign-in is unconfirmed. Sign in again with Connect Google above.'
                : 'Google asks for sign-in. Use Connect Google above.'}
            </p>
          </li>
        )}
      </ol>
      {failure && <p role="status">{failure}</p>}
    </section>
  );
}
