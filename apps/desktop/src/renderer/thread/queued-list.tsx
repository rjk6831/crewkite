import type { ChatQueuedMessage } from '@crewkite/contracts';
import { useState } from 'react';

const SHOWN_CHARACTERS = 200;

/**
 * Messages sent while a turn runs. They start in this order once the thread is free, and each one
 * joins the conversation only then. `held` says why they wait when a running turn is not the
 * reason. Send now stops the running reply and starts that message at once.
 */
export function QueuedList({
  queued,
  held,
  running,
  onRemove,
  onSendNow,
}: {
  queued: readonly ChatQueuedMessage[];
  held: string | null;
  running: boolean;
  /** Both settle either way. The caller reports a refusal. */
  onRemove: (id: string) => Promise<void>;
  onSendNow: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  if (queued.length === 0) return null;
  async function act(id: string, action: (id: string) => Promise<void>) {
    setBusy(id);
    try {
      await action(id);
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="th-queued" aria-label="Queued messages">
      {held && <p className="th-queued-note">{held}</p>}
      <ol>
        {queued.map((message) => (
          <li key={message.id} className="th-queued-row">
            <span className="th-queued-label">Queued</span>
            <span className="th-queued-text" title={message.text}>
              {message.text.slice(0, SHOWN_CHARACTERS)}
            </span>
            {running && (
              <button
                type="button"
                className="th-queued-remove"
                disabled={busy !== null}
                title="Stops the current reply and sends this message now."
                aria-label={`Send now: ${message.text.slice(0, 80)}`}
                onClick={() => void act(message.id, onSendNow)}
              >
                Send now
              </button>
            )}
            <button
              type="button"
              className="th-queued-remove"
              disabled={busy !== null}
              aria-label={`Remove queued message: ${message.text.slice(0, 80)}`}
              onClick={() => void act(message.id, onRemove)}
            >
              Remove
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
