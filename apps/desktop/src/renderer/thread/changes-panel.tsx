import {
  type AcceptanceAttempt,
  type ChatChangesRead,
  type ChatThread,
  DEFAULT_REPOSITORY_POLICY,
  type RepositoryPolicy,
  suggestedSubject,
} from '@crewkite/contracts';
import { ChevronRight } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { lineClass } from './cards.tsx';
import {
  type Acceptance,
  acceptanceCheckWords,
  acceptanceWords,
  acceptChanges,
  cancelAcceptance,
  discardChange,
  readAcceptance,
  readChanges,
  readRepositoryPolicy,
  type ThreadSource,
} from './commands.ts';
import { GitSteps } from './github-section.tsx';
import { HunkView } from './hunk-view.tsx';
import { CodeBlock } from './markdown.tsx';
import { PrepareButton, PrepareStatus, type Preparing } from './prepare-dependencies.tsx';

const refusals: Record<string, string> = {
  'turn-running': 'A reply is still running. Accept when it ends.',
  'no-changes': 'The scratch copy has no changes to accept.',
  'branch-exists': 'That branch already exists. Choose another name.',
  'branch-name-unsupported': 'Use lower case letters, digits, hyphens and slashes.',
  'git-identity-missing': 'Set a Git name and email on this machine, then accept again.',
  'scratch-unreadable':
    'The scratch copy holds new links or special files, or a link from the base commit changed. Restore them, then accept again.',
  'branch-not-created': 'The branch was not created. Choose another name and try again.',
  'listing-changed': 'The changes moved since this list was read. Review the list again.',
};

type Files = ChatChangesRead['files'];
type Skipped = NonNullable<ChatThread['skipped']>;

// Pages a read can take before it starts over, so a list that keeps moving cannot loop forever.
const MAX_PAGE_ATTEMPTS = 3;

/**
 * Every page of the Changes list under one listing, so the tab shows each entry once and Accept
 * names the list the person saw. A list that moves between pages is read again from the start.
 */
async function readAllPages(
  source: ThreadSource,
  taskId: string,
  active: () => boolean,
): Promise<ChatChangesRead | null> {
  for (let attempt = 0; attempt < MAX_PAGE_ATTEMPTS; attempt++) {
    const first = await readChanges(source, taskId);
    const files = [...first.files];
    let next = first.next;
    try {
      while (next && first.listing && active()) {
        const page = await readChanges(source, taskId, { after: next, listing: first.listing });
        files.push(...page.files);
        next = page.next;
      }
    } catch (failure) {
      if (attempt + 1 < MAX_PAGE_ATTEMPTS) continue;
      throw failure;
    }
    return active() ? { ...first, files, next: null } : null;
  }
  return null;
}

// The diff each thread last accepted. While the Changes tab shows the same diff, the branch already
// holds it and a second acceptance would only collide with that branch name. The note says where
// the branch starts when HEAD had moved, and it stays when the tab closes and opens again.
// shortcut: kept while the window stays open. The thread record has the file count only, which
// cannot prove the diff is the same, so after a restart the button is enabled again.
// Upgrade: store a digest of the accepted diff on the thread record.
const acceptedDiffs = new Map<string, { branch: string; files: Files; note: string | null }>();

const sameFiles = (left: Files, right: Files) =>
  left.length === right.length &&
  left.every(
    (file, index) =>
      file.path === right[index].path &&
      file.additions === right[index].additions &&
      file.deletions === right[index].deletions &&
      file.patch === right[index].patch,
  );

// The default commit policy takes a type, a slash, then lower case letters, digits and hyphens. A
// title with none of those still gets a name that is unique to the thread.
function branchName(title: string, taskId: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return `feat/${slug || taskId.slice(-8).toLowerCase()}`;
}

/** Each required check of an Accept and where it stands. */
function RequiredChecks({ attempt }: { attempt: AcceptanceAttempt }) {
  return (
    <ul className="th-ci-list">
      {attempt.requiredChecks.map((check) => (
        <li key={check.checkId} className="th-ci-row">
          <span>
            {check.label}: {acceptanceCheckWords[check.status]}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AcceptControl({
  source,
  taskId,
  title,
  thread,
  files,
  listing,
  policy,
  onAccepted,
  preparing,
}: {
  source: ThreadSource;
  taskId: string;
  title: string;
  thread: ChatThread | null;
  files: Files;
  /** The listing every page was read under. Accept publishes that list or refuses. */
  listing: string | null;
  policy: RepositoryPolicy;
  /** The base advances to the accepted commit, so the diff needs a new read. */
  onAccepted: () => void;
  preparing?: Preparing;
}) {
  const [branch, setBranch] = useState(() => branchName(title, taskId));
  // The thread title names the change, so it is the subject the policy takes as it stands. The
  // body stays empty for the person to write, since the start of a reply read as the model
  // talking about its next step.
  const suggested = suggestedSubject(title, policy.subjectMax);
  const method = policy.mergeMethod;
  const [message, setMessage] = useState(suggested);
  const edited = useRef(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Extract<Acceptance, { accepted: true }> | null>(null);
  // The command result shows at once. The thread record keeps it for the next time the tab opens.
  const last = accepted ?? thread?.lastAcceptance ?? null;
  const diff = acceptedDiffs.get(taskId);
  const done = Boolean(last && diff?.branch === last.branch && sameFiles(diff.files, files));
  const note = accepted?.note ?? (last && diff?.branch === last.branch ? diff.note : null);
  const waiting = thread?.pendingMerge ?? null;
  const mergeTarget = waiting?.target ?? null;
  const mergeFrom = waiting ? `${waiting.remote}/${waiting.branch}` : null;

  // The suggestion follows the thread title. Once the person types, it stays theirs.
  useEffect(() => {
    if (!edited.current && !mergeFrom) setMessage(suggested);
  }, [suggested, mergeFrom]);
  // A merge waiting in the copy goes on the accepted branch. The message field starts empty for
  // every merge method, since the controller then writes the merge's own message under the policy
  // it holds, or keeps the accepted message under rebase. A policy read that failed here cannot
  // put the wrong one in.
  useEffect(() => {
    if (!mergeTarget || !mergeFrom) return;
    setBranch(mergeTarget);
    setMessage('');
    edited.current = false;
  }, [mergeTarget, mergeFrom]);

  // An Accept with checks on holds the thread until they pass and the branch is written. The tab
  // reads it when it opens, then on each thread change while it holds: every check it runs, and
  // its end, change the thread.
  const [checking, setChecking] = useState<AcceptanceAttempt | null>(null);
  const [ended, setEnded] = useState<AcceptanceAttempt | null>(null);
  const watching = useRef(true);
  const watched = useRef<{ id: string; files: Files } | null>(null);
  // A fast check can end before the Accept's answer arrives, so starting one reads once more.
  const [started, setStarted] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a thread change is when the attempt moves
  useEffect(() => {
    if (!watching.current) return;
    let active = true;
    readAcceptance(source, taskId).then(
      (read) => {
        if (!active) return;
        const seen = watched.current;
        const done = seen && read.last?.id === seen.id ? read.last : null;
        watched.current = read.current
          ? { id: read.current.id, files: seen?.id === read.current.id ? seen.files : files }
          : null;
        watching.current = read.current !== null;
        setChecking(read.current);
        if (!done) return;
        setEnded(done);
        if (done.state !== 'published' || !seen) return;
        acceptedDiffs.set(taskId, { branch: done.branch, files: seen.files, note: null });
        onAccepted();
      },
      () => {
        // The next thread change reads again.
      },
    );
    return () => {
      active = false;
    };
  }, [source, taskId, thread, started]);

  async function cancel(attemptId: string) {
    setBusy(true);
    setRefusal(null);
    try {
      const answer = await cancelAcceptance(source, attemptId);
      if (!answer.done) setRefusal(answer.next);
    } catch (failure) {
      setRefusal(failure instanceof Error ? failure.message : 'The Accept was not cancelled.');
    } finally {
      setBusy(false);
    }
  }

  async function accept(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setRefusal(null);
    try {
      const answer = await acceptChanges(source, {
        taskId,
        branch: branch.trim(),
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(listing ? { listing } : {}),
      });
      setEnded(null);
      if (answer.accepted === true) {
        acceptedDiffs.set(taskId, { branch: answer.branch, files, note: answer.note });
        setAccepted(answer);
        onAccepted();
      } else if (answer.accepted === 'checking') {
        watched.current = { id: answer.attempt.id, files };
        watching.current = true;
        setChecking(answer.attempt);
        setStarted((count) => count + 1);
      } else setRefusal(refusals[answer.reason] ?? answer.next ?? 'The changes were not accepted.');
    } catch (failure) {
      setRefusal(failure instanceof Error ? failure.message : 'The changes were not accepted.');
    } finally {
      setBusy(false);
    }
  }
  // The git steps sit outside the form, so Enter in a pull request field never submits Accept.
  return (
    <>
      <form className="th-changes" onSubmit={(event) => void accept(event)}>
        {waiting && (
          <p className="th-muted" role="status">
            The merge with {mergeFrom} waits in the copy. Accept it to {waiting.target}, then push
            it.
          </p>
        )}
        <label>
          {waiting ? 'Branch' : 'New local branch'}
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
            placeholder={
              waiting
                ? method === 'rebase'
                  ? 'The accepted message'
                  : `chore: merge ${mergeFrom}`
                : undefined
            }
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
            busy ||
            done ||
            Boolean(checking) ||
            files.length === 0 ||
            Boolean(thread?.activeTurnId) ||
            !branch.trim()
          }
          title={done && last ? `These changes are on ${last.branch}.` : undefined}
        >
          Accept to branch
        </button>
        {checking && (
          <div className="th-ci" role="status">
            <p className="th-muted">
              {checking.state === 'reserved'
                ? 'Answer the checks question to start the checks.'
                : checking.state === 'publishing'
                  ? `Checks passed. Writing ${checking.branch}.`
                  : checking.requiredChecks.every((check) => check.status === 'pending')
                    ? `Preparing dependencies for the checks. ${checking.branch} is written once they pass.`
                    : `Checking before ${checking.branch} is written.`}
            </p>
            <RequiredChecks attempt={checking} />
            {checking.state !== 'publishing' && (
              <button
                type="button"
                className="th-button"
                disabled={busy}
                onClick={() => void cancel(checking.id)}
              >
                Cancel
              </button>
            )}
          </div>
        )}
        {!checking && ended && acceptanceWords(ended) && (
          <div className="th-ci">
            <p className={ended.state === 'refused' ? 'th-error' : 'th-muted'} role="status">
              {acceptanceWords(ended)}
            </p>
            {/* Which check refused, unless none had started. */}
            {ended.requiredChecks.some((check) => check.status !== 'pending') && (
              <RequiredChecks attempt={ended} />
            )}
            {ended.refusal === 'preparation-stale' && preparing && (
              <>
                <div>
                  <PrepareButton preparing={preparing} />
                </div>
                <PrepareStatus preparing={preparing} />
              </>
            )}
          </div>
        )}
        {refusal && (
          <p className="th-error" role="alert">
            {refusal}
          </p>
        )}
      </form>
      {last && (
        <div className="th-changes">
          <p className="th-muted" role="status">
            On branch {last.branch}
            {last.commit && ` (${last.commit.slice(0, 7)})`}
          </p>
          {note && (
            <p className="th-muted" role="status">
              {note}
            </p>
          )}
          <CodeBlock lang="sh" text={`git switch ${last.branch}`} />
          <GitSteps
            source={source}
            taskId={taskId}
            branch={last.branch}
            commit={last.commit}
            thread={thread}
            message={message}
            method={method}
          />
        </div>
      )}
    </>
  );
}

const skipReasons: Record<Skipped[number]['reason'], string> = {
  'link-outside': 'link outside the repository',
  submodule: 'submodule',
  'path-encoding': 'name is not UTF-8',
};

// The thread record keeps at most 64 entries, so a full list may stand for more.
function SkippedNote({ skipped }: { skipped: Skipped }) {
  const count = skipped.length >= 64 ? '64 or more' : String(skipped.length);
  return (
    <details className="th-skipped">
      <summary>
        Skipped {count} {skipped.length === 1 ? 'entry' : 'entries'} the scratch copy cannot hold
      </summary>
      <ul>
        {skipped.map((entry) => (
          <li key={entry.path}>
            <span className="th-path" title={entry.path}>
              {entry.path}
            </span>{' '}
            ({skipReasons[entry.reason]})
          </li>
        ))}
      </ul>
    </details>
  );
}

// Discard always asks first and names the file, because the scratch copy keeps no other version.
function DiscardControl({
  source,
  taskId,
  file,
  running,
  onDiscarded,
}: {
  source: ThreadSource;
  taskId: string;
  file: Files[number];
  running: boolean;
  onDiscarded: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const added = file.patch?.startsWith('--- /dev/null\n') ?? false;

  async function discard() {
    setBusy(true);
    setRefusal(null);
    try {
      const answer = await discardChange(source, { taskId, path: file.path });
      if (answer.discarded) {
        setConfirming(false);
        onDiscarded();
      } else setRefusal(answer.next ?? 'The file was not discarded.');
    } catch (failure) {
      setRefusal(failure instanceof Error ? failure.message : 'The file was not discarded.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="th-discard"
        disabled={busy || running}
        title={running ? 'Discard when the reply ends.' : undefined}
        onClick={() => setConfirming(true)}
      >
        Discard
      </button>
      {confirming && (
        <div className="th-discard-confirm">
          <p>
            {added
              ? `Remove ${file.path}? This thread added it.`
              : `Discard the changes to ${file.path}? It goes back to the base commit.`}
          </p>
          <button
            type="button"
            className="th-button"
            disabled={busy || running}
            onClick={() => void discard()}
          >
            Discard
          </button>{' '}
          <button type="button" className="th-button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      )}
      {refusal && (
        <p className="th-error th-discard-confirm" role="alert">
          {refusal}
        </p>
      )}
    </>
  );
}

export function ChangesPanel({
  source,
  taskId,
  projectId = null,
  title,
  thread,
  refreshKey,
  focusPath,
  focusLine = null,
  designCounts = null,
  onOpenDesign,
  preparing,
}: {
  source: ThreadSource;
  taskId: string;
  /** The project whose policy shapes the suggested subject and the merge. */
  projectId?: string | null;
  title: string;
  thread: ChatThread | null;
  refreshKey: number;
  focusPath: string | null;
  /** A line in the focused file to mark, from a design finding. */
  focusLine?: number | null;
  /** Open design findings per file, when the project has a design system. */
  designCounts?: ReadonlyMap<string, number> | null;
  onOpenDesign?: (path: string) => void;
  /** Prepare dependencies, offered when Accept refuses a copy whose dependencies need it. */
  preparing?: Preparing;
}) {
  const [data, setData] = useState<ChatChangesRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // Discard and Accept change the diff without a turn, so they ask for their own read.
  const [reads, setReads] = useState(0);
  const reread = () => setReads((count) => count + 1);
  const focused = useRef<HTMLLIElement>(null);
  const [policy, setPolicy] = useState<RepositoryPolicy>(DEFAULT_REPOSITORY_POLICY);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey and reads ask for a new read
  useEffect(() => {
    let active = true;
    readAllPages(source, taskId, () => active).then(
      (next) => {
        if (!active || !next) return;
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
  }, [source, taskId, refreshKey, reads]);
  // The suggested subject, the merge button and a waiting merge's message follow the project's
  // policy. Until it is read, the default stands, and the controller checks again anyway.
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    readRepositoryPolicy(source, projectId).then(
      (read) => active && setPolicy(read.policy),
      () => {},
    );
    return () => {
      active = false;
    };
  }, [source, projectId]);
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
      listing={data.listing}
      policy={policy}
      onAccepted={reread}
      preparing={preparing}
    />
  );
  const skipped = thread?.skipped?.length ? <SkippedNote skipped={thread.skipped} /> : null;
  if (data.files.length === 0)
    return (
      <div className="th-changes">
        {accept}
        {skipped}
        <p className="th-muted">
          No edits yet. Changes made in the scratch copy appear here against the base commit.
        </p>
      </div>
    );
  return (
    <div className="th-changes">
      {accept}
      {skipped}
      <p className="th-muted">
        {data.files.length} {data.files.length === 1 ? 'file' : 'files'}{' '}
        <span className="is-add">+{additions}</span> <span className="is-del">-{deletions}</span>
        {data.base && <> against {data.base.slice(0, 7)}</>}
      </p>
      <ul>
        {data.files.map((file) => {
          const expanded = open.has(file.path);
          return (
            <li
              key={file.path}
              className="th-file"
              ref={file.path === focusPath ? focused : undefined}
            >
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
                {/* A long path loses its start, so the file name stays readable. */}
                <span className="th-path is-tail" title={file.path}>
                  <bdi>{file.path}</bdi>
                </span>
                <span className="is-add">+{file.additions}</span>
                <span className="is-del">-{file.deletions}</span>
              </button>
              {(designCounts?.get(file.path) ?? 0) > 0 ? (
                <button
                  type="button"
                  className="th-design-count"
                  aria-label={`${designCounts?.get(file.path)} open design findings in ${file.path}. Show them in the Design tab.`}
                  onClick={() => onOpenDesign?.(file.path)}
                >
                  Design {designCounts?.get(file.path)}
                </button>
              ) : null}
              <DiscardControl
                source={source}
                taskId={taskId}
                file={file}
                running={Boolean(thread?.activeTurnId)}
                onDiscarded={reread}
              />
              {expanded &&
                (file.hunkControls && file.patch ? (
                  <HunkView
                    source={source}
                    taskId={taskId}
                    file={file}
                    running={Boolean(thread?.activeTurnId)}
                    onChanged={reread}
                    focusLine={file.path === focusPath ? focusLine : null}
                  />
                ) : file.patch ? (
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
