import { countText, type DesktopSource, tokensText, wallText } from '@crewkite/client';
import type { ChatAnalyticsRead, ReadChatAnalyticsPayload } from '@crewkite/contracts';
import { useEffect, useState } from 'react';
import { familyName } from './components.tsx';
import { readAnalytics, type ThreadSource } from './thread/commands.ts';
import { windowLabel } from './usage-presentation.ts';
import './analytics.css';

// Usage numbers for one thread or one project, as plain figures and small tables. The controller
// derives them, so this view only formats what it reads. A value the client did not report reads
// as unknown. The CSV goes through main's save dialog, and nothing else leaves the machine.

const TURN_ROWS = 20;
const idOf = (input: ReadChatAnalyticsPayload) =>
  input.scope === 'thread' ? input.taskId : input.projectId;

export function AnalyticsView({
  source,
  input,
  refreshKey = '',
}: {
  source: ThreadSource & Pick<DesktopSource, 'saveAnalytics'>;
  input: ReadChatAnalyticsPayload;
  /** A change reads the numbers again, as when a turn ends. */
  refreshKey?: string;
}) {
  const [read, setRead] = useState<ChatAnalyticsRead | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  const wanted = JSON.stringify(input);
  useEffect(() => {
    let live = true;
    // `again` and `refreshKey` only restart the read.
    void again;
    void refreshKey;
    readAnalytics(source, JSON.parse(wanted)).then(
      (value) => {
        if (!live) return;
        setRead(value);
        setProblem(null);
      },
      (failure: unknown) => {
        if (live)
          setProblem(
            failure instanceof Error ? failure.message : 'The usage numbers could not be read.',
          );
      },
    );
    return () => {
      live = false;
    };
  }, [source, wanted, again, refreshKey]);

  async function exportFile() {
    if (!source.saveAnalytics) {
      setNote('Export needs the desktop app.');
      return;
    }
    try {
      setNote((await source.saveAnalytics(input)) === 'saved' ? 'Saved.' : null);
    } catch (failure) {
      setNote(failure instanceof Error ? failure.message : 'The file was not saved.');
    }
  }

  const current = read && read.id === idOf(input) ? read : null;
  return (
    <section className="an" aria-label="Usage analytics">
      <div className="an-actions">
        <button type="button" className="th-button" onClick={() => setAgain((value) => value + 1)}>
          Refresh
        </button>
        <button
          type="button"
          className="th-button"
          disabled={!current || (current.turns === 0 && current.threadCount === 0)}
          onClick={() => void exportFile()}
        >
          Export CSV
        </button>
      </div>
      {problem && (
        <p className="an-problem" role="status">
          {problem}
        </p>
      )}
      {!current && !problem && <p className="th-muted">Reading usage.</p>}
      {current && <Numbers read={current} />}
      {note && (
        <p className="th-muted" role="status">
          {note}
        </p>
      )}
    </section>
  );
}

function Numbers({ read }: { read: ChatAnalyticsRead }) {
  const [shown, setShown] = useState(TURN_ROWS);
  if (read.turns === 0)
    return (
      <p className="th-muted">
        {read.scope === 'thread'
          ? 'This thread has no turns yet.'
          : 'No thread of this project has a turn yet.'}
      </p>
    );
  const totals: [string, string][] = [
    ['Turns', `${read.turns}${read.openTurns ? `, ${read.openTurns} open` : ''}`],
    ['Handoffs', String(read.handoffs)],
    ['Wall time', wallText(read.wallMs)],
    ['Tokens in', tokensText(read.tokensIn, read.tokensInTurns, read.turns)],
    ['Tokens out', tokensText(read.tokensOut, read.tokensOutTurns, read.turns)],
    [
      'Checks with a result',
      `${read.checksPassed} passed of ${read.checksRun}, ${read.checksFailed} failed`,
    ],
    ['Branch acceptances', String(read.acceptances)],
    ...(read.slices
      ? ([
          [
            'Plan slices',
            `${read.slices.done} done of ${read.slices.total}, ${read.slices.failed} failed, ${read.slices.blocked} blocked`,
          ],
        ] as [string, string][])
      : []),
  ];
  // The newest turns first come in pages of 20, so a long thread stays a short list until the
  // person asks for more. The CSV file holds every listed turn.
  const turns = read.turnRows.slice(-shown);
  return (
    <>
      <dl className="an-totals">
        {totals.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="an-scroll">
        <table className="an-table">
          <caption>By family</caption>
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Turns</th>
              <th scope="col">Time</th>
              <th scope="col">Tokens in / out</th>
            </tr>
          </thead>
          <tbody>
            {read.families.map((family) => (
              <tr key={family.family}>
                <th scope="row">{familyName(family.family)}</th>
                <td>{family.turns}</td>
                <td>{wallText(family.wallMs)}</td>
                <td>
                  {`${tokensText(family.tokensIn, family.tokensInTurns, family.turns)} / ${tokensText(family.tokensOut, family.tokensOutTurns, family.turns)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {read.families.some((family) => family.allowance.length > 0) && (
        <>
          <div className="an-scroll">
            <table className="an-table">
              <caption>Allowance used</caption>
              <thead>
                <tr>
                  <th scope="col">Window</th>
                  <th scope="col">Used</th>
                  <th scope="col">Turns measured</th>
                </tr>
              </thead>
              {read.families
                .filter((family) => family.allowance.length > 0)
                .map((family) => (
                  <tbody key={family.family}>
                    <tr className="an-group">
                      <th scope="rowgroup" colSpan={3}>
                        {familyName(family.family)}
                      </th>
                    </tr>
                    {family.allowance.map((entry) => (
                      <tr key={entry.windowId}>
                        <th scope="row">{windowLabel(entry.windowId)}</th>
                        <td>
                          {entry.consumed === null ? 'Unknown' : `${entry.consumed} ${entry.unit}`}
                        </td>
                        <td>{`${entry.measuredTurns} of ${entry.measuredTurns + entry.unmeasuredTurns}`}</td>
                      </tr>
                    ))}
                  </tbody>
                ))}
            </table>
          </div>
          {read.families.some((family) => family.windowsOmitted > 0) && (
            <p className="th-muted">
              Some windows are not listed. The most recently read come first.
            </p>
          )}
          {read.gaugeTruncated && (
            <p className="th-muted">
              The gauge read stopped at its row cap, so allowance may be missing.
            </p>
          )}
          <p className="th-muted">
            Each turn is measured from the gauge readings just before and after it. A turn shows
            Unknown when it overlapped another or no reading was close enough. Anything else that
            used the plan in between counts toward it.
          </p>
        </>
      )}
      {read.scope === 'project' && read.threads.length > 0 && (
        <div className="an-scroll">
          <table className="an-table">
            <caption>By thread</caption>
            <thead>
              <tr>
                <th scope="col">Thread</th>
                <th scope="col">Turns</th>
                <th scope="col">Wall time</th>
                <th scope="col">Handoffs</th>
                <th scope="col">Checks passed</th>
                <th scope="col">Acceptances</th>
              </tr>
            </thead>
            <tbody>
              {read.threads.map((thread) => (
                <tr key={thread.taskId}>
                  <th scope="row">{thread.title}</th>
                  <td>{thread.turns}</td>
                  <td>{wallText(thread.wallMs)}</td>
                  <td>{thread.handoffs}</td>
                  <td>{`${thread.checksPassed} of ${thread.checksRun}`}</td>
                  <td>{thread.acceptances}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {read.threadCount > read.threads.length && (
            <p className="th-muted">
              {read.threadCount - read.threads.length} more threads are in neither this list nor the
              CSV file.
            </p>
          )}
        </div>
      )}
      {read.scope === 'thread' && turns.length > 0 && (
        <div className="an-scroll">
          <table className="an-table">
            <caption>Newest turns</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Role</th>
                <th scope="col">Provider</th>
                <th scope="col">Time</th>
                <th scope="col">Tokens in / out</th>
              </tr>
            </thead>
            <tbody>
              {turns.map((turn) => (
                <tr key={turn.id}>
                  <td>{turn.sequence}</td>
                  <td>{turn.role}</td>
                  <td>{familyName(turn.family)}</td>
                  <td>{wallText(turn.wallMs)}</td>
                  <td>{`${countText(turn.tokensIn)} / ${countText(turn.tokensOut)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {read.turnRows.length > turns.length && (
            <div className="an-more">
              <button
                type="button"
                className="button secondary"
                onClick={() => setShown((value) => value + TURN_ROWS)}
              >
                Show {Math.min(TURN_ROWS, read.turnRows.length - turns.length)} more
              </button>
              <span className="th-muted">
                {read.turnRows.length - turns.length} earlier of {read.turnRows.length}. The CSV
                file holds all of them.
              </span>
            </div>
          )}
          {read.turnRowsOmitted > 0 && (
            <p className="th-muted">
              {read.turnRowsOmitted} older turns are in neither this list nor the CSV file. The read
              keeps the newest {read.turnRows.length}.
            </p>
          )}
        </div>
      )}
    </>
  );
}
