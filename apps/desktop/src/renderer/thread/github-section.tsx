import type {
  ChatBranchStatus,
  ChatThread,
  RemoteEffect,
  RepositoryPolicy,
  ReviewCommentsRead,
} from '@crewkite/contracts';
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import {
  cancelWrite,
  checkChatMerge,
  checkWrite,
  confirmWrite,
  openPullRequest,
  PUSH_REMOTE,
  proposeWrite,
  pushBranch,
  readBranchStatus,
  readMergeReadiness,
  readRemoteEffects,
  readReviewComments,
  readWritePreview,
  sendCommentsToFixer,
  sendJobToFixer,
  settleWrite,
  type ThreadSource,
  type WriteStep,
} from './commands.ts';
import {
  checksSummary,
  MERGE_LABELS,
  mergeWait,
  type PullRequestView,
  pullRequestOf,
  pushShown,
  shownWrite,
  writeOpen,
  writeView,
} from './github-writes.ts';

// The GitHub part of the Changes tab: push, the pull request, CI, review comments and merge. Every
// write is a proposal the person reads and confirms, and each one shows where it stands.

// Previews of the proposals this window made or read back, and the lines the controller sent with
// them, by write. A proposal is confirmed only once its exact command is on screen, so one read
// back without its preview offers Show the preview, which reads it from the journal.
const previews = new Map<string, string>();
const notes = new Map<string, string>();
// Writes this window proposed, sent or checked. A Done line shows only for these, so an old write
// that ended long ago does not crowd the tab.
const touched = new Set<string>();
// Unknown writes whose Check in this window read GitHub and could not settle them. Only these offer
// "I checked GitHub", since the controller takes the person's word only after its own read.
const unproven = new Set<string>();
const UNPROVEN = new Set([
  'remote-unreadable',
  'remote-write-may-land',
  'remote-write-process-unknown',
]);
// Unknown writes whose last Check here found their process still running. Settling one by hand
// stays possible, and the form says it may still reach GitHub.
const running = new Set<string>();

// The controller's own sentence is the message, except where the write's state already says it.
const SAID_BY_STATE = new Set(['remote-write-refused', 'remote-result-unknown']);

function remember(answer: WriteStep) {
  if (!answer.effect) return;
  touched.add(answer.effect.id);
  if (answer.preview) previews.set(answer.effect.id, answer.preview);
  if (answer.ok && answer.message && answer.effect.state === 'proposed')
    notes.set(answer.effect.id, answer.message);
}

/** The thread's GitHub writes, read again whenever the controller says one changed. */
export function useRemoteWrites(source: ThreadSource, taskId: string) {
  const [effects, setEffects] = useState<readonly RemoteEffect[]>([]);
  const [reads, setReads] = useState(0);
  const reread = useCallback(() => setReads((count) => count + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads asks for a new read
  useEffect(() => {
    let active = true;
    readRemoteEffects(source, taskId).then(
      (next) => active && setEffects(next),
      // A failed read keeps the last list. The next change event reads again.
      () => {},
    );
    return () => {
      active = false;
    };
  }, [source, taskId, reads]);
  useEffect(() => {
    const unsubscribe = source.subscribe((event) => {
      if (event.type === 'remote-effect.updated' && event.taskId === taskId) reread();
    });
    return () => {
      unsubscribe();
    };
  }, [source, taskId, reread]);
  return { effects, reread };
}

/**
 * Runs one write step at a time for a part of the tab and keeps what it said. The list is read
 * again after every step, so the row shows the record's own state.
 */
function useWriteStep(reread: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = async (key: string, step: () => Promise<WriteStep>) => {
    setBusy(key);
    setMessage(null);
    try {
      const answer = await step();
      remember(answer);
      if (!answer.ok && !(answer.reason && SAID_BY_STATE.has(answer.reason)))
        setMessage(answer.message);
      return answer;
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : 'The step did not run.');
      return null;
    } finally {
      setBusy(null);
      reread();
    }
  };
  return { busy, message, run };
}

type Settlement = 'applied' | 'not-applied';
const NOTE_BYTES = 300;

/**
 * The person's own word on a write Check could not settle: done on GitHub or not sent, and a note
 * on what they saw there. Nothing is recorded until they confirm.
 */
function SettleForm({
  busy,
  stillRunning,
  onSettle,
  onClose,
}: {
  busy: boolean;
  /** The last Check found the write's process still running. */
  stillRunning: boolean;
  onSettle: (outcome: Settlement, note: string) => void;
  onClose: () => void;
}) {
  const name = useId();
  const [outcome, setOutcome] = useState<Settlement | null>(null);
  const [note, setNote] = useState('');
  const long = new TextEncoder().encode(note.trim()).byteLength > NOTE_BYTES;
  const ready = outcome !== null && note.trim() !== '' && !long;
  return (
    <fieldset className="th-gh-form th-gh-settle">
      <legend>What GitHub shows</legend>
      {stillRunning && (
        <p className="th-gh-caution" role="note">
          A process from this write was still running when CrewKite last looked. It may still reach
          GitHub.
        </p>
      )}
      <label className="check-row">
        <input
          type="radio"
          name={name}
          checked={outcome === 'applied'}
          onChange={() => setOutcome('applied')}
        />
        Mark as done on GitHub
      </label>
      <label className="check-row">
        <input
          type="radio"
          name={name}
          checked={outcome === 'not-applied'}
          onChange={() => setOutcome('not-applied')}
        />
        Mark as not sent
      </label>
      <label>
        Note
        <textarea
          value={note}
          rows={2}
          maxLength={NOTE_BYTES}
          required
          placeholder="What you saw on GitHub"
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      {long && <p className="th-muted">Keep the note under 300 bytes.</p>}
      <div className="th-gh-actions">
        <button
          type="button"
          className="th-button"
          disabled={busy || !ready}
          onClick={() => outcome && onSettle(outcome, note.trim())}
        >
          Confirm
        </button>
        <button type="button" className="th-button" onClick={onClose}>
          Keep it unknown
        </button>
      </div>
    </fieldset>
  );
}

/**
 * One write and where it stands: Waiting for you with its preview, Sending, Done, Refused with
 * GitHub's reason, or Unknown with Check. Cancel shows only while nothing was sent. Once Check
 * could not settle an unknown write, the person can settle it from what they saw on GitHub.
 */
function WriteRow({
  effect,
  confirmLabel,
  busy,
  sending,
  confirmWait = null,
  onConfirm,
  onCancel,
  onCheck,
  onSettle,
  onPreview,
  children,
}: {
  effect: RemoteEffect;
  confirmLabel: string;
  /** A step of this part of the tab is running, so every button waits. */
  busy: boolean;
  /** This window's confirm of this write is on its way. */
  sending: boolean;
  /** Why Confirm waits, such as edits that were not previewed yet. */
  confirmWait?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  onCheck: () => void;
  onSettle: (outcome: Settlement, note: string) => void;
  onPreview: () => void;
  children?: ReactNode;
}) {
  const [settling, setSettling] = useState(false);
  const view = writeView(effect, sending);
  const checked = view.actions.includes('check') && unproven.has(effect.id);
  const preview = previews.get(effect.id) ?? null;
  const note = notes.get(effect.id) ?? null;
  const waiting = view.actions.includes('confirm');
  return (
    <div className={`th-gh-write is-${view.tone}`}>
      <p className="th-gh-state" role="status">
        <span className="th-gh-pill">{view.label}</span>
        {view.text && <span>{view.text}</span>}
      </p>
      {/* Once the preview has been confirmed, its first line says what this write was. */}
      {!waiting && preview && <p className="th-muted">{preview.split('\n')[0]}</p>}
      {waiting &&
        (preview ? (
          <pre className="th-gh-preview">{preview}</pre>
        ) : (
          <button type="button" className="th-gh-link" disabled={busy} onClick={onPreview}>
            Show the preview
          </button>
        ))}
      {waiting && note && <p className="th-muted">{note}</p>}
      {effect.settled && <p className="th-muted">Your note: {effect.settled.note}</p>}
      {children}
      {view.actions.length > 0 && (
        <div className="th-gh-actions">
          {waiting && preview && (
            <button
              type="button"
              className="th-button"
              disabled={busy || Boolean(confirmWait)}
              title={confirmWait ?? undefined}
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          )}
          {view.actions.includes('cancel') && (
            <button type="button" className="th-button" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          )}
          {view.actions.includes('check') && (
            <button type="button" className="th-button" disabled={busy} onClick={onCheck}>
              Check
            </button>
          )}
          {checked && !settling && (
            <button type="button" className="th-gh-link" onClick={() => setSettling(true)}>
              I checked GitHub
            </button>
          )}
        </div>
      )}
      {checked && settling && (
        <SettleForm
          busy={busy}
          stillRunning={running.has(effect.id)}
          onSettle={onSettle}
          onClose={() => setSettling(false)}
        />
      )}
    </div>
  );
}

/** The handlers of one write row, run through one step hook. */
const rowActions = (
  source: ThreadSource,
  step: ReturnType<typeof useWriteStep>,
  effect: RemoteEffect,
) => ({
  busy: step.busy !== null,
  sending: step.busy === `confirm:${effect.id}`,
  onConfirm: () => void step.run(`confirm:${effect.id}`, () => confirmWrite(source, effect.id)),
  onCancel: () => void step.run(`cancel:${effect.id}`, () => cancelWrite(source, effect.id)),
  onCheck: () =>
    void step.run(`check:${effect.id}`, async () => {
      const answer = await checkWrite(source, effect.id);
      if (answer.reason && UNPROVEN.has(answer.reason)) unproven.add(effect.id);
      if (answer.reason === 'remote-write-may-land') running.add(effect.id);
      else running.delete(effect.id);
      return answer;
    }),
  onSettle: (outcome: Settlement, note: string) =>
    void step.run(`settle:${effect.id}`, () => settleWrite(source, effect.id, outcome, note)),
  onPreview: () => void step.run(`preview:${effect.id}`, () => readWritePreview(source, effect.id)),
});

const StepMessage = ({ text }: { text: string | null }) =>
  text ? (
    <p className="th-error" role="alert">
      {text}
    </p>
  ) : null;

type PullRequestText = { title: string; body: string; draft: boolean };

/** Title, description and draft or ready, edited before a pull request is opened or updated. */
function PullRequestForm({
  value,
  onChange,
  withDraft,
}: {
  value: PullRequestText;
  onChange: (next: PullRequestText) => void;
  withDraft: boolean;
}) {
  return (
    <div className="th-gh-form">
      <label>
        Title
        <input
          value={value.title}
          maxLength={256}
          onChange={(event) => onChange({ ...value, title: event.target.value })}
        />
      </label>
      <label>
        Description
        <textarea
          value={value.body}
          rows={6}
          maxLength={16_384}
          onChange={(event) => onChange({ ...value, body: event.target.value })}
        />
      </label>
      {withDraft && (
        <label className="check-row">
          <input
            type="checkbox"
            checked={value.draft}
            onChange={(event) => onChange({ ...value, draft: event.target.checked })}
          />
          Open as a draft
        </label>
      )}
    </div>
  );
}

const sameText = (left: PullRequestText, right: PullRequestText) =>
  left.title.trim() === right.title.trim() &&
  left.body.trim() === right.body.trim() &&
  left.draft === right.draft;

/**
 * Open pull request proposes and shows the preview in place. The title and description can change
 * before the confirm, through a new proposal with its own preview. Without gh, the compare link.
 */
function OpenPullRequest({
  source,
  taskId,
  branch,
  message,
  effects,
  reread,
  savedLink,
}: {
  source: ThreadSource;
  taskId: string;
  branch: string;
  message: string;
  effects: readonly RemoteEffect[];
  reread: () => void;
  savedLink: string | null;
}) {
  const step = useWriteStep(reread);
  const [editing, setEditing] = useState<PullRequestText | null>(null);
  const [link, setLink] = useState<{ url: string; note: string } | null>(null);
  const proposal = shownWrite(
    effects,
    (effect) => effect.kind === 'pr-open' && effect.target.branch === branch,
    touched,
  );
  const proposed =
    proposal?.request.kind === 'pr-open' && proposal.state === 'proposed' ? proposal.request : null;
  const shown = proposed
    ? { title: proposed.title, body: proposed.body, draft: proposed.draft }
    : null;
  const edited = Boolean(editing && shown && !sameText(editing, shown));

  const open = () =>
    step.run('open', async () => {
      const [title = branch, ...rest] = message.split('\n');
      const answer = await openPullRequest(source, {
        taskId,
        branch,
        title: title.trim() || branch,
        body: rest.join('\n').trim(),
      });
      if (answer.link?.via === 'compare-link') {
        let note = 'Compare link copied.';
        try {
          await navigator.clipboard.writeText(answer.link.url);
        } catch {
          // The clipboard can be blocked. The link below stays selectable.
          note = 'Copy the compare link below.';
        }
        setLink({ url: answer.link.url, note });
      }
      // A proposal is not an error: it waits below for the person's confirm.
      return answer.effect?.state === 'proposed' ? { ...answer, ok: true, message: null } : answer;
    });
  const previewAgain = () => {
    if (!proposal || !editing || proposal.request.kind !== 'pr-open') return;
    const { target } = proposal;
    void step.run('edit', async () => {
      const cancelled = await cancelWrite(source, proposal.id);
      if (!cancelled.ok) return cancelled;
      const answer = await proposeWrite(source, {
        taskId,
        target,
        request: {
          kind: 'pr-open',
          title: editing.title.trim() || branch,
          body: editing.body.trim(),
          draft: editing.draft,
        },
      });
      if (answer.effect) setEditing(null);
      return answer;
    });
  };

  return (
    <div className="th-gh-block">
      {proposal && (
        <WriteRow
          effect={proposal}
          confirmLabel={proposed?.draft ? 'Open draft pull request' : 'Open pull request'}
          confirmWait={edited ? 'Preview the edits first.' : null}
          {...rowActions(source, step, proposal)}
        >
          {proposed &&
            shown &&
            previews.has(proposal.id) &&
            (editing ? (
              <>
                <PullRequestForm value={editing} onChange={setEditing} withDraft />
                <div className="th-gh-actions">
                  <button
                    type="button"
                    className="th-button"
                    disabled={step.busy !== null || !edited}
                    onClick={previewAgain}
                  >
                    Preview again
                  </button>
                  <button type="button" className="th-button" onClick={() => setEditing(null)}>
                    Keep the preview
                  </button>
                </div>
              </>
            ) : (
              <button type="button" className="th-gh-link" onClick={() => setEditing(shown)}>
                Edit title and description
              </button>
            ))}
        </WriteRow>
      )}
      {/* A pull request the person marked as done has no number here, so Open pull request
          asks again, and GitHub's answer names the one that is open. */}
      {(!proposal || proposal.state === 'refused' || proposal.state === 'applied') && (
        <div className="th-gh-actions">
          <button
            type="button"
            className="th-button"
            disabled={step.busy !== null}
            onClick={() => void open()}
          >
            Open pull request
          </button>
        </div>
      )}
      {link && (
        <p className="th-muted" role="status">
          {link.note}
        </p>
      )}
      {(link?.url ?? savedLink) && (
        <a href={link?.url ?? savedLink ?? undefined} target="_blank" rel="noreferrer">
          {link?.url ?? savedLink}
        </a>
      )}
      <StepMessage text={step.message} />
    </div>
  );
}

/** The newest title and description this thread gave the pull request. */
function currentText(effects: readonly RemoteEffect[], pr: PullRequestView): PullRequestText {
  let text: PullRequestText = { title: '', body: '', draft: pr.draft };
  for (const effect of effects) {
    if (effect.state !== 'applied') continue;
    const { request } = effect;
    if (request.kind === 'pr-open' && effect.observed?.created?.pr === pr.number)
      text = { ...text, title: request.title, body: request.body };
    if (request.kind === 'pr-update' && effect.target.pr === pr.number)
      text = { ...text, title: request.title ?? text.title, body: request.body ?? text.body };
  }
  return text;
}

/** The open pull request: its number and link, ready or draft, and an update to its text. */
function PullRequestState({
  source,
  taskId,
  branch,
  head,
  pr,
  effects,
  reread,
}: {
  source: ThreadSource;
  taskId: string;
  branch: string;
  head: string;
  pr: PullRequestView;
  effects: readonly RemoteEffect[];
  reread: () => void;
}) {
  const step = useWriteStep(reread);
  const [updating, setUpdating] = useState<PullRequestText | null>(null);
  const target = { repo: pr.repo, branch, pr: pr.number, headSha: head, baseRef: pr.baseRef };
  const ofPr = (kinds: RemoteEffect['kind'][]) => (effect: RemoteEffect) =>
    kinds.includes(effect.kind) && effect.target.pr === pr.number;
  const state = shownWrite(effects, ofPr(['pr-ready', 'pr-draft']), touched);
  const update = shownWrite(effects, ofPr(['pr-update']), touched);
  const merged = pr.merged;

  const propose = (key: string, request: Parameters<typeof proposeWrite>[1]['request']) =>
    step.run(key, () => proposeWrite(source, { taskId, target, request }));
  const previewUpdate = () => {
    if (!updating) return;
    void propose('update', {
      kind: 'pr-update',
      title: updating.title.trim() || branch,
      body: updating.body.trim(),
    }).then((answer) => answer?.effect && setUpdating(null));
  };

  return (
    <div className="th-gh-block">
      <p className="th-gh-line">
        <a href={pr.url} target="_blank" rel="noreferrer">
          Pull request #{pr.number}
        </a>
        <span className="th-muted">
          {merged ? `Merged as ${merged.slice(0, 7)}` : pr.draft ? 'Draft' : 'Ready for review'}
          {pr.baseRef ? `, into ${pr.baseRef}` : ''}
        </span>
      </p>
      {!merged && (
        <div className="th-gh-actions">
          {!writeOpen(state) && (
            <button
              type="button"
              className="th-button"
              disabled={step.busy !== null}
              onClick={() => void propose('state', { kind: pr.draft ? 'pr-ready' : 'pr-draft' })}
            >
              {pr.draft ? 'Ready for review' : 'Back to draft'}
            </button>
          )}
          {!writeOpen(update) && !updating && (
            <button
              type="button"
              className="th-button"
              disabled={step.busy !== null}
              onClick={() => setUpdating(currentText(effects, pr))}
            >
              Update title and description
            </button>
          )}
        </div>
      )}
      {state && (
        <WriteRow
          effect={state}
          confirmLabel={
            state.kind === 'pr-ready' ? 'Mark ready for review' : 'Turn back into a draft'
          }
          {...rowActions(source, step, state)}
        />
      )}
      {updating && (
        <>
          <PullRequestForm value={updating} onChange={setUpdating} withDraft={false} />
          <div className="th-gh-actions">
            <button
              type="button"
              className="th-button"
              disabled={step.busy !== null || !updating.title.trim()}
              onClick={previewUpdate}
            >
              Preview update
            </button>
            <button type="button" className="th-button" onClick={() => setUpdating(null)}>
              Close
            </button>
          </div>
        </>
      )}
      {update && (
        <WriteRow
          effect={update}
          confirmLabel="Update pull request"
          {...rowActions(source, step, update)}
        />
      )}
      <StepMessage text={step.message} />
    </div>
  );
}

const CI_POLL_MS = 30_000;

/** The CI runs of the accepted commit, read again every thirty seconds while the tab is open. */
function useBranchStatus(source: ThreadSource, taskId: string, branch: string) {
  const [status, setStatus] = useState<ChatBranchStatus | null>(null);
  // The panel only exists while the Changes tab is open, so unmounting it stops the polling.
  useEffect(() => {
    let active = true;
    const poll = () =>
      readBranchStatus(source, taskId, branch).then(
        (next) => active && setStatus(next),
        (failure: unknown) =>
          active &&
          setStatus({
            branch,
            deploy: null,
            runs: null,
            commit: null,
            headMoved: false,
            reason: failure instanceof Error ? failure.message : 'CI runs are unavailable.',
            readAt: new Date().toISOString(),
          }),
      );
    void poll();
    const timer = window.setInterval(() => void poll(), CI_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [source, taskId, branch]);
  return status;
}

type CiRun = NonNullable<ChatBranchStatus['runs']>[number];

// A finished run with no reported result reads as unknown, never as passed.
const runState = (run: { conclusion: string | null; status: string }) =>
  run.conclusion ?? (run.status === 'completed' ? 'result unknown' : run.status.replace('_', ' '));

const SENDING = 'Sending the log to the fixer.';
const SENT = 'Log sent to the fixer.';
const FAILED = new Set(['failure', 'timed_out']);
const PASSED = new Set(['success', 'neutral', 'skipped']);

function BranchStatus({
  source,
  taskId,
  branch,
  status,
  pr,
  effects,
  reread,
}: {
  source: ThreadSource;
  taskId: string;
  branch: string;
  status: ChatBranchStatus | null;
  /** A rerun names its pull request, so it is offered once one is open. */
  pr: PullRequestView | null;
  effects: readonly RemoteEffect[];
  reread: () => void;
}) {
  // What each job's send said, keyed by job id. A sent log stays sent while the tab is open.
  const [sent, setSent] = useState<Record<string, string>>({});
  const step = useWriteStep(reread);
  if (!status) return <p className="th-muted">Reading CI runs.</p>;
  const { commit } = status;
  async function send(run: CiRun, job: CiRun['jobs'][number]) {
    if (!commit) return;
    setSent((current) => ({ ...current, [job.id]: SENDING }));
    const answer = await sendJobToFixer(source, { taskId, commit, run, job });
    setSent((current) => ({
      ...current,
      [job.id]: answer.sent ? SENT : answer.message,
    }));
  }
  const jobActions = (run: CiRun, job: CiRun['jobs'][number]) => (
    <>
      {job.conclusion && FAILED.has(job.conclusion) && (
        <button
          type="button"
          className="th-button th-ci-send"
          disabled={sent[job.id] === SENDING || sent[job.id] === SENT}
          onClick={() => void send(run, job)}
        >
          Send to fixer
        </button>
      )}
      {sent[job.id] && (
        <span className="th-muted" role="status">
          {sent[job.id]}
        </span>
      )}
    </>
  );
  const rerun = (run: CiRun, failedOnly: boolean) => {
    if (!pr || !commit || !run.attempt) return;
    const { attempt } = run;
    void step.run(`rerun:${run.id}`, () =>
      proposeWrite(source, {
        taskId,
        target: { repo: pr.repo, branch, pr: pr.number, headSha: commit, baseRef: pr.baseRef },
        request: { kind: 'rerun', runId: run.id, attempt, failedOnly },
      }),
    );
  };
  return (
    <div className="th-ci">
      <p className="th-muted" role="status">
        {status.runs
          ? status.runs.length > 0
            ? `CI for ${commit?.slice(0, 7) ?? branch}`
            : `No CI runs for ${branch} yet.`
          : (status.reason ?? 'CI runs are unavailable.')}
      </p>
      {status.runs && status.reason && (
        <p className="th-muted" role="status">
          {status.reason}
        </p>
      )}
      {status.runs && status.runs.length > 0 && (
        <ul className="th-ci-list">
          {status.runs.map((run) => {
            const write = shownWrite(
              effects,
              (effect) => effect.request.kind === 'rerun' && effect.request.runId === run.id,
              touched,
            );
            // A run whose one job carries the run's own name would say the same thing twice. The
            // job folds into the run's line, and Send to fixer moves with it.
            const solo =
              run.jobs.length === 1 && run.jobs[0].name === run.name ? run.jobs[0] : null;
            const rerunnable =
              pr &&
              !pr.merged &&
              run.attempt !== null &&
              run.status === 'completed' &&
              !PASSED.has(run.conclusion ?? '') &&
              !writeOpen(write);
            return (
              <li key={run.id} className="th-ci-row">
                <span>
                  {run.name}: {runState(run)}
                  {run.attempt ? `, attempt ${run.attempt}` : ''}{' '}
                  <a href={run.url} title={run.url} target="_blank" rel="noreferrer">
                    Open run
                  </a>
                </span>
                {solo && jobActions(run, solo)}
                {rerunnable && (
                  <span className="th-gh-actions">
                    <button
                      type="button"
                      className="th-button th-ci-send"
                      disabled={step.busy !== null}
                      onClick={() => rerun(run, true)}
                    >
                      Rerun failed jobs
                    </button>
                    <button
                      type="button"
                      className="th-button th-ci-send"
                      disabled={step.busy !== null}
                      onClick={() => rerun(run, false)}
                    >
                      Rerun all
                    </button>
                  </span>
                )}
                {run.attempt === null ? (
                  <span className="th-muted">Jobs were not read.</span>
                ) : (
                  !solo && (
                    <ul className="th-ci-list th-ci-jobs">
                      {run.jobs.map((job) => (
                        <li key={job.id} className="th-ci-row">
                          <span>
                            {job.name}: {job.conclusion ?? job.status.replace('_', ' ')}
                          </span>
                          {jobActions(run, job)}
                        </li>
                      ))}
                    </ul>
                  )
                )}
                {write && (
                  <WriteRow
                    effect={write}
                    confirmLabel={
                      write.request.kind === 'rerun' && write.request.failedOnly
                        ? 'Rerun failed jobs'
                        : 'Rerun all jobs'
                    }
                    {...rowActions(source, step, write)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <StepMessage text={step.message} />
      {status.deploy && <DeployStatus deploy={status.deploy} />}
    </div>
  );
}

/**
 * What GitHub ran for the merge commit and where it deployed it. Read only. A list or a
 * deployment CrewKite could not read says unknown and never reads as passed.
 */
function DeployStatus({ deploy }: { deploy: NonNullable<ChatBranchStatus['deploy']> }) {
  const empty = deploy.runs?.length === 0 && deploy.deployments?.length === 0;
  return (
    <div className="th-ci">
      <p className="th-muted" role="status">
        After the merge, {deploy.commit.slice(0, 7)} on {deploy.base}
      </p>
      {deploy.runs?.length ? (
        <ul className="th-ci-list">
          {deploy.runs.map((run) => (
            <li key={run.id} className="th-ci-row">
              <span>
                {run.name}: {runState(run)}{' '}
                <a href={run.url} title={run.url} target="_blank" rel="noreferrer">
                  Open run
                </a>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {deploy.deployments?.length ? (
        <ul className="th-ci-list">
          {deploy.deployments.map((entry) => (
            <li key={entry.id} className="th-ci-row">
              <span>
                Deploy to {entry.environment}: {entry.state.replace('_', ' ')}
                {entry.url && (
                  <>
                    {' '}
                    <a href={entry.url} title={entry.url} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {empty && <p className="th-muted">Nothing has reported for the merge commit yet.</p>}
      {deploy.reason && (
        <p className="th-muted" role="status">
          {deploy.reason}
        </p>
      )}
      {deploy.following && !deploy.reason && (
        <p className="th-muted" role="status">
          Still running. This reads again every 30 seconds.
        </p>
      )}
    </div>
  );
}

type Comment = ReviewCommentsRead['files'][number]['comments'][number];

/**
 * The pull request's review comments by file, read for the head this thread pushed. Picked
 * comments go to the fixer as one message. A reply is its own write with a preview to confirm.
 */
function ReviewComments({
  source,
  taskId,
  branch,
  head,
  pr,
  effects,
  reread,
}: {
  source: ThreadSource;
  taskId: string;
  branch: string;
  head: string;
  pr: PullRequestView;
  effects: readonly RemoteEffect[];
  reread: () => void;
}) {
  const [read, setRead] = useState<ReviewCommentsRead | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [sent, setSent] = useState<string | null>(null);
  const [replying, setReplying] = useState<{ id: string; text: string } | null>(null);
  const step = useWriteStep(reread);
  const { repo, number } = pr;
  const { host, owner, name } = repo;

  // The read goes to GitHub, so it runs again only for another pull request or head, or when the
  // person asks. A new list of writes does not read it again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads asks for a new read
  useEffect(() => {
    let active = true;
    setFailure(null);
    const place = { host, owner, name };
    readReviewComments(source, { taskId, repo: place, pr: number, headSha: head }).then(
      (next) => {
        if (!active) return;
        setRead(next);
        setPicked(new Set());
      },
      (error: unknown) => {
        if (!active) return;
        setRead(null);
        setFailure(error instanceof Error ? error.message : 'Review comments are unavailable.');
      },
    );
    return () => {
      active = false;
    };
  }, [source, taskId, host, owner, name, number, head, reads]);

  const comments = read?.files.flatMap((file) =>
    file.comments.map((comment) => ({ ...comment, path: file.path })),
  );
  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  async function send() {
    const chosen = comments?.filter((comment) => picked.has(comment.id)) ?? [];
    if (!chosen.length) return;
    setSent('Sending the comments to the fixer.');
    const answer = await sendCommentsToFixer(source, {
      taskId,
      pr: number,
      head,
      comments: chosen,
    });
    setSent(
      answer.sent
        ? `${chosen.length === 1 ? '1 comment' : `${chosen.length} comments`} sent to the fixer.`
        : answer.message,
    );
    if (answer.sent) setPicked(new Set());
  }
  const previewReply = (comment: Comment) => {
    if (!replying?.text.trim()) return;
    void step
      .run(`reply:${comment.id}`, () =>
        proposeWrite(source, {
          taskId,
          target: { repo, branch, pr: number, headSha: head, baseRef: pr.baseRef },
          request: { kind: 'review-reply', commentId: comment.id, body: replying.text.trim() },
        }),
      )
      .then((answer) => answer?.effect && setReplying(null));
  };

  return (
    <section className="th-gh-block" aria-label="Review comments">
      <div className="th-gh-head">
        <p className="th-gh-title">Review comments</p>
        <button type="button" className="th-gh-link" onClick={() => setReads((count) => count + 1)}>
          Read again
        </button>
      </div>
      {!read && !failure && <p className="th-muted">Reading review comments.</p>}
      {failure && (
        <p className="th-error" role="alert">
          {failure}
        </p>
      )}
      {read && read.files.length === 0 && (
        <p className="th-muted">No review comments on #{number} yet.</p>
      )}
      {read?.files.map((file) => (
        <div key={file.path} className="th-gh-file">
          <p className="th-path" title={file.path}>
            {file.path}
          </p>
          <ul className="th-gh-comments">
            {file.comments.map((comment) => {
              const write = shownWrite(
                effects,
                (effect) =>
                  effect.request.kind === 'review-reply' && effect.request.commentId === comment.id,
                touched,
              );
              return (
                <li
                  key={comment.id}
                  className={comment.inReplyTo ? 'th-gh-comment is-reply' : 'th-gh-comment'}
                >
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={picked.has(comment.id)}
                      onChange={() => toggle(comment.id)}
                    />
                    <span className="th-muted">
                      {comment.line ? `Line ${comment.line}` : 'File'}, {comment.author}
                    </span>
                  </label>
                  <p className="th-gh-body">{comment.body}</p>
                  {!comment.inReplyTo && !writeOpen(write) && replying?.id !== comment.id && (
                    <button
                      type="button"
                      className="th-gh-link"
                      onClick={() => setReplying({ id: comment.id, text: '' })}
                    >
                      Reply
                    </button>
                  )}
                  {replying?.id === comment.id && (
                    <div className="th-gh-form">
                      <label>
                        Reply to {comment.author}
                        <textarea
                          value={replying.text}
                          rows={3}
                          maxLength={16_384}
                          onChange={(event) =>
                            setReplying({ id: comment.id, text: event.target.value })
                          }
                        />
                      </label>
                      <div className="th-gh-actions">
                        <button
                          type="button"
                          className="th-button"
                          disabled={step.busy !== null || !replying.text.trim()}
                          onClick={() => previewReply(comment)}
                        >
                          Preview reply
                        </button>
                        <button
                          type="button"
                          className="th-button"
                          onClick={() => setReplying(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {write && (
                    <WriteRow
                      effect={write}
                      confirmLabel="Post reply"
                      {...rowActions(source, step, write)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {read?.truncated && (
        <p className="th-muted">Only the newest {comments?.length} comments were read.</p>
      )}
      {read && read.files.length > 0 && (
        <div className="th-gh-actions">
          <button
            type="button"
            className="th-button"
            disabled={picked.size === 0}
            onClick={() => void send()}
          >
            {picked.size > 1 ? `Send ${picked.size} to fixer` : 'Send to fixer'}
          </button>
          {sent && (
            <span className="th-muted" role="status">
              {sent}
            </span>
          )}
        </div>
      )}
      <StepMessage text={step.message} />
    </section>
  );
}

/**
 * Merge by the repository's method. It waits with the reason while the head moved, the pull
 * request is a draft or a check on the head is not green. The proposal merges the head onto the
 * base first and reads GitHub's required checks and rules, and Confirm names the head it merges.
 */
function MergeStep({
  source,
  taskId,
  branch,
  head,
  pr,
  status,
  method,
  remote,
  effects,
  reread,
}: {
  source: ThreadSource;
  taskId: string;
  branch: string;
  head: string;
  pr: PullRequestView;
  status: ChatBranchStatus | null;
  method: RepositoryPolicy['mergeMethod'];
  remote: string;
  effects: readonly RemoteEffect[];
  reread: () => void;
}) {
  const step = useWriteStep(reread);
  const [conflicts, setConflicts] = useState<{ paths: string[]; text: string } | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const write = shownWrite(
    effects,
    (effect) => effect.kind === 'merge' && effect.target.pr === pr.number,
    touched,
  );
  const checks = status ? checksSummary(status) : { line: 'Reading the checks.', wait: null };
  // GitHub's refusal holds Merge for the head and the reading of the checks it was made on. A new
  // head or a new reading lets the person ask again, and Check again asks now, since a review can
  // land at any time.
  const [refusal, setRefusal] = useState<{ reading: string; reason: string } | null>(null);
  const reading = `${head}\n${checks.line}`;
  const refused = refusal?.reading === reading ? refusal.reason : null;
  // GitHub's own read of the required checks and the merge state, made for each new reading before
  // the click. A refusal holds Merge like the proposal's own, and a clean read names what it found.
  const [ready, setReady] = useState<{ reading: string; line: string } | null>(null);
  const wait = mergeWait({
    headMoved: Boolean(status?.headMoved),
    draft: pr.draft,
    head,
    checks: status ? checks : { wait: 'Wait for the checks to be read.' },
    refused,
  });
  const label = MERGE_LABELS[method];
  // A merge the person marked as done names no merge commit, so the pull request does not read
  // as merged. Merge still stays away, since GitHub would refuse a pull request that is closed.
  const offered = !writeOpen(write) && write?.state !== 'applied';
  // A moved head, a draft or a run that is not green holds Merge anyway, so GitHub is not asked.
  const held = Boolean(status?.headMoved) || pr.draft || Boolean(checks.wait);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new reading asks GitHub again
  useEffect(() => {
    if (!status || !offered || held) return;
    let active = true;
    readMergeReadiness(source, taskId).then(
      (read) => {
        if (!active || read.headSha !== head) return;
        if (read.reason) setRefusal({ reading, reason: read.reason });
        else if (read.line) setReady({ reading, line: read.line });
      },
      // An unreadable answer leaves Merge to the proposal's own read.
      () => {},
    );
    return () => {
      active = false;
    };
  }, [source, taskId, reading, offered, held]);

  const propose = () =>
    step.run('merge', async () => {
      setConflicts(null);
      setResolving(null);
      setRefusal(null);
      const answer = await proposeWrite(source, {
        taskId,
        target: { repo: pr.repo, branch, pr: pr.number, headSha: head, baseRef: pr.baseRef },
        request: { kind: 'merge', method, expectedHead: head },
      });
      if (answer.mergeCheck?.state === 'conflicts') {
        setConflicts({ paths: answer.mergeCheck.paths, text: answer.message ?? '' });
        return { ...answer, ok: true, message: null };
      }
      if (answer.reason === 'merge-not-ready' && answer.message) {
        setRefusal({ reading, reason: answer.message });
        return { ...answer, ok: true, message: null };
      }
      return answer;
    });
  const resolve = () => {
    if (!pr.baseRef) return;
    const base = pr.baseRef;
    void step
      .run('resolve', () => checkChatMerge(source, { taskId, remote, base }))
      .then((answer) => {
        if (!answer?.ok) return;
        setConflicts(null);
        setResolving(answer.message);
      });
  };

  return (
    <section className="th-gh-block" aria-label="Merge">
      <p className="th-gh-title">Merge</p>
      <p className="th-muted" role="status">
        {checks.line}
      </p>
      {offered && !wait && ready?.reading === reading && <p className="th-muted">{ready.line}</p>}
      {offered && (
        <div className="th-gh-actions">
          <button
            type="button"
            className="th-button"
            disabled={step.busy !== null || Boolean(wait)}
            title={wait ?? undefined}
            onClick={() => void propose()}
          >
            {label}
          </button>
        </div>
      )}
      {wait && offered && (
        <p className="th-gh-line" role="status">
          <span className="th-muted">{wait}</span>
          {wait === refused && (
            <button
              type="button"
              className="th-gh-link"
              disabled={step.busy !== null}
              onClick={() => void propose()}
            >
              Check again
            </button>
          )}
        </p>
      )}
      {conflicts && (
        <div className="th-gh-write is-refused">
          <p className="th-gh-state" role="status">
            <span className="th-gh-pill">Conflicts</span>
            <span>{conflicts.text}</span>
          </p>
          <div className="th-gh-actions">
            <button
              type="button"
              className="th-button"
              disabled={step.busy !== null}
              onClick={resolve}
            >
              Resolve conflicts
            </button>
          </div>
        </div>
      )}
      {resolving && (
        <p className="th-muted" role="status">
          {resolving}
        </p>
      )}
      {write && (
        <WriteRow
          effect={write}
          confirmLabel={
            write.request.kind === 'merge'
              ? `${MERGE_LABELS[write.request.method]} ${write.request.expectedHead.slice(0, 7)}`
              : label
          }
          {...rowActions(source, step, write)}
        />
      )}
      <StepMessage text={step.message} />
    </section>
  );
}

/**
 * Every step here is the person's click. Push asks once more, because it publishes the branch to a
 * remote with their own git credentials, and sends the branch and commit that question showed. A
 * commit accepted after the last push, such as a resolved merge, asks again. A push still running
 * or unknown, on any branch, shows its row with Check where Push was, and Push waits for it. After
 * the push, the pull request, CI, review comments and merge follow, each write proposed and
 * confirmed.
 */
export function GitSteps({
  source,
  taskId,
  branch,
  commit,
  thread,
  message,
  method,
}: {
  source: ThreadSource;
  taskId: string;
  branch: string;
  commit: string | null;
  thread: ChatThread | null;
  message: string;
  method: RepositoryPolicy['mergeMethod'];
}) {
  // The branch and commit the push question showed. A thread that accepts again meanwhile does not
  // change what the answer sends, and the controller refuses a commit it no longer holds.
  const [asked, setAsked] = useState<{ branch: string; commit: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pushedCommit, setPushedCommit] = useState<string | null>(null);
  const { effects, reread } = useRemoteWrites(source, taskId);
  const step = useWriteStep(reread);
  const journal = thread?.lastPush?.branch === branch ? thread.lastPush : null;
  const pushed = commit !== null && (journal?.commit === commit || pushedCommit === commit);
  const pushWrite = pushShown(effects, branch, touched);
  const holding = writeOpen(pushWrite);

  async function push() {
    if (!asked) return;
    const shown = asked;
    setBusy(true);
    setRefusal(null);
    setAsked(null);
    try {
      const answer = await pushBranch(source, taskId, shown.branch, shown.commit);
      if (answer.done) setPushedCommit(shown.commit);
      else setRefusal(answer.message);
    } catch (failure) {
      setRefusal(failure instanceof Error ? failure.message : 'The step did not run.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="th-changes">
      {pushWrite?.request.kind === 'push' && (holding || (!pushed && pushWrite.settled)) && (
        <WriteRow effect={pushWrite} confirmLabel="Push" {...rowActions(source, step, pushWrite)}>
          <p className="th-muted">
            Push of {pushWrite.request.commit.slice(0, 12)} to {pushWrite.target.branch} on{' '}
            {pushWrite.request.remote}
          </p>
        </WriteRow>
      )}
      {!pushed &&
        !holding &&
        (asked ? (
          <div>
            <p>
              Push commit {asked.commit.slice(0, 12)} to {asked.branch} on {PUSH_REMOTE} with your
              own git credentials? Git refuses it if {asked.branch} moved there.
            </p>
            <button type="button" className="th-button" disabled={busy} onClick={() => void push()}>
              Push
            </button>{' '}
            <button type="button" className="th-button" onClick={() => setAsked(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="th-button"
            disabled={busy || !commit}
            title={commit ? undefined : 'Accept again to record the commit, then push.'}
            onClick={() => commit && setAsked({ branch, commit })}
          >
            Push branch
          </button>
        ))}
      <StepMessage text={step.message} />
      {(journal || pushed) && (
        <GitHubAfterPush
          source={source}
          taskId={taskId}
          branch={branch}
          head={pushed ? commit : (journal?.commit ?? null)}
          remote={journal?.remote ?? PUSH_REMOTE}
          savedLink={journal?.pullRequestUrl ?? null}
          message={message}
          method={method}
          effects={effects}
          reread={reread}
        />
      )}
      {refusal && !holding && (
        <p className="th-error" role="alert">
          {refusal}
        </p>
      )}
    </div>
  );
}

function GitHubAfterPush({
  source,
  taskId,
  branch,
  head,
  remote,
  savedLink,
  message,
  method,
  effects,
  reread,
}: {
  source: ThreadSource;
  taskId: string;
  branch: string;
  head: string | null;
  remote: string;
  savedLink: string | null;
  message: string;
  method: RepositoryPolicy['mergeMethod'];
  effects: readonly RemoteEffect[];
  reread: () => void;
}) {
  const status = useBranchStatus(source, taskId, branch);
  const pr = pullRequestOf(effects, branch);
  return (
    <div className="th-gh">
      <p className="th-muted" role="status">
        Pushed {branch} to {remote}
      </p>
      {pr && head ? (
        <PullRequestState
          source={source}
          taskId={taskId}
          branch={branch}
          head={head}
          pr={pr}
          effects={effects}
          reread={reread}
        />
      ) : (
        <OpenPullRequest
          source={source}
          taskId={taskId}
          branch={branch}
          message={message}
          effects={effects}
          reread={reread}
          savedLink={pr ? null : savedLink}
        />
      )}
      <BranchStatus
        source={source}
        taskId={taskId}
        branch={branch}
        status={status}
        pr={pr}
        effects={effects}
        reread={reread}
      />
      {pr && head && (
        <ReviewComments
          source={source}
          taskId={taskId}
          branch={branch}
          head={head}
          pr={pr}
          effects={effects}
          reread={reread}
        />
      )}
      {pr && head && !pr.merged && (
        <MergeStep
          source={source}
          taskId={taskId}
          branch={branch}
          head={head}
          pr={pr}
          status={status}
          method={method}
          remote={remote}
          effects={effects}
          reread={reread}
        />
      )}
    </div>
  );
}
