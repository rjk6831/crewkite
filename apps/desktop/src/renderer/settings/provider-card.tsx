import type { ChatCatalogRead, ChatFamily, WorkspaceState } from '@crewkite/contracts';
import { type ReactNode, useId } from 'react';
import { familyClass, familyName } from '../components.tsx';
import type { Workspace } from '../source.ts';
import { type UsageCard, UsageGauges } from '../usage-gauges.tsx';
import type { UsageGaugeCard } from '../usage-presentation.ts';
import type { ProviderActions } from './provider-actions.ts';

export type CatalogEntry = ChatCatalogRead['families'][number];

/** What every family card receives. A card picks the parts it shows. */
export type CardProps = {
  header: WorkspaceState;
  workspace: Workspace;
  /** Null until the catalog has been read, or when it cannot be. */
  entry: CatalogEntry | undefined;
  now: number;
  actions: ProviderActions;
  scopes: readonly UsageGaugeCard[];
};

// The controller reports reasons as kebab-case codes. Show them as a sentence fragment.
const reasonText = (reason: string) => {
  const text = reason.replaceAll('-', ' ');
  return `${text[0].toUpperCase()}${text.slice(1)}`;
};

const modelLimit = 12;

function Models({ entry, children }: { entry: CatalogEntry | undefined; children?: ReactNode }) {
  const models = entry?.models ?? [];
  return (
    <section className="st-block" aria-label="Models">
      <div className="st-subhead">
        <h3>Models</h3>
        {models.length > 0 && <span>{models.length} listed</span>}
      </div>
      {models.length > 0 ? (
        <ul className="st-models">
          {models.slice(0, modelLimit).map((model) => (
            <li
              key={model.model}
              className={model.model === entry?.defaultModel ? 'is-default' : undefined}
              title={model.efforts.length > 1 ? `Effort: ${model.efforts.join(', ')}` : model.model}
            >
              {model.label}
              {model.model === entry?.defaultModel && <em>default</em>}
            </li>
          ))}
          {models.length > modelLimit && (
            <li className="st-more">+{models.length - modelLimit} more</li>
          )}
        </ul>
      ) : (
        <p className="st-note">
          {!entry
            ? 'The model list has not been read.'
            : entry.connected
              ? 'The provider listed no models.'
              : 'Models appear after this provider connects.'}
        </p>
      )}
      {children}
    </section>
  );
}

export function Allowance({
  label,
  cards,
  now,
  none,
}: {
  label: string;
  cards: readonly UsageCard[];
  now: number;
  none: string;
}) {
  return (
    <section className="st-block" aria-label={`${label} allowance`}>
      <div className="st-subhead">
        <h3>Allowance</h3>
      </div>
      {cards.length > 0 ? (
        <UsageGauges cards={cards} nowMs={now} label={`${label} usage`} />
      ) : (
        <p className="st-note">{none}</p>
      )}
    </section>
  );
}

export function ProviderCard({
  family,
  entry,
  detail,
  main,
  side,
  models,
}: {
  family: ChatFamily;
  entry: CatalogEntry | undefined;
  /** One line under the name, such as the sign-in the client reports. */
  detail?: string;
  main: ReactNode;
  side: ReactNode;
  /** Shown under the model list, such as a way to read it again. */
  models?: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className="st-card" aria-labelledby={titleId}>
      <header className="st-card-head">
        <span className={`provider-dot ${familyClass(family)}`} aria-hidden="true" />
        <h2 id={titleId}>{familyName(family)}</h2>
        <span className={entry?.connected ? 'st-pill is-on' : 'st-pill'}>
          {!entry ? 'Unknown' : entry.connected ? 'Connected' : 'Not connected'}
        </span>
        <span className="st-detail">
          {entry && !entry.connected && entry.reason ? reasonText(entry.reason) : detail}
        </span>
      </header>
      <div className="st-body">
        <div className="st-col">{main}</div>
        <div className="st-col">
          <Models entry={entry}>{models}</Models>
          {side}
        </div>
      </div>
    </section>
  );
}
