import type { DesktopShare, DesktopSource } from '@crewkite/client';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../components.tsx';
import './share-dialog.css';

type Preview =
  | { status: 'loading' }
  | { status: 'ready'; share: DesktopShare }
  | { status: 'failed'; message: string };

/**
 * The share page as it will be saved, in a frame that runs nothing. The frame has an empty sandbox,
 * so even a page that held markup would have no script, no form and no origin. Saving goes
 * through the system save dialog, and CrewKite hosts and uploads nothing.
 */
export function ShareDialog({
  source,
  taskId,
  onClose,
}: {
  source: Pick<DesktopSource, 'previewShare' | 'saveExport'>;
  taskId: string;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<Preview>({ status: 'loading' });
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const opener = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  // Focus goes back to where it was when the dialog closes.
  useEffect(() => {
    const back = opener.current;
    return () => back?.focus();
  }, []);
  useEffect(() => {
    let current = true;
    if (!source.previewShare) {
      setPreview({ status: 'failed', message: 'Sharing needs the desktop app.' });
      return;
    }
    source.previewShare(taskId).then(
      (share) => current && setPreview({ status: 'ready', share }),
      (failure: unknown) =>
        current &&
        setPreview({
          status: 'failed',
          message: failure instanceof Error ? failure.message : 'The page could not be made.',
        }),
    );
    return () => {
      current = false;
    };
  }, [source, taskId]);

  async function save() {
    if (!source.saveExport) return;
    setSaving(true);
    try {
      const done = await source.saveExport({ taskId, format: 'html' });
      setNote(done === 'saved' ? 'Saved.' : null);
    } catch (failure) {
      setNote(failure instanceof Error ? failure.message : 'The file was not saved.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="Share page preview" eyebrow="READ-ONLY COPY" onClose={onClose} wide>
      <div className="share">
        <p className="share-note">
          This is the page you will save. CrewKite hosts nothing and uploads nothing, so the file
          goes only where you put it. Secrets, email addresses and folder paths are redacted by
          pattern, which can miss unusual formats, so read the page before you hand it on.
        </p>
        {preview.status === 'loading' && <p role="status">Making the page</p>}
        {preview.status === 'failed' && <p role="alert">{preview.message}</p>}
        {preview.status === 'ready' && (
          <iframe
            className="share-frame"
            title="Preview of the share page"
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={preview.share.html}
          />
        )}
      </div>
      <div className="dialog-footer">
        <span role="status">{note}</span>
        <button type="button" className="button secondary" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="button primary"
          disabled={preview.status !== 'ready' || saving || !source.saveExport}
          onClick={() => void save()}
        >
          Save page
        </button>
      </div>
    </Dialog>
  );
}
