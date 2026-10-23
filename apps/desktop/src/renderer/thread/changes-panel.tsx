import type { ChatChangesRead } from '@crewkite/contracts';
import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { lineClass } from './cards.tsx';
import { readChanges, type ThreadSource } from './commands.ts';

export function ChangesPanel({
  source,
  taskId,
  refreshKey,
  focusPath,
}: {
  source: ThreadSource;
  taskId: string;
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
  if (data.files.length === 0)
    return (
      <p className="th-muted">
        No edits yet. Changes made in the scratch copy appear here against the base commit.
      </p>
    );
  return (
    <div className="th-changes">
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
