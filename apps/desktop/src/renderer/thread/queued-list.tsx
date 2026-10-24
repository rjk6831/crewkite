import type { ChatQueuedMessage } from '@crewkite/contracts';
import { useState } from 'react';

const SHOWN_CHARACTERS = 200;

/**
 * Messages sent while a turn runs. They start in this order once the thread is free, and each one
 * joins the conversation only then. `held` says why they wait when a running turn is not the
 * reason.
 */
export function QueuedList({
  queued,
  held,
  onRemove,
}: {
  queued: readonly ChatQueuedMessage[];
  held: string | null;
  /** Settles either way. The caller reports a refusal. */
  onRemove: (id: string) => Promise<void>;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  if (queued.length === 0) return null;
  async function remove(id: string) {
    setRemoving(id);
    try {
      await onRemove(id);
    } finally {
      setRemoving(null);
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
            <button
              type="button"
              className="th-queued-remove"
              disabled={removing !== null}
              aria-label={`Remove queued message: ${message.text.slice(0, 80)}`}
              onClick={() => void remove(message.id)}
            >
              Remove
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
