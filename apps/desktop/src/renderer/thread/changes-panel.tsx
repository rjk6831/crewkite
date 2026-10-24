import type { ChatBranchStatus, ChatChangesRead, ChatThread } from '@crewkite/contracts';
import { ChevronRight } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { lineClass } from './cards.tsx';
import {
  type Acceptance,
  acceptChanges,
  openPullRequest,
  pushBranch,
  readBranchStatus,
  readChanges,
  type ThreadSource,
} from './commands.ts';
import { CodeBlock } from './markdown.tsx';

const refusals: Record<string, string> = {
  'turn-running': 'A reply is still running. Accept when it ends.',
  'no-changes': 'The scratch copy has no changes to accept.',
  'branch-exists': 'That branch already exists. Choose another name.',
  'branch-name-unsupported': 'Use lower case letters, digits, hyphens and slashes.',
  'base-moved':
    "The project moved past this thread's base commit. Start a new thread on the current commit.",
  'git-identity-missing': 'Set a Git name and email on this machine, then accept again.',
  'scratch-unreadable':
    'The scratch copy holds links or special files. Ask the assistant to remove them.',
  'branch-not-created': 'The branch was not created. Choose another name and try again.',
};

type Files = ChatChangesRead['files'];

// The diff each thread last accepted. While the Changes tab shows the same diff, the branch already
// holds it and a second acceptance would only collide with that branch name.
// shortcut: kept while the window stays open. The thread record has the file count only, which
// cannot prove the diff is the same, so after a restart the button is enabled again.
// Upgrade: store a digest of the accepted diff on the thread record.
const acceptedDiffs = new Map<string, { branch: string; files: Files }>();

const sameFiles = (left: Files, right: Files) =>
  left.length === right.length &&
  left.every(
    (file, index) =>
      file.path === right[index].path &&
      file.additions === right[index].additions &&
      file.deletions === right[index].deletions &&
      file.patch === right[index].patch,
  );

// The controller takes lower case letters, digits, hyphens and slashes. A title with none of
// those still gets a name that is unique to the thread.
function branchName(title: string, taskId: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return `crewkite/${slug || taskId.slice(-8).toLowerCase()}`;
}

// The title names the change. The first line of the last reply is usually the assistant's own
// summary of what it did, which is the closest thing to a commit body the thread already has.
function suggestedMessage(title: string, reply: string | undefined) {
  const subject = title.replace(/\s+/g, ' ').trim();
  const summary = reply
    ?.split('\n')
    .map((line) => line.replace(/^[#>*\-\s]+/, '').trim())
    .find(Boolean)
    ?.slice(0, 200);
  return summary ? `${subject}\n\n${summary}` : subject;
}

const CI_POLL_MS = 30_000;

function runLine(status: ChatBranchStatus) {
  if (!status.runs) return status.reason ?? 'CI runs are unavailable.';
  const newest = status.runs[0];
  if (!newest) return `No CI runs for ${status.branch} yet.`;
  return `${newest.name}: ${newest.conclusion ?? newest.status.replace('_', ' ')}`;
}

function BranchStatus({
  source,
  taskId,
  branch,
}: {
  source: ThreadSource;
  taskId: string;
  branch: string;
}) {
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
            runs: null,
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
  if (!status) return <p className="th-muted">Reading CI runs.</p>;
  const newest = status.runs?.[0];
  return (
    <p className="th-muted" role="status">
      CI {runLine(status)}
      {newest && (
        <>
          {' '}
          <a href={newest.url} title={newest.url} target="_blank" rel="noreferrer">
            Open run
          </a>
        </>
      )}
    </p>
  );
}

// Every step here is the person's click. Push asks once more, because it is the first action that
// sends anything off this computer, and it runs with their own git credentials.
function GitSteps({
  source,
  taskId,
  branch,
  commit,
  thread,
  message,
}: {
  source: ThreadSource;
  taskId: string;
  branch: string;
  commit: string | null;
  thread: ChatThread | null;
  message: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pushedHere, setPushedHere] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const journal = thread?.lastPush?.branch === branch ? thread.lastPush : null;
  const pushed = pushedHere || Boolean(journal);
  const pullRequestUrl = opened ?? journal?.pullRequestUrl ?? null;

  async function step(action: () => Promise<void>) {
    setBusy(true);
    setRefusal(null);
    try {
      await action();
    } catch (failure) {
      setRefusal(failure instanceof Error ? failure.message : 'The step did not run.');
    } finally {
      setBusy(false);
    }
  }
  const push = () =>
    step(async () => {
      setConfirming(false);
      const answer = await pushBranch(source, taskId, branch);
      if (answer.done) setPushedHere(true);
      else setRefusal(answer.message);
    });
  const open = () =>
    step(async () => {
      const [title = branch, ...rest] = message.split('\n');
      const answer = await openPullRequest(source, {
        taskId,
        branch,
        title: title.trim() || branch,
        body: rest.join('\n').trim(),
      });
      if (!answer.done) {
        setRefusal(answer.message);
        return;
      }
      setOpened(answer.url);
      if (answer.via !== 'compare-link' || !answer.url) {
        setNotice('Pull request opened.');
        return;
      }
      try {
        await navigator.clipboard.writeText(answer.url);
        setNotice('Compare link copied.');
      } catch {
        // The clipboard can be blocked. The link below stays selectable.
        setNotice('Copy the compare link below.');
      }
    });

  return (
    <div className="th-changes">
      {!pushed &&
        (confirming ? (
          <div>
            <p>
              Push {branch} to origin with your own git credentials? Nothing else leaves this
              computer.
            </p>
            <button type="button" className="th-button" disabled={busy} onClick={() => void push()}>
              Push
            </button>{' '}
            <button type="button" className="th-button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="th-button"
            disabled={busy || !commit}
            title={commit ? undefined : 'Accept again to record the commit, then push.'}
            onClick={() => setConfirming(true)}
          >
            Push branch
          </button>
        ))}
      {pushed && (
        <>
          <p className="th-muted" role="status">
            Pushed {branch} to {journal?.remote ?? 'origin'}
          </p>
          <button type="button" className="th-button" disabled={busy} onClick={() => void open()}>
            Open pull request
          </button>
          {notice && (
            <p className="th-muted" role="status">
              {notice}
            </p>
          )}
          {pullRequestUrl && (
            <a href={pullRequestUrl} target="_blank" rel="noreferrer">
              {pullRequestUrl}
            </a>
          )}
          <BranchStatus source={source} taskId={taskId} branch={branch} />
        </>
      )}
      {refusal && (
        <p className="th-error" role="alert">
          {refusal}
        </p>
      )}
    </div>
  );
}

function AcceptControl({
  source,
  taskId,
  title,
  thread,
  files,
  lastReply,
}: {
  source: ThreadSource;
  taskId: string;
  title: string;
  thread: ChatThread | null;
  files: Files;
  lastReply: string | undefined;
}) {
  const [branch, setBranch] = useState(() => branchName(title, taskId));
  const [message, setMessage] = useState(() => suggestedMessage(title, lastReply));
  const edited = useRef(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Extract<Acceptance, { accepted: true }> | null>(null);
  // The command result shows at once. The thread record keeps it for the next time the tab opens.
  const last = accepted ?? thread?.lastAcceptance ?? null;
  const diff = acceptedDiffs.get(taskId);
  const done = Boolean(last && diff?.branch === last.branch && sameFiles(diff.files, files));

  // The suggestion follows the last reply that wrote the copy. Once the person types, it stays
  // theirs.
  useEffect(() => {
    if (!edited.current) setMessage(suggestedMessage(title, lastReply));
  }, [title, lastReply]);

  async function accept(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setRefusal(null);
    try {
      const answer = await acceptChanges(source, {
        taskId,
        branch: branch.trim(),
        ...(message.trim() ? { message: message.trim() } : {}),
      });
      if (answer.accepted) {
        acceptedDiffs.set(taskId, { branch: answer.branch, files });
        setAccepted(answer);
      } else setRefusal(refusals[answer.reason] ?? answer.next ?? 'The changes were not accepted.');
    } catch (failure) {
      setRefusal(failure instanceof Error ? failure.message : 'The changes were not accepted.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="th-changes" onSubmit={(event) => void accept(event)}>
      <label>
        New local branch
        <input
          value={branch}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setBranch(event.target.value)}
        />
      </label>
      <label>
        Commit message
        <textarea
          value={message}
          rows={4}
          maxLength={4096}
          spellCheck
          onChange={(event) => {
            edited.current = true;
            setMessage(event.target.value);
          }}
        />
      </label>
      <button
        type="submit"
        className="th-button"
        disabled={
          busy || done || files.length === 0 || Boolean(thread?.activeTurnId) || !branch.trim()
        }
        title={done && last ? `These changes are on ${last.branch}.` : undefined}
      >
        Accept to branch
      </button>
      {refusal && (
        <p className="th-error" role="alert">
          {refusal}
        </p>
      )}
      {last && (
        <>
          <p className="th-muted" role="status">
            On branch {last.branch}
            {last.commit && ` (${last.commit.slice(0, 7)})`}
          </p>
          <CodeBlock lang="sh" text={`git switch ${last.branch}`} />
          <GitSteps
            source={source}
            taskId={taskId}
            branch={last.branch}
            commit={last.commit}
            thread={thread}
            message={message}
          />
        </>
      )}
    </form>
  );
}

export function ChangesPanel({
  source,
  taskId,
  title,
  thread,
  refreshKey,
  focusPath,
  lastReply,
}: {
  source: ThreadSource;
  taskId: string;
  title: string;
  thread: ChatThread | null;
  refreshKey: number;
  focusPath: string | null;
  /** The text of the last builder or fixer reply, for the commit message suggestion. */
  lastReply: string | undefined;
}) {
  const [data, setData] = useState<ChatChangesRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const focused = useRef<HTMLLIElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey asks for a new read
  useEffect(() => {
    let active = true;
    readChanges(source, taskId).then(
      (next) => {
        if (!active) return;
        setData(next);
        setError(null);
      },
      (failure: unknown) => {
        if (active)
          setError(failure instanceof Error ? failure.message : 'Changes are unavailable.');
      },
    );
    return () => {
      active = false;
    };
  }, [source, taskId, refreshKey]);
  useEffect(() => {
    if (!focusPath) return;
    setOpen((current) => new Set(current).add(focusPath));
    focused.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focusPath]);

  if (error)
    return (
      <p className="th-error" role="alert">
        {error}
      </p>
    );
  if (!data) return <p className="th-muted">Reading changes.</p>;
  const additions = data.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = data.files.reduce((sum, file) => sum + file.deletions, 0);
  const accept = (
    <AcceptControl
      source={source}
      taskId={taskId}
      title={title}
      thread={thread}
      files={data.files}
      lastReply={lastReply}
    />
  );
  if (data.files.length === 0)
    return (
      <div className="th-changes">
        {accept}
        <p className="th-muted">
          No edits yet. Changes made in the scratch copy appear here against the base commit.
        </p>
      </div>
    );
  return (
    <div className="th-changes">
      {accept}
      <p className="th-muted">
        {data.files.length} {data.files.length === 1 ? 'file' : 'files'}{' '}
        <span className="is-add">+{additions}</span> <span className="is-del">-{deletions}</span>
        {data.base && <> against {data.base.slice(0, 7)}</>}
      </p>
      <ul>
        {data.files.map((file) => {
          const expanded = open.has(file.path);
          return (
            <li key={file.path} ref={file.path === focusPath ? focused : undefined}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => {
                  const next = new Set(open);
                  if (!next.delete(file.path)) next.add(file.path);
                  setOpen(next);
                }}
              >
                <ChevronRight size={13} className="th-chevron" aria-hidden="true" />
                <span className="th-path" title={file.path}>
                  {file.path}
                </span>
                <span className="is-add">+{file.additions}</span>
                <span className="is-del">-{file.deletions}</span>
              </button>
              {expanded &&
                (file.patch ? (
                  <pre className="th-patch">
                    {file.patch.split('\n').map((line, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: patch lines have no identity beyond their position
                      <span key={index} className={lineClass(line)}>
                        {line || ' '}
                      </span>
                    ))}
                  </pre>
                ) : (
                  <p className="th-muted">No patch text for this file.</p>
                ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
