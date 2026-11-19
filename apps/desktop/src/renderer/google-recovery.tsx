import {
  type CommandResult,
  GOOGLE_RECOVERY_HOLD_COPY,
  type WorkspaceState,
} from '@crewkite/contracts';
import { useEffect, useRef, useState } from 'react';
import { operationName, recoveryLine, stuckHolds } from './settings/provider-evidence.ts';
import type { Workspace } from './source.ts';

type Step = 'recover' | 'refresh';

// Recover can release a row whose group is gone, and with the person's consent an interrupted
// sign-in. It cannot release a row whose process may still run, so it is not offered for one.
const releasable = new Set(['recoverable', 'authentication-needs-person']);

const refusal = (result: CommandResult, step: Step) =>
  result.outcome === 'stale-revision'
    ? `The setup changed since this card read it. Press ${step === 'recover' ? 'Recover' : 'Read models again'} again.`
    : (result.next ??
      (step === 'recover' ? 'Recover could not run.' : 'The model read did not start.'));

/**
 * Guided recovery on the Google card. Recover, the model read and sign-in are separate steps with
 * separate results. Sign-in shows only when the setup itself says it is needed, so a browser
 * opens only on fresh evidence. The card's facts already state each hold and the last refresh,
 * so this section holds the actions and their results.
 */
export function GoogleRecovery({
  header,
  workspace,
}: {
  header: WorkspaceState;
  workspace: Workspace;
}) {
  const [busy, setBusy] = useState<Step | null>(null);
  const [released, setReleased] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const setup = header.googleAcpSetup;
  const stuck = stuckHolds(header);
  const offerRecover = stuck.some((row) => releasable.has(row.reason));
  const holdKey = stuck.map((row) => row.commandId).join(' ');
  const live = workspace.connection === 'connected' && !workspace.preview;
  const ready = setup?.state === 'ready' && !!setup.proofId;
  const refreshing = setup?.modelRefresh?.outcome === 'running';
  // A result line describes the holds it answered. New holds make it stale.
  useEffect(() => {
    if (holdKey) setReleased(null);
  }, [holdKey]);
  if (!stuck.length && !ready && !released && setup?.state !== 'authentication-required')
    return null;

  async function run(step: Step) {
    if (busy) return;
    setBusy(step);
    setFailure(null);
    try {
      const result =
        step === 'recover'
          ? await workspace.metadataCommand({
              command: 'RecoverGoogleMetadata',
              expectedRevision: setup?.revision ?? 0,
              payload: { consent: 'explicit' },
            })
          : await workspace.metadataCommand({
              command: 'RefreshGoogleAcpModels',
              expectedRevision: setup?.revision ?? 0,
              payload: {
                profileId: 'google-acp-v1',
                proofId: setup?.proofId ?? '',
                consent: 'explicit',
              },
            });
      const done = result.outcome === 'applied' || result.outcome === 'already-applied';
      if (!done) setFailure(refusal(result, step));
      else if (step === 'recover' && result.data?.kind === 'google-metadata-recovery')
        setReleased(recoveryLine({ ...result.data, held: [] }));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The command could not be sent.');
    } finally {
      setBusy(null);
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
                  disabled={!live || busy !== null}
                  onClick={() => void run('recover')}
                >
                  {busy === 'recover' ? 'Recovering…' : 'Recover'}
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
        {ready && (
          <li>
            <div className="st-actions">
              <button
                type="button"
                className="button secondary"
                disabled={!live || busy !== null || refreshing || stuck.length > 0}
                onClick={() => void run('refresh')}
              >
                {busy === 'refresh' || refreshing ? 'Reading models…' : 'Read models again'}
              </button>
            </div>
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
