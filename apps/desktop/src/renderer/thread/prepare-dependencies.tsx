import type { ChatThread, DependencyPreparation } from '@crewkite/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { coalescedRead } from '../coalesced-read.ts';
import { prepareDependencies, readThreadPreparation, type ThreadSource } from './commands.ts';
import { preparationResultLine } from './work-view.ts';

/**
 * The records of the thread's own dependency copy, oldest first. The checks that find a copy stale
 * change the thread, so each thread change reads them again, and so does `reload`. A failed read
 * keeps what was shown.
 */
export function useThreadCopy(source: ThreadSource, taskId: string, thread: ChatThread | null) {
  const [preparations, setPreparations] = useState<readonly DependencyPreparation[]>([]);
  const [asked, setAsked] = useState(0);
  const read = useMemo(
    () => coalescedRead(() => readThreadPreparation(source, taskId)),
    [source, taskId],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a thread change or reload reads again
  useEffect(() => {
    let active = true;
    read().then(
      (records) => active && setPreparations(records),
      () => {},
    );
    return () => {
      active = false;
    };
  }, [read, thread, asked]);
  const reload = useCallback(() => setAsked((count) => count + 1), []);
  return { preparations, reload };
}

/**
 * Prepare dependencies for the thread's own copy. The copy can take minutes and the controller
 * answers when it is done, so the button says it is working and the line under it says how it
 * ended. `done` runs after either.
 */
export function usePrepareDependencies(source: ThreadSource, taskId: string, done?: () => void) {
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const prepare = useCallback(() => {
    setBusy(true);
    setLine(null);
    prepareDependencies(source, taskId)
      .then(
        (result) => setLine(preparationResultLine(result).line),
        (failure: unknown) =>
          setLine(
            failure instanceof Error ? failure.message : 'The dependencies were not prepared.',
          ),
      )
      .finally(() => {
        setBusy(false);
        done?.();
      });
  }, [source, taskId, done]);
  return useMemo(() => ({ busy, line, prepare }), [busy, line, prepare]);
}

export type Preparing = ReturnType<typeof usePrepareDependencies>;

/**
 * The thread's own dependency copy as the thread view holds it: its records, the thread's lines
 * that may name a copy never prepared, and the one Prepare dependencies every view shares.
 */
export type ThreadCopy = {
  preparations: readonly DependencyPreparation[];
  lines: readonly { text: string; at: string }[];
  preparing: Preparing;
};

export function PrepareButton({ preparing }: { preparing: Preparing }) {
  return (
    <button
      type="button"
      className="th-pill th-outline"
      disabled={preparing.busy}
      onClick={preparing.prepare}
    >
      {preparing.busy ? 'Preparing dependencies…' : 'Prepare dependencies'}
    </button>
  );
}

/**
 * What Prepare dependencies is doing, or how it ended. It stays in the page while empty, so a
 * screen reader hears each change.
 */
export function PrepareStatus({ preparing }: { preparing: Preparing }) {
  return (
    <p className="th-muted th-prepare-status" role="status">
      {preparing.busy
        ? "Copying your installed dependencies into this thread's copy. A large tree takes a few minutes. Nothing is installed."
        : preparing.line}
    </p>
  );
}
