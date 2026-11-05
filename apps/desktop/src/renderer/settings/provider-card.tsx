import type {
  ChatCatalogRead,
  ChatFamily,
  ClientVersionStatus,
  WorkspaceState,
} from '@crewkite/contracts';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { familyName } from '../components.tsx';
import type { Workspace } from '../source.ts';
import { setCreditSpending } from '../thread/commands.ts';
import { FamilyMark } from '../thread/family-mark.tsx';
import { type UsageCard, UsageGauges } from '../usage-gauges.tsx';
import type { UsageGaugeCard } from '../usage-presentation.ts';
import '../thread/subagents.css';
import { ClientRecord } from './client-status.tsx';
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

// The rail's Connect link names the card before it opens Settings, and the card scrolls itself
// into view when it mounts. A plain value is enough: one page opens at a time.
let pendingCard: ChatFamily | null = null;
export function focusSettingsCard(family: ChatFamily) {
  pendingCard = family;
  document.getElementById(`st-card-${family}`)?.scrollIntoView({ block: 'start' });
}

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
            A new thread on this provider starts on it, and so does work that moves here on its own
            after a limit. The rail and the picker show its allowance.
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
  credit = null,
}: {
  label: string;
  cards: readonly UsageCard[];
  now: number;
  none: string;
  /** What the rail bar says once the included allowance is used up. */
  credit?: string | null;
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
      {credit && <p role="status">{credit}</p>}
    </section>
  );
}

const creditNotes = {
  openai:
    "Credits also need to be turned on in OpenAI's own settings. CrewKite can't override it there.",
  anthropic:
    "Extra usage also needs to be turned on in your Anthropic account settings. CrewKite can't override it there.",
};

/**
 * The Allow credit spending switch. The controller holds it, so the card shows what the catalog
 * says and changes it only through the command.
 */
export function CreditSwitch({
  family,
  entry,
  workspace,
}: {
  family: 'openai' | 'anthropic';
  entry: CatalogEntry | undefined;
  workspace: Workspace;
}) {
  const id = useId();
  const [allowed, setAllowed] = useState(entry?.creditSpending === true);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => setAllowed(entry?.creditSpending === true), [entry?.creditSpending]);
  const source = workspace.source;
  const live = workspace.connection === 'connected' && !workspace.preview;
  async function change(next: boolean) {
    if (!source) return;
    setSaving(true);
    setFailure(null);
    try {
      await setCreditSpending(source, family, next);
      setAllowed(next);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The switch could not be saved.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="st-field">
      <label className="sa-switch" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={allowed}
          aria-checked={allowed}
          aria-describedby={`${id}-note`}
          disabled={!source || !live || saving}
          onChange={(event) => void change(event.target.checked)}
        />
        <span>Allow credit spending</span>
      </label>
      {allowed ? (
        <p id={`${id}-note`} className="st-credit-note">
          {creditNotes[family]}
        </p>
      ) : (
        <small id={`${id}-note`} className="st-hint">
          When the included allowance runs out, CrewKite hands work to another provider.
        </small>
      )}
      {failure && <p role="status">{failure}</p>}
    </div>
  );
}

export function ProviderCard({
  family,
  entry,
  detail,
  reasonLine,
  main,
  side,
  models,
  client,
  onCheck,
}: {
  family: ChatFamily;
  entry: CatalogEntry | undefined;
  /** One line under the name, such as the sign-in the client reports. */
  detail?: string;
  /** The line for the catalog's reason, for a card that words its own reasons. */
  reasonLine?: string;
  main: ReactNode;
  side: ReactNode;
  /** Shown under the model list, such as a way to read it again. */
  models?: ReactNode;
  /** The installed client against its tested build. The catalog entry's own when left out. */
  client?: ClientVersionStatus;
  /** Reads the client again, after the person updates or installs it. */
  onCheck?: () => Promise<void> | void;
}) {
  const found = client ?? entry?.client;
  // The check often finds what was already shown, so the button says it ran and when.
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  async function check() {
    if (!onCheck || checking) return;
    setChecking(true);
    try {
      await onCheck();
    } finally {
      setChecking(false);
      setCheckedAt(new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    }
  }
  const titleId = useId();
  const card = useRef<HTMLElement>(null);
  // A family this computer cannot run keeps its card, greyed, with the one line that says why.
  const unavailable = entry?.reason === 'unsupported-platform';
  useEffect(() => {
    if (pendingCard !== family) return;
    pendingCard = null;
    card.current?.scrollIntoView({ block: 'start' });
  }, [family]);
  return (
    <section
      ref={card}
      id={`st-card-${family}`}
      className={unavailable ? 'st-card is-unavailable' : 'st-card'}
      aria-labelledby={titleId}
    >
      <header className="st-card-head">
        <FamilyMark family={family} />
        <h2 id={titleId}>{familyName(family)}</h2>
        <span className={entry?.connected ? 'st-pill is-on' : 'st-pill'}>
          {!entry
            ? 'Unknown'
            : unavailable
              ? 'Not on Linux'
              : entry.connected
                ? 'Connected'
                : 'Not connected'}
        </span>
        <span className="st-detail">
          {entry && !entry.connected && entry.reason
            ? (reasonLine ?? reasonText(entry.reason))
            : detail}
        </span>
      </header>
      {!unavailable && found && (
        <div className={found.accepted ? 'st-client' : 'st-client is-refused'}>
          <p role="status">{found.message}</p>
          {onCheck && (
            <button
              type="button"
              className="button secondary"
              disabled={checking}
              onClick={() => void check()}
            >
              {checking ? 'Checking…' : 'Check again'}
            </button>
          )}
          {checkedAt && !checking && <small className="st-hint">Checked at {checkedAt}.</small>}
          <ClientRecord status={found} capabilities={family !== 'openai'} />
        </div>
      )}
      {!unavailable && (
        <div className="st-body">
          <div className="st-col">{main}</div>
          <div className="st-col">
            <Models family={family} entry={entry}>
              {models}
            </Models>
            {side}
          </div>
        </div>
      )}
    </section>
  );
}
