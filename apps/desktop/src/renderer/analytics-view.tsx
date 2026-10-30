import {
  allowanceText,
  countText,
  type DesktopSource,
  tokensText,
  wallText,
} from '@crewkite/client';
import type { ChatAnalyticsRead, ReadChatAnalyticsPayload } from '@crewkite/contracts';
import { useEffect, useState } from 'react';
import { readAnalytics, type ThreadSource } from './thread/commands.ts';
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
    ['Tokens in', tokensText(read.tokensIn, read.tokenTurns, read.turns)],
    ['Tokens out', tokensText(read.tokensOut, read.tokenTurns, read.turns)],
    ['Checks', `${read.checksPassed} passed of ${read.checksRun} run, ${read.checksFailed} failed`],
    ['Branches accepted', String(read.branchesAccepted)],
    ...(read.slices
      ? ([
          [
            'Plan slices',
            `${read.slices.done} done of ${read.slices.total}, ${read.slices.failed} failed, ${read.slices.blocked} blocked`,
          ],
        ] as [string, string][])
      : []),
  ];
  const turns = read.turnRows.slice(-TURN_ROWS);
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
              <th scope="col">Family</th>
              <th scope="col">Turns</th>
              <th scope="col">Wall time</th>
              <th scope="col">Tokens in</th>
              <th scope="col">Tokens out</th>
            </tr>
          </thead>
          <tbody>
            {read.families.map((family) => (
              <tr key={family.family}>
                <th scope="row">{family.family}</th>
                <td>{family.turns}</td>
                <td>{wallText(family.wallMs)}</td>
                <td>{tokensText(family.tokensIn, family.tokenTurns, family.turns)}</td>
                <td>{tokensText(family.tokensOut, family.tokenTurns, family.turns)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {read.families.some((family) => family.allowance.length > 0) && (
        <>
          <h3 className="an-heading">Allowance used</h3>
          <ul className="an-list">
            {read.families.flatMap((family) =>
              family.allowance.map((entry) => (
                <li key={`${family.family}/${entry.windowId}`}>
                  {family.family}, {allowanceText(entry)}
                </li>
              )),
            )}
          </ul>
          <p className="th-muted">
            A turn is charged only when gauge readings within 15 minutes before and after it show
            the drop and no other turn on that family overlapped. Use outside CrewKite between the
            readings counts too.
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
                <th scope="col">Branches</th>
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
                  <td>{thread.branchesAccepted}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {read.threadCount > read.threads.length && (
            <p className="th-muted">
              {read.threadCount - read.threads.length} more threads are not listed.
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
                <th scope="col">Sequence</th>
                <th scope="col">Role</th>
                <th scope="col">Family</th>
                <th scope="col">Wall time</th>
                <th scope="col">Tokens in</th>
                <th scope="col">Tokens out</th>
              </tr>
            </thead>
            <tbody>
              {turns.map((turn) => (
                <tr key={turn.id}>
                  <td>{turn.sequence}</td>
                  <td>{turn.role}</td>
                  <td>{turn.family}</td>
                  <td>{wallText(turn.wallMs)}</td>
                  <td>{countText(turn.tokensIn)}</td>
                  <td>{countText(turn.tokensOut)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {read.turnRows.length > turns.length && (
            <p className="th-muted">
              {read.turnRows.length - turns.length} earlier turns are in the CSV file.
            </p>
          )}
        </div>
      )}
    </>
  );
}
