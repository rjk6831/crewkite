import type { ChatCatalogRead, ChatFamily, WorkspaceState } from '@crewkite/contracts';
import { type ReactNode, useId, useState } from 'react';
import { familyName } from '../components.tsx';
import type { Workspace } from '../source.ts';
import { FamilyMark } from '../thread/family-mark.tsx';
import { type UsageCard, UsageGauges } from '../usage-gauges.tsx';
import type { UsageGaugeCard } from '../usage-presentation.ts';
import { readFamilyDefaults, writeFamilyDefault } from './preferences.ts';
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

// The family's models and the default the person picks among them. A choice the provider no
// longer lists stays saved, and the catalog's default applies until the model is listed again.
function Models({
  family,
  entry,
  children,
}: {
  family: ChatFamily;
  entry: CatalogEntry | undefined;
  children?: ReactNode;
}) {
  const models = entry?.models ?? [];
  const selectId = useId();
  const hintId = useId();
  const [chosen, setChosen] = useState(() => readFamilyDefaults()[family] ?? '');
  const listed = models.some(({ model }) => model === chosen);
  const current = listed ? chosen : entry?.defaultModel;
  const fallback = models.find(({ model }) => model === entry?.defaultModel)?.label;
  return (
    <section className="st-block" aria-label="Models">
      <div className="st-subhead">
        <h3>Models</h3>
        {models.length > 0 && <span>{models.length} listed</span>}
      </div>
      {entry?.connected && models.length > 1 && (
        <div className="st-field">
          <label className="st-name" htmlFor={selectId}>
            Default model
          </label>
          <small className="st-hint" id={hintId}>
            A new thread on this provider starts on it. The rail and the picker show its allowance.
            Automatic handoff after a limit uses the provider's own default.
          </small>
          <div className="st-controls">
            <select
              id={selectId}
              aria-describedby={hintId}
              value={listed ? chosen : ''}
              onChange={(event) => {
                setChosen(event.target.value);
                writeFamilyDefault(family, event.target.value || null);
              }}
            >
              <option value="">
                {fallback ? `Provider default (${fallback})` : 'Provider default'}
              </option>
              {models.map((model) => (
                <option key={model.model} value={model.model}>
                  {model.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      {models.length > 0 ? (
        <ul className="st-models">
          {models.slice(0, modelLimit).map((model) => (
            <li
              key={model.model}
              className={model.model === current ? 'is-default' : undefined}
              title={model.efforts.length > 1 ? `Effort: ${model.efforts.join(', ')}` : model.model}
            >
              {model.label}
              {model.model === current && <em>default</em>}
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
        <FamilyMark family={family} />
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
          <Models family={family} entry={entry}>
            {models}
          </Models>
          {side}
        </div>
      </div>
    </section>
  );
}
