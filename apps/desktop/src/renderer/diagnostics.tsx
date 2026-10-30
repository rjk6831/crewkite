import type { DesktopSource } from '@crewkite/client';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';

type Source = Pick<DesktopSource, 'exportDiagnostics' | 'dismissCrash' | 'onNotice'>;

/**
 * Asks main to list the bundle and save it. The answer is the sentence to show, or null when the
 * person cancelled. Main reads everything from the controller, so the page sends a thread ID only.
 */
export async function runExport(
  source: Pick<DesktopSource, 'exportDiagnostics'> | undefined,
  taskId: string | undefined,
): Promise<string | null> {
  if (!source?.exportDiagnostics) return 'Export needs the desktop app.';
  try {
    return (await source.exportDiagnostics(taskId ? { taskId } : {})) === 'saved' ? 'Saved.' : null;
  } catch (failure) {
    return failure instanceof Error ? failure.message : 'The diagnostics were not saved.';
  }
}

/** One line after a launch that follows an unexpected close, with Export diagnostics and Dismiss. */
export function CrashBanner({ source, taskId }: { source?: Source; taskId?: string }) {
  const [crashed, setCrashed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(
    () =>
      source?.onNotice?.((notice) => {
        if (notice.kind === 'crash') setCrashed(notice.at !== null);
      }),
    [source],
  );
  if (!crashed) return null;
  return (
    <div className="recovery-banner" role="status">
      <AlertTriangle size={15} />
      <span>CrewKite closed unexpectedly last time.{note ? ` ${note}` : ''}</span>
      <button
        type="button"
        className="button secondary"
        onClick={() => void runExport(source, taskId).then(setNote)}
      >
        Export diagnostics
      </button>
      <button
        type="button"
        className="button secondary"
        onClick={() => void source?.dismissCrash?.().catch(() => {})}
      >
        Dismiss
      </button>
    </div>
  );
}
