import type { ClientVersionStatus, WorkspaceState } from '@crewkite/contracts';
import { useRef, useState } from 'react';
import type { Workspace } from '../../source.ts';
import { stuckHolds } from '../provider-evidence.ts';
import {
  actionCommand,
  actionResult,
  CARD_ACTIONS,
  type CardActionId,
  type CardFamily,
  clientCopyLine,
} from './card-actions.ts';
import { connectedOnce } from './connect-copy.ts';

/**
 * Check again, Refresh models and Sign out, then the line that names the client copy in use.
 * Every cloud card renders this one row, so the words and the order match across families.
 */
export function CardActions({
  family,
  header,
  workspace,
  status,
  modelNote,
}: {
  family: CardFamily;
  header: WorkspaceState;
  workspace: Workspace;
  status: ClientVersionStatus;
  /** A reason the last background model read gave, for a family that reads in the background. */
  modelNote?: string | null;
}) {
  const [busy, setBusy] = useState<CardActionId | null>(null);
  const [result, setResult] = useState<{
    id: CardActionId;
    line: string;
    note: string | null | undefined;
  } | null>(null);
  const latestNote = useRef(modelNote);
  latestNote.current = modelNote;
  const live = workspace.connection === 'connected' && !workspace.preview;
  const once = connectedOnce(header, family);
  const setup = header.googleAcpSetup;
  // Google reads its models through its setup, which needs the proof it holds. A hold on the
  // setup refuses the read, so the button waits until Recover has cleared it.
  const googleReady = setup?.state === 'ready' && !!setup.proofId;
  const googleRefreshing = setup?.modelRefresh?.outcome === 'running';
  // A newer Google copy that needs its own sign-in gets Connect. The copy in use keeps running.
  const waiting = family === 'google' && !!status.copy?.notUsed?.signIn;
  const enabled: Record<CardActionId, boolean> = {
    check: true,
    models:
      once &&
      (family !== 'google' ||
        (googleReady && !googleRefreshing && stuckHolds(header).length === 0)),
    'sign-out': once,
    connect: waiting && googleReady && !googleRefreshing && stuckHolds(header).length === 0,
  };
  async function run(id: CardActionId) {
    const source = workspace.source;
    if (busy || !source) return;
    setBusy(id);
    setResult(null);
    let line: string;
    try {
      // The row shows its own refusal. The workspace's command path would raise a page error too.
      const outcome = await source.command(
        actionCommand(id, family, {
          revision: setup?.revision ?? 0,
          proofId: setup?.proofId ?? '',
        }),
      );
      await workspace.refresh().catch(() => {});
      line = actionResult(
        id,
        family,
        {
          ok: outcome.outcome === 'applied' || outcome.outcome === 'already-applied',
          next: outcome.next,
        },
        new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      );
    } catch (failure) {
      line =
        failure instanceof Error ? failure.message : actionResult(id, family, { ok: false }, '');
    }
    // The note is read after the command, so a read it started does not hide its own result.
    setResult({ id, line, note: latestNote.current });
    setBusy(null);
  }
  const copy = clientCopyLine(family, status);
  // A background read ends with its own reason, which replaces the line of an earlier press.
  const pressed = result && (result.id !== 'models' || result.note === modelNote) ? result : null;
  const line = busy ? null : (pressed?.line ?? (enabled.models ? modelNote : null));
  return (
    <>
      <div className="st-actions">
        {CARD_ACTIONS.map(({ id, label, busy: busyLabel }) => (
          <button
            key={id}
            type="button"
            className="button secondary"
            disabled={!live || busy !== null || !enabled[id]}
            onClick={() => void run(id)}
          >
            {busy === id ? busyLabel : label}
          </button>
        ))}
        {waiting && (
          <button
            type="button"
            className="button secondary"
            disabled={!live || busy !== null || !enabled.connect}
            onClick={() => void run('connect')}
          >
            {busy === 'connect' ? 'Signing in…' : 'Connect'}
          </button>
        )}
      </div>
      {line && (
        <p className="st-note" role="status">
          {line}
        </p>
      )}
      {copy && <p className="st-note">{copy}</p>}
    </>
  );
}
