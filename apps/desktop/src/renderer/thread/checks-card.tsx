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
}: {
  checks: ChatChecksState;
  onStop: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (checks.runs.length === 0) return null;
  const open = checks.runs.some((run) => run.status === 'running');
  return (
    <section className="th-checks" aria-label="Checks">
      <header className="th-checks-head">
        <h3>Checks</h3>
        {open && (
          <button
            type="button"
            className="th-pill th-outline"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              onStop()
                .catch((cause: unknown) => setError(failure(cause)))
                .finally(() => setBusy(false));
            }}
          >
            Stop
          </button>
        )}
      </header>
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
              <span className="th-muted th-checks-command">{item.command}</span>
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
        failing check goes to the next fix.{' '}
        {allowed
          ? 'This thread allows commands.'
          : 'Allow commands for this thread, or the checks do not run.'}
      </p>
      {error && (
        <p className="th-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
