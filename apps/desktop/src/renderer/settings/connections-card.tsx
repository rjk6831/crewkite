import { CONNECTION_COPY, type Connection, type ConnectionsRead } from '@crewkite/contracts';
import { Check, Copy } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { familyName } from '../components.tsx';
import { Select } from '../select.tsx';
import {
  addConnection,
  disconnectConnection,
  forgetConnection,
  proveConnection,
  setKeepConnected,
  type ThreadSource,
} from '../thread/commands.ts';
import {
  connectionName,
  isApiConnection,
  observedModeText,
  readinessText,
} from './connection-view.ts';
import { connectionsChanged, useConnections } from './use-catalog.ts';

const SIGN_IN_STEP = 'Run this in your terminal, then choose Check sign-in.';
type Note = { text: string; failed: boolean };
const failed = (failure: unknown, fallback: string): Note => ({
  text: failure instanceof Error && failure.message ? failure.message : fallback,
  failed: true,
});

/**
 * API connections. Add one, sign its own client profile in from your terminal, and check the mode
 * the client reports. The client takes the key in that terminal, so it never passes through
 * CrewKite. A connection runs nothing until a thread or a role is set to use it in the Crew tab.
 */
export function ConnectionsCard({ source, changed }: { source: ThreadSource; changed: unknown }) {
  const ids = useId();
  const read = useConnections(source, changed);
  const [family, setFamily] = useState<'openai' | 'anthropic'>('openai');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  // The line from the add answer covers a read that has not caught up with the new connection.
  const [added, setAdded] = useState<{ connectionId: string; loginLine: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const connections = (read?.connections ?? []).filter(isApiConnection);

  async function add() {
    setBusy(true);
    setNote(null);
    try {
      const made = await addConnection(source, {
        family,
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      setAdded({ connectionId: made.connection.connectionId, loginLine: made.loginLine });
      setLabel('');
      connectionsChanged();
    } catch (failure) {
      setNote(failed(failure, 'The connection was not added.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="st-card" aria-labelledby={`${ids}-title`}>
      <header className="st-card-head">
        <h2 id={`${ids}-title`} ref={heading} tabIndex={-1}>
          API connections
        </h2>
        <span className="st-detail">
          {connections.length === 0
            ? 'None'
            : `${connections.length} ${connections.length === 1 ? 'connection' : 'connections'}`}
        </span>
      </header>
      <div className="st-connections-body">
        <p className="st-note">
          Each provider runs on your subscription unless you pick an API connection for a thread or
          a role in the thread's Crew tab. Provider charges apply there. You sign in from your own
          terminal, so the key stays with the provider's client.
        </p>
        {connections.length === 0 ? (
          <p className="st-note">No API connections yet.</p>
        ) : (
          <ul className="st-connections" aria-label="API connections">
            {connections.map((connection) => (
              <ConnectionRow
                key={connection.connectionId}
                source={source}
                connection={connection}
                line={loginLine(read, connection, added)}
                focusLine={added?.connectionId === connection.connectionId}
                onGone={() => heading.current?.focus()}
              />
            ))}
          </ul>
        )}
        <div className="st-block">
          <div className="st-subhead">
            <h3>Add an API connection</h3>
          </div>
          <div className="st-rows">
            <div className="st-row">
              <div className="st-field">
                <label className="st-name" htmlFor={`${ids}-family`}>
                  Provider
                </label>
                <small className="st-hint">
                  Its client has to be installed. The connection gets a profile of its own, so your
                  subscription sign-in is not touched.
                </small>
              </div>
              <div className="st-controls">
                <Select
                  id={`${ids}-family`}
                  value={family}
                  disabled={busy}
                  onChange={(event) => setFamily(event.target.value as 'openai' | 'anthropic')}
                >
                  <option value="openai">{familyName('openai')}</option>
                  <option value="anthropic">{familyName('anthropic')}</option>
                </Select>
              </div>
            </div>
            <div className="st-row">
              <div className="st-field">
                <label className="st-name" htmlFor={`${ids}-label`}>
                  Label
                </label>
                <small className="st-hint" id={`${ids}-label-hint`}>
                  Optional. A name you will recognize, such as the team the key bills to. Never the
                  key.
                </small>
              </div>
              <div className="st-controls">
                <input
                  id={`${ids}-label`}
                  className="st-connection-label"
                  aria-describedby={`${ids}-label-hint`}
                  maxLength={60}
                  value={label}
                  disabled={busy}
                  onChange={(event) => setLabel(event.target.value)}
                />
                <button
                  type="button"
                  className="button primary"
                  disabled={busy}
                  onClick={() => void add()}
                >
                  Add API connection
                </button>
              </div>
            </div>
          </div>
        </div>
        {note && (
          <p role="status" className={note.failed ? 'st-error' : undefined}>
            {note.text}
          </p>
        )}
      </div>
    </section>
  );
}

function loginLine(
  read: ConnectionsRead | null,
  connection: Connection,
  added: { connectionId: string; loginLine: string } | null,
): string | null {
  return (
    read?.loginLines.find((row) => row.connectionId === connection.connectionId)?.line ??
    (added?.connectionId === connection.connectionId ? added.loginLine : null)
  );
}

/**
 * One API connection: what it is, the mode its client last reported and whether a turn can run on
 * it, with Keep connected, Check sign-in, Disconnect and Forget. While it needs a sign-in the line
 * to run sits under it.
 */
function ConnectionRow({
  source,
  connection,
  line,
  focusLine,
  onGone,
}: {
  source: ThreadSource;
  connection: Connection;
  line: string | null;
  /** The connection was just added, so focus moves to its sign-in line. */
  focusLine: boolean;
  /** Forget removed the row, so focus has to go somewhere that stays. */
  onGone: () => void;
}) {
  const ids = useId();
  const [checking, setChecking] = useState(false);
  const [working, setWorking] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const forget = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  // The question takes focus when it opens and gives it back to Forget when it closes.
  useEffect(() => {
    if (forgetting) {
      asked.current = true;
      cancel.current?.focus();
    } else if (asked.current) {
      asked.current = false;
      forget.current?.focus();
    }
  }, [forgetting]);
  const name = connectionName(connection);
  const mismatch =
    connection.observedMode !== null && connection.observedMode !== connection.billingMode;
  const disconnected = connection.readiness === 'disconnected';
  const signIn = connection.readiness === 'needs-attention' ? line : null;
  const status = [
    familyName(connection.family),
    connection.observedMode
      ? `Client reports ${observedModeText(connection.observedMode)}`
      : observedModeText(null),
    readinessText[connection.readiness],
  ].join(' · ');

  async function check() {
    setChecking(true);
    setNote(null);
    try {
      const answer = await proveConnection(source, connection.connectionId);
      if (answer.outcome === 'applied' || answer.outcome === 'already-applied')
        setNote({ text: `Ready. The client reports ${CONNECTION_COPY.apiLabel}.`, failed: false });
      // A mode mismatch shows on the row from the record, so only another answer needs words.
      else if (answer.next !== CONNECTION_COPY.signInChanged)
        setNote({
          text: answer.next ?? answer.reason ?? 'The sign-in could not be checked.',
          failed: true,
        });
    } catch (failure) {
      setNote(failed(failure, 'The sign-in could not be checked.'));
    } finally {
      setChecking(false);
      connectionsChanged();
    }
  }
  async function change(step: () => Promise<unknown>, done: string | null, gone = false) {
    setWorking(true);
    setNote(null);
    try {
      await step();
      if (done) setNote({ text: done, failed: false });
      if (gone) onGone();
    } catch (failure) {
      setNote(failed(failure, 'The change was not saved.'));
    } finally {
      setWorking(false);
      setForgetting(false);
      connectionsChanged();
    }
  }

  return (
    <li className="st-connection" aria-labelledby={`${ids}-name`}>
      <div className="st-row">
        <div className="st-field">
          <span className="st-name" id={`${ids}-name`}>
            {connection.label ?? name}
          </span>
          <small className="st-hint">{status}</small>
        </div>
        {forgetting ? (
          // biome-ignore lint/a11y/useSemanticElements: a fieldset would draw a frame around two buttons
          <div className="st-controls" role="group" aria-labelledby={`${ids}-forget`}>
            <span className="st-hint" id={`${ids}-forget`}>
              Forget {name}? Threads and roles set to use it go back to the subscription, and its
              own profile is signed out.
            </span>
            <button
              type="button"
              className="button stop"
              disabled={working}
              onClick={() =>
                void change(() => forgetConnection(source, connection.connectionId), null, true)
              }
            >
              Forget connection
            </button>
            <button
              ref={cancel}
              type="button"
              className="button secondary"
              disabled={working}
              onClick={() => setForgetting(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="st-controls">
            <button
              type="button"
              className="button secondary"
              disabled={checking || working}
              aria-busy={checking}
              onClick={() => void check()}
            >
              {checking ? 'Checking sign-in…' : 'Check sign-in'}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={checking || working || disconnected}
              onClick={() =>
                void change(
                  () => disconnectConnection(source, connection.connectionId),
                  'Disconnected. Check sign-in connects it again.',
                )
              }
            >
              Disconnect
            </button>
            <button
              ref={forget}
              type="button"
              className="button secondary"
              disabled={checking || working}
              onClick={() => setForgetting(true)}
            >
              Forget
            </button>
          </div>
        )}
      </div>
      {mismatch && <p className="st-error">{CONNECTION_COPY.signInChanged}</p>}
      {signIn && <SignInLine line={signIn} focus={focusLine} />}
      <div className="st-field">
        <label className="sa-switch" htmlFor={`${ids}-keep`}>
          <input
            id={`${ids}-keep`}
            type="checkbox"
            role="switch"
            checked={connection.keepConnected}
            aria-checked={connection.keepConnected}
            aria-describedby={`${ids}-keep-hint`}
            disabled={working}
            onChange={(event) =>
              void change(
                () => setKeepConnected(source, connection.connectionId, event.target.checked),
                null,
              )
            }
          />
          <span>{CONNECTION_COPY.keepConnectedLabel}</span>
        </label>
        <small className="st-hint" id={`${ids}-keep-hint`}>
          {CONNECTION_COPY.keepConnectedDetail}
        </small>
      </div>
      {checking && (
        <p className="st-hint" role="status">
          The client reads its sign-in. This can take 30 seconds.
        </p>
      )}
      {note && (
        <p role="status" className={note.failed ? 'st-error' : 'st-hint'}>
          {note.text}
        </p>
      )}
    </li>
  );
}

/** The sign-in line for the connection's own profile, with Copy. */
function SignInLine({ line, focus }: { line: string; focus: boolean }) {
  const [copied, setCopied] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focus) button.current?.focus();
  }, [focus]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(line);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The clipboard can be blocked. The line stays selectable.
    }
  }
  return (
    <div className="st-sign-in">
      <p className="st-hint">{SIGN_IN_STEP}</p>
      <div className="st-sign-in-line">
        <code>{line}</code>
        <button
          ref={button}
          type="button"
          className="button secondary"
          aria-label={copied ? 'Copied the sign-in line' : 'Copy the sign-in line'}
          onClick={() => void copy()}
        >
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
