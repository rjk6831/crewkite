import type { ChatChangeEntry, ChatHunk } from '@crewkite/contracts';
import { type FormEvent, useState } from 'react';
import { lineClass } from './cards.tsx';
import { commentChange, decideHunk, discardHunk, type ThreadSource } from './commands.ts';
import { type HunkLine as Line, patchBlocks, pickedRange } from './hunk-lines.ts';
import './hunk-view.css';

/**
 * A file's diff as hunks, each with Accept for the branch, Discard in the copy and a review
 * comment. Line clicks pick the lines a comment quotes; shift extends the pick.
 */
export function HunkView({
  source,
  taskId,
  file,
  running,
  onChanged,
}: {
  source: ThreadSource;
  taskId: string;
  file: ChatChangeEntry;
  running: boolean;
  /** A decision or a discard changed what Changes shows. */
  onChanged: () => void;
}) {
  const blocks = patchBlocks(file.patch ?? '', file.hunks);
  return (
    <div className="th-hunks">
      {file.decided && (
        <p className="th-muted th-hunk-note">
          Accept to branch takes only the accepted hunks of this file. The rest stay in the copy.
        </p>
      )}
      {file.hunks.map((hunk, index) => (
        <HunkBlock
          key={hunk.key}
          source={source}
          taskId={taskId}
          path={file.path}
          hunk={hunk}
          lines={blocks[index] ?? []}
          running={running}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

function HunkBlock({
  source,
  taskId,
  path,
  hunk,
  lines,
  running,
  onChanged,
}: {
  source: ThreadSource;
  taskId: string;
  path: string;
  hunk: ChatHunk;
  lines: Line[];
  running: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pick, setPick] = useState<{ from: number; to: number } | null>(null);
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);
  const accepted = hunk.decision === 'accepted';
  const range = pick ? pickedRange(lines, pick.from, pick.to) : null;
  const ref = { taskId, path, hunk: hunk.key };

  async function act(step: () => Promise<{ done: true } | { done: false; next: string }>) {
    setBusy(true);
    setRefusal(null);
    try {
      const answer = await step();
      if (answer.done) return true;
      setRefusal(answer.next);
    } catch (failure) {
      setRefusal(failure instanceof Error ? failure.message : 'The change did not apply.');
    } finally {
      setBusy(false);
    }
    return false;
  }
  const toggle = async () => {
    if (
      await act(() => decideHunk(source, { ...ref, decision: accepted ? 'undecided' : 'accepted' }))
    )
      onChanged();
  };
  const discard = async () => {
    if (await act(() => discardHunk(source, ref))) {
      setConfirming(false);
      onChanged();
    }
  };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = comment.trim();
    if (!text) return;
    if (
      await act(() => commentChange(source, { ...ref, text, ...(range ? { lines: range } : {}) }))
    ) {
      setComment('');
      setCommenting(false);
      setPick(null);
      setSent(true);
    }
  };
  const label = `${path} hunk at base line ${hunk.oldStart}`;
  return (
    <section className={`th-hunk${accepted ? ' is-accepted' : ''}`} aria-label={label}>
      <header className="th-hunk-head">
        <code>
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
        </code>
        <button
          type="button"
          className="th-button"
          aria-pressed={accepted}
          disabled={busy || running}
          title={running ? 'Decide when the reply ends.' : undefined}
          onClick={() => void toggle()}
        >
          {accepted ? 'Accepted' : 'Accept'}
        </button>
        <button
          type="button"
          className="th-button"
          disabled={busy || running}
          onClick={() => setConfirming(true)}
        >
          Discard
        </button>
        <button
          type="button"
          className="th-button"
          disabled={busy}
          aria-expanded={commenting}
          onClick={() => setCommenting((open) => !open)}
        >
          Comment
        </button>
      </header>
      {confirming && (
        <div className="th-discard-confirm">
          <p>Put this hunk back the way the base has it? The other hunks of {path} stay.</p>
          <button
            type="button"
            className="th-button"
            disabled={busy || running}
            onClick={() => void discard()}
          >
            Discard hunk
          </button>{' '}
          <button type="button" className="th-button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      )}
      <pre className="th-patch th-hunk-lines">
        {lines.map((line, index) => {
          const picked =
            pick && index >= Math.min(pick.from, pick.to) && index <= Math.max(pick.from, pick.to);
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: hunk lines have no identity beyond their position
              key={index}
              type="button"
              className={`th-hunk-line ${lineClass(line.text)}${picked ? ' is-picked' : ''}`}
              aria-pressed={Boolean(picked)}
              aria-label={`Pick ${line.next === null ? `base line ${line.old}` : `line ${line.next}`} for a comment`}
              onClick={(event) => {
                setCommenting(true);
                setPick((current) =>
                  event.shiftKey && current
                    ? { from: current.from, to: index }
                    : { from: index, to: index },
                );
              }}
            >
              {line.text || ' '}
            </button>
          );
        })}
      </pre>
      {commenting && (
        <form className="th-hunk-comment" onSubmit={(event) => void send(event)}>
          <label>
            {range
              ? `Comment on ${range.side === 'new' ? 'line' : 'base line'}${range.start === range.end ? ` ${range.start}` : `s ${range.start} to ${range.end}`}`
              : 'Comment on this hunk'}
            <textarea
              value={comment}
              rows={3}
              maxLength={8192}
              onChange={(event) => setComment(event.target.value)}
            />
          </label>
          <p className="th-muted">
            The comment goes to the thread as a message that quotes these lines. While a reply runs
            it waits in the queue.
          </p>
          <button type="submit" className="th-button" disabled={busy || !comment.trim()}>
            Send comment
          </button>{' '}
          {range && (
            <button type="button" className="th-button" onClick={() => setPick(null)}>
              Whole hunk
            </button>
          )}
        </form>
      )}
      {sent && !commenting && (
        <p className="th-muted" role="status">
          Comment sent to the thread.
        </p>
      )}
      {refusal && (
        <p className="th-error" role="alert">
          {refusal}
        </p>
      )}
    </section>
  );
}
