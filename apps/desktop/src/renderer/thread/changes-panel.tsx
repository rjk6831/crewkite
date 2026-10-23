import type { ChatChangesRead, ChatThread } from '@crewkite/contracts';
import { ChevronRight } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { lineClass } from './cards.tsx';
import { type Acceptance, acceptChanges, readChanges, type ThreadSource } from './commands.ts';
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

function AcceptControl({
  source,
  taskId,
  title,
  thread,
  files,
}: {
  source: ThreadSource;
  taskId: string;
  title: string;
  thread: ChatThread | null;
  files: Files;
}) {
  const [branch, setBranch] = useState(() => branchName(title, taskId));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Extract<Acceptance, { accepted: true }> | null>(null);
  // The command result shows at once. The thread record keeps it for the next time the tab opens.
  const last = accepted ?? thread?.lastAcceptance ?? null;
  const diff = acceptedDiffs.get(taskId);
  const done = Boolean(last && diff?.branch === last.branch && sameFiles(diff.files, files));

  async function accept(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setRefusal(null);
    try {
      const answer = await acceptChanges(source, { taskId, branch: branch.trim() });
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
}: {
  source: ThreadSource;
  taskId: string;
  title: string;
  thread: ChatThread | null;
  refreshKey: number;
  focusPath: string | null;
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
