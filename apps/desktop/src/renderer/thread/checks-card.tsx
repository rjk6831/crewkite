import type { ChatCheckRun, ChatChecksState, ChatThread } from '@crewkite/contracts';
import { useEffect, useState } from 'react';
import './checks-card.css';

const statusLabel: Record<ChatCheckRun['status'], string> = {
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  stopped: 'Stopped',
};

const failure = (error: unknown) =>
  error instanceof Error ? error.message : 'The request was not accepted.';

export const durationLabel = (ms: number | null) =>
  ms === null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

const sizeLabel = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;

/**
 * What the project checks did in this thread: each run with its status, how long it took and the
 * tail of its output. The whole output is kept in the artifact store. Stop is offered while a run
 * is open.
 */
export function ChecksCard({
  checks,
  onStop,
  onAnswer,
}: {
  checks: ChatChecksState;
  onStop: () => Promise<void>;
  onAnswer: (requestId: string, choice: 'allow' | 'deny') => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = checks.ask;
  if (checks.runs.length === 0 && !ask) return null;
  const open = checks.runs.some((run) => run.status === 'running') || !!ask;
  const act = (work: Promise<void>) => {
    setBusy(true);
    setError(null);
    work.catch((cause: unknown) => setError(failure(cause))).finally(() => setBusy(false));
  };
  return (
    <section className="th-checks" aria-label="Checks">
      <header className="th-checks-head">
        <h3>Checks</h3>
        {open && (
          <button
            type="button"
            className="th-pill th-outline"
            disabled={busy}
            onClick={() => act(onStop())}
          >
            Stop
          </button>
        )}
      </header>
      {ask && (
        <fieldset className="th-checks-ask">
          <legend className="th-sr">Allow these commands</legend>
          <p>
            {ask.changed.length > 0
              ? `A command or script changed since you turned it on: ${ask.changed.join(', ')}. `
              : ''}
            Run these commands in the scratch copy?
          </p>
          <ul>
            {ask.commands.map((item) => (
              <li key={item.label}>
                <span className="th-checks-label">{item.label}</span>
                <span className="th-muted th-checks-command">{item.resolved}</span>
              </li>
            ))}
          </ul>
          <div className="th-plan-actions">
            <button
              type="button"
              className="th-button"
              disabled={busy}
              onClick={() => act(onAnswer(ask.requestId, 'allow'))}
            >
              Allow once
            </button>
            <button
              type="button"
              className="th-pill th-outline"
              disabled={busy}
              onClick={() => act(onAnswer(ask.requestId, 'deny'))}
            >
              Skip the checks
            </button>
          </div>
        </fieldset>
      )}
      <ol className="th-checks-runs">
        {[...checks.runs].reverse().map((run) => (
          <li key={run.id} className={`th-checks-run is-${run.status}`}>
            <div className="th-checks-line">
              <span className="th-checks-label">{run.label}</span>
              <span className={`th-checks-status is-${run.status}`}>{statusLabel[run.status]}</span>
              <span className="th-muted">{durationLabel(run.durationMs)}</span>
            </div>
            <p className="th-muted th-checks-command">{run.command}</p>
            {run.reason && <p className="th-checks-reason">{run.reason}</p>}
            {run.tail && <pre className="th-checks-tail">{run.tail}</pre>}
            {(run.stdout || run.stderr) && (
              <p className="th-muted">
                Full output kept: {run.stdout ? `output ${sizeLabel(run.stdout.bytes)}` : ''}
                {run.stdout && run.stderr ? ', ' : ''}
                {run.stderr ? `errors ${sizeLabel(run.stderr.bytes)}` : ''}.
              </p>
            )}
          </li>
        ))}
      </ol>
      {error && (
        <p className="th-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * The Crew tab's list of project checks, a switch for each and a field to add a command. The
 * controller reads the project files and runs the enabled checks in the scratch copy; it asks the
 * thread's command permission first.
 */
export function ChecksSettings({
  thread,
  onEdit,
}: {
  thread: ChatThread | null;
  onEdit: (edit: {
    refresh?: true;
    switch?: { id: string; enabled: boolean };
    add?: string;
    remove?: string;
  }) => Promise<void>;
}) {
  const [command, setCommand] = useState('');
  const [error, setError] = useState<string | null>(null);
  const items = thread?.checks?.items ?? [];
  // The first look at a thread asks the controller to read the project files.
  const unread = !!thread && !thread.checks;
  const taskId = thread?.taskId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one read per thread, not per render
  useEffect(() => {
    if (unread) void onEdit({ refresh: true }).catch((cause: unknown) => setError(failure(cause)));
  }, [unread, taskId]);
  const allowed =
    thread?.permissionPolicy === 'allow-all' || !!thread?.permissionGrants?.includes('command');
  async function act(edit: Parameters<typeof onEdit>[0]) {
    setError(null);
    try {
      await onEdit(edit);
      return true;
    } catch (cause) {
      setError(failure(cause));
      return false;
    }
  }
  return (
    <fieldset className="th-checks-settings" disabled={!thread}>
      <legend>Project checks</legend>
      {items.length === 0 ? (
        <p className="th-muted">
          {thread?.checks
            ? 'No test, lint or type check was found in the project files.'
            : 'The controller has not read the project files yet.'}
        </p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <label>
                <input
                  type="checkbox"
                  checked={item.enabled}
                  onChange={(event) =>
                    void act({ switch: { id: item.id, enabled: event.target.checked } })
                  }
                />
                <span>{item.label}</span>
              </label>
              <span className="th-muted th-checks-command">{item.resolved}</span>
              {item.source === 'custom' && (
                <button
                  type="button"
                  className="th-pill th-outline"
                  aria-label={`Remove ${item.label}`}
                  onClick={() => void act({ remove: item.id })}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="th-checks-add"
        onSubmit={(event) => {
          event.preventDefault();
          const text = command.trim();
          if (text) void act({ add: text }).then((done) => done && setCommand(''));
        }}
      >
        <label>
          Add a command
          <input
            value={command}
            placeholder="node scripts/check.js"
            onChange={(event) => setCommand(event.target.value)}
          />
        </label>
        <button type="submit" className="th-pill th-outline" disabled={!command.trim()}>
          Add
        </button>
        <button
          type="button"
          className="th-pill th-outline"
          onClick={() => void act({ refresh: true })}
        >
          Read project files
        </button>
      </form>
      <p className="th-muted">
        Balanced and Glide run the checks that are on after each fix and after the last slice. A
        failing check goes to the next fix. Balanced asks before every run. Glide runs them when
        this thread allows commands, and asks again when a command or script changed.{' '}
        {allowed ? 'This thread allows commands.' : 'This thread does not allow commands yet.'}
      </p>
      {error && (
        <p className="th-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
