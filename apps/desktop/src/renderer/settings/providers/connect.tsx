import type { ChatFamily, WorkspaceState } from '@crewkite/contracts';
import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../../source.ts';
import { connectState } from './connect-copy.ts';

/** The connect line and its one button. Google and Local keep the buttons of their own setup. */
export function ConnectLine({
  family,
  header,
  workspace,
  connect,
}: {
  family: ChatFamily;
  header: WorkspaceState;
  workspace: Workspace;
  /** The card's own Connect, when it has one. OpenAI signs in here. */
  connect?: () => Promise<void> | void;
}) {
  const state = connectState(header, family);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const live = workspace.connection === 'connected' && !workspace.preview;
  const url = header.providerConnections?.openAiSignIn.url ?? null;
  // The sign-in page opens once, when the client names it.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (family !== 'openai' || !url || opened.current === url) return;
    opened.current = url;
    void window.crewkite?.openLink?.(url).catch(() => {});
  }, [family, url]);
  if (!state) return null;
  async function run(command: 'SignInOpenAi' | 'SignOutOpenAi') {
    setBusy(true);
    setProblem(null);
    try {
      const result = await workspace.command(
        command === 'SignInOpenAi'
          ? { command, expectedRevision: 0, payload: { consent: 'explicit' } }
          : { command, expectedRevision: 0, payload: {} },
      );
      if (result.outcome !== 'applied' && result.outcome !== 'already-applied')
        setProblem(result.next ?? 'Codex could not start the sign-in. Press Connect again.');
    } catch {
      setProblem('Codex could not start the sign-in. Press Connect again.');
    } finally {
      setBusy(false);
    }
  }
  async function press() {
    if (state?.action === 'cancel' || state?.action === 'sign-out') return run('SignOutOpenAi');
    if (family === 'openai') return run('SignInOpenAi');
    setBusy(true);
    try {
      await connect?.();
    } finally {
      setBusy(false);
    }
  }
  const label =
    state.action === 'sign-out' ? 'Sign out' : state.action === 'cancel' ? 'Cancel' : 'Connect';
  return (
    <div className="st-connect">
      <p role="status">{state.line}</p>
      {state.action && (family === 'openai' || connect) && (
        <div className="st-actions">
          <button
            type="button"
            className={state.action === 'connect' ? 'button primary' : 'button secondary'}
            disabled={!live || busy}
            onClick={() => void press()}
          >
            {label}
          </button>
          {state.action === 'cancel' && url && (
            <button
              type="button"
              className="button secondary"
              onClick={() => void window.crewkite?.openLink?.(url).catch(() => {})}
            >
              Open the sign-in page
            </button>
          )}
        </div>
      )}
      {problem && <p className="st-note">{problem}</p>}
    </div>
  );
}
