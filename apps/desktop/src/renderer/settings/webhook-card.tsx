import { SetWebhookPayloadSchema, WebhookReadSchema } from '@crewkite/contracts';
import { useEffect, useId, useState } from 'react';
import type { DesktopCommand, DesktopSource } from '../source.ts';

type Source = Pick<DesktopSource, 'command'>;

// The preload already strips Electron's wrapper text, so the message is the controller's sentence.
const sentence = (failure: unknown) =>
  failure instanceof Error && failure.message
    ? failure.message
    : 'The controller did not accept this request.';

async function send(source: Source, command: 'ReadWebhook' | 'SetWebhook', payload: object) {
  const result = await source.command({
    command,
    payload,
    ...(command === 'SetWebhook' ? { expectedRevision: 0 } : {}),
  } as unknown as DesktopCommand);
  if (result.outcome !== 'applied' && result.outcome !== 'already-applied')
    throw new Error(result.next ?? result.reason ?? 'The controller did not accept this request.');
  return result.data;
}

async function readAddress(source: Source) {
  const data = await send(source, 'ReadWebhook', {});
  const { kind: _kind, ...rest } = (data ?? {}) as Record<string, unknown>;
  return WebhookReadSchema.parse(rest).url ?? '';
}

/**
 * One webhook address. The controller posts a small JSON event to it when a thread needs approval,
 * finishes, fails or stops at a limit. The controller checks the address before it saves, and the
 * card reads it back after a save, since a save answers without the address.
 */
export function WebhookCard({ source }: { source?: Source }) {
  const ids = useId();
  const [saved, setSaved] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (source)
      void readAddress(source)
        .then((value) => {
          if (!live) return;
          setSaved(value);
          setUrl(value);
        })
        .catch((failure) => {
          if (live) setNote(`CrewKite could not read the webhook address. ${sentence(failure)}`);
        });
    return () => {
      live = false;
    };
  }, [source]);

  async function save() {
    if (!source) return;
    setBusy(true);
    const kept = url.trim();
    try {
      await send(source, 'SetWebhook', SetWebhookPayloadSchema.parse({ url: kept }));
    } catch (failure) {
      setNote(sentence(failure));
      setBusy(false);
      return;
    }
    // The save applied. A read back that fails leaves the card on the address it just saved.
    try {
      const value = await readAddress(source);
      setSaved(value);
      setUrl(value);
      setNote(value ? 'Saved.' : 'Removed.');
    } catch (failure) {
      setSaved(kept);
      setNote(`CrewKite could not read the webhook address. ${sentence(failure)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="st-card" aria-labelledby={`${ids}-title`}>
      <header className="st-card-head">
        <h2 id={`${ids}-title`}>Webhook</h2>
        <span className="st-detail">{saved ? 'On' : 'Off'}</span>
      </header>
      <div className="st-rows">
        <div className="st-row">
          <label className="st-field" htmlFor={`${ids}-url`}>
            <span className="st-name">Address</span>
            <small className="st-hint">
              CrewKite posts the event, thread title, time and one line when a thread needs
              approval, finishes, fails or stops at a limit, and when a loop pauses or stops. Events
              are sent while CrewKite is running, whether or not the thread is on screen. No source,
              transcript or key is sent. Leave it empty to turn it off.
            </small>
          </label>
          <div className="st-controls">
            <input
              id={`${ids}-url`}
              type="url"
              maxLength={2048}
              placeholder="https://example.com/hook"
              value={url}
              disabled={!source}
              onChange={(event) => {
                setUrl(event.target.value);
                setNote(null);
              }}
            />
            <button
              type="button"
              className="button secondary"
              disabled={!source || busy || url.trim() === saved}
              onClick={() => void save()}
            >
              {busy ? 'Saving' : 'Save'}
            </button>
          </div>
        </div>
        {note && (
          <p className="st-hint" role="status">
            {note}
          </p>
        )}
      </div>
    </section>
  );
}
