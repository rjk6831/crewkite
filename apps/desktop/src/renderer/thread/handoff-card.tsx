import type { ChatCatalogRead, ChatFamily, ChatModelSelection } from '@crewkite/contracts';
import { useEffect, useState } from 'react';
import { familyName } from '../components.tsx';
import { readCatalog, type ThreadSource } from './commands.ts';
import { type LimitOffer, offerChoices } from './handoff-offer.ts';
import './handoff-card.css';

const reason = (failure: unknown, fallback: string) =>
  failure instanceof Error ? failure.message : fallback;

// Under the thread after a provider stops on a usage limit. One button per other connected
// family. The parent keys it by turn, so each limit reads the catalog once.
export function LimitOfferCard({
  source,
  taskId,
  offer,
  onContinue,
}: {
  source: ThreadSource;
  taskId: string;
  offer: LimitOffer;
  onContinue: (selection: ChatModelSelection, offer: LimitOffer) => Promise<void>;
}) {
  const [catalog, setCatalog] = useState<ChatCatalogRead | null>(null);
  const [busy, setBusy] = useState<ChatFamily | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    readCatalog(source, taskId).then(
      (value) => active && setCatalog(value),
      (failure: unknown) =>
        active && setProblem(reason(failure, 'The provider list could not be read.')),
    );
    return () => {
      active = false;
    };
  }, [source, taskId]);

  async function choose(selection: ChatModelSelection) {
    setBusy(selection.family);
    setProblem(null);
    try {
      await onContinue(selection, offer);
    } catch (failure) {
      setProblem(reason(failure, 'The message was not sent again.'));
    } finally {
      setBusy(null);
    }
  }

  if (!catalog && !problem) return null;
  const choices = catalog ? offerChoices(catalog, offer.family) : [];
  return (
    <div className="th-offer-wrap">
      <section className="th-offer" aria-label="Continue on another provider">
        {catalog && choices.length === 0 && (
          <p className="th-muted">
            No other provider is connected. Connect one in Settings or wait for the reset.
          </p>
        )}
        {choices.length > 0 && (
          <>
            <p>Send your last message again on another provider.</p>
            <div className="th-offer-options">
              {choices.map((choice) => (
                <button
                  key={choice.family}
                  type="button"
                  className="th-offer-option"
                  title={choice.selection.model}
                  disabled={busy !== null}
                  onClick={() => void choose(choice.selection)}
                >
                  <span>Continue on {familyName(choice.family)}</span>
                  <span className="th-muted">
                    {choice.percent === null ? 'Allowance unknown' : `${choice.percent}% left`}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        {problem && (
          <p className="th-error" role="alert">
            {problem}
          </p>
        )}
      </section>
    </div>
  );
}
