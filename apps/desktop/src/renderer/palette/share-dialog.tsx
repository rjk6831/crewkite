import type { DesktopShare, DesktopSource } from '@crewkite/client';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../components.tsx';
import './share-dialog.css';

// How long the frame has to report that it drew the page. After that the person reads the file as
// text, which is also exactly what Save writes.
const FRAME_SECONDS = 4;

type Frame = 'waiting' | 'drawn' | 'text';
type Preview =
  | { status: 'loading' }
  | { status: 'ready'; share: DesktopShare }
  | { status: 'failed'; message: string };

/**
 * The share page as it will be saved, in a frame that runs nothing. The frame has an empty sandbox,
 * so even a page that held markup would have no script, no form and no origin. Save stays off until
 * the frame reports that it drew the page. A frame that does not draw it gives way to the same
 * text as escaped plain text, so the person always sees what they save. Saving goes through the
 * system save dialog, and CrewKite hosts and uploads nothing.
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
  const [frame, setFrame] = useState<Frame>('waiting');
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

  const ready = preview.status === 'ready';
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(
      () => setFrame((current) => (current === 'waiting' ? 'text' : current)),
      FRAME_SECONDS * 1000,
    );
    return () => clearTimeout(timer);
  }, [ready]);

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
        {preview.status === 'ready' && frame !== 'text' && (
          <iframe
            className="share-frame"
            title="Preview of the share page"
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={preview.share.html}
            onLoad={() => setFrame('drawn')}
            onError={() => setFrame('text')}
          />
        )}
        {preview.status === 'ready' && frame === 'text' && (
          <>
            <p className="share-note" role="status">
              The page could not be drawn here, so this is the file as text. It is what Save writes.
            </p>
            <section aria-label="Text of the share page">
              <pre className="share-text">{preview.share.html}</pre>
            </section>
          </>
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
          disabled={!ready || frame === 'waiting' || saving || !source.saveExport}
          onClick={() => void save()}
        >
          Save page
        </button>
      </div>
    </Dialog>
  );
}
