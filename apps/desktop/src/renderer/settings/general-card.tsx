import type { DesktopSource } from '@crewkite/client';
import type { ChatCatalogRead, ChatModelSelection } from '@crewkite/contracts';
import { useState } from 'react';
import { familyName } from '../components.tsx';
import { runExport } from '../diagnostics.tsx';
import { Select } from '../select.tsx';
import { effortLevels, shownEffort } from '../thread/model-groups.ts';
import { EffortSelect } from '../thread/model-picker.tsx';
import { InfoMark } from '../thread/role-info.tsx';
import {
  handoffModes,
  permissionInfo,
  permissionPolicies,
  readThreadDefaults,
  type ThreadDefaults,
  writeThreadDefaults,
} from './preferences.ts';

const auto = 'auto';
const saved_ = 'saved';

type Entry = ChatCatalogRead['families'][number];
type Choice = { entry: Entry; model: Entry['models'][number] };

/** Every connected model as a pick, in catalog order. */
export const modelChoices = (catalog: ChatCatalogRead | null): Choice[] =>
  (catalog?.families ?? [])
    .filter((entry) => entry.connected && entry.models.length > 0)
    .flatMap((entry) => entry.models.map((model) => ({ entry, model })));

/**
 * One select of every connected model, plus a saved pin the catalog no longer lists. Without
 * autoText the select has no empty choice, as for a role a crew already names.
 */
function ModelSelect({
  id,
  label,
  choices,
  value,
  autoText,
  onChange,
}: {
  id?: string;
  label?: string;
  choices: Choice[];
  value: ChatModelSelection | null;
  autoText?: string;
  onChange: (next: ChatModelSelection | null) => void;
}) {
  const listed = choices.findIndex(
    ({ entry, model }) => entry.family === value?.family && model.model === value.model,
  );
  const families = [...new Set(choices.map(({ entry }) => entry))];
  return (
    <Select
      id={id}
      aria-label={label}
      value={listed >= 0 ? String(listed) : value ? saved_ : auto}
      onChange={(event) => {
        if (event.target.value === saved_) return;
        const choice = choices[Number(event.target.value)];
        onChange(
          choice
            ? {
                family: choice.entry.family,
                model: choice.model.model,
                effort: choice.model.defaultEffort,
              }
            : null,
        );
      }}
    >
      {autoText !== undefined && <option value={auto}>{autoText}</option>}
      {value && listed < 0 && (
        <option value={saved_}>
          {familyName(value.family)} · {value.model} (not available now)
        </option>
      )}
      {families.map((entry) => (
        <optgroup key={entry.family} label={familyName(entry.family)}>
          {choices.flatMap((choice, index) =>
            choice.entry === entry
              ? [
                  <option key={choice.model.model} value={String(index)}>
                    {choice.model.label}
                  </option>,
                ]
              : [],
          )}
        </optgroup>
      ))}
    </Select>
  );
}

/**
 * A model select and, when the model lists effort levels, an effort select beside it. A new
 * model starts on its preselected level.
 */
export function SelectionFields({
  id,
  label,
  effortLabel = 'Effort',
  choices,
  value,
  autoText,
  onChange,
}: {
  id?: string;
  label?: string;
  effortLabel?: string;
  choices: Choice[];
  value: ChatModelSelection | null;
  autoText?: string;
  onChange: (next: ChatModelSelection | null) => void;
}) {
  const model = choices.find(
    ({ entry, model }) => entry.family === value?.family && model.model === value.model,
  )?.model;
  const levels = effortLevels(model?.efforts ?? []);
  return (
    <>
      <ModelSelect
        id={id}
        label={label}
        choices={choices}
        value={value}
        autoText={autoText}
        onChange={onChange}
      />
      {value && levels.length > 0 && (
        <EffortSelect
          label={effortLabel}
          efforts={levels}
          value={shownEffort(value.effort, model)}
          onChange={(effort) => onChange({ ...value, effort })}
        />
      )}
    </>
  );
}

export function GeneralCard({
  catalog,
  theme,
  onTheme,
  onShowWelcome,
  source,
  threadId,
}: {
  catalog: ChatCatalogRead | null;
  theme: string;
  onTheme: (theme: 'system' | 'dark' | 'light') => void;
  onShowWelcome?: () => void;
  source?: Pick<DesktopSource, 'exportDiagnostics'>;
  threadId?: string;
}) {
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [saved, setSaved] = useState<ThreadDefaults>(() => readThreadDefaults());
  const change = (next: ThreadDefaults) => {
    setSaved(next);
    writeThreadDefaults(next);
  };
  const mode = handoffModes.find(({ id }) => id === saved.handoffMode) ?? handoffModes[0];
  const choices = modelChoices(catalog);
  return (
    <section className="st-card" aria-labelledby="settings-general">
      <header className="st-card-head">
        <h2 id="settings-general">General</h2>
        <span className="st-detail">Applies to new threads</span>
      </header>
      <div className="st-rows">
        <div className="st-row">
          <label className="st-field" htmlFor="settings-model">
            <span className="st-name">Provider and model</span>
            <small className="st-hint">
              Without a choice, a new thread uses the connected provider with the most left.
            </small>
          </label>
          <div className="st-controls">
            <SelectionFields
              id="settings-model"
              choices={choices}
              value={saved.selection}
              autoText="Most allowance left"
              onChange={(selection) => change({ ...saved, selection })}
            />
          </div>
        </div>
        <div className="st-row">
          <label className="st-field" htmlFor="settings-permissions">
            <span className="role-name st-name">
              Permissions <InfoMark {...permissionInfo[saved.permissionPolicy]} />
            </span>
            <small className="st-hint">
              {permissionPolicies.find(({ id }) => id === saved.permissionPolicy)?.title} Each
              thread can change it under Thread in the inspector.
            </small>
          </label>
          <div className="st-controls">
            <Select
              id="settings-permissions"
              value={saved.permissionPolicy}
              onChange={(event) =>
                change({
                  ...saved,
                  permissionPolicy:
                    permissionPolicies.find(({ id }) => id === event.target.value)?.id ?? 'ask',
                })
              }
            >
              {permissionPolicies.map((policy) => (
                <option key={policy.id} value={policy.id}>
                  {policy.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="st-row">
          <label className="st-field" htmlFor="settings-handoff">
            <span className="st-name">Default handoff mode for new threads</span>
            <small className="st-hint">
              Where a thread continues when a limit is reached. Each thread can change it under
              Thread in the inspector.
            </small>
          </label>
          <div className="st-controls">
            <Select
              id="settings-handoff"
              value={saved.handoffMode}
              title={mode.title}
              onChange={(event) =>
                change({
                  ...saved,
                  handoffMode:
                    handoffModes.find(({ id }) => id === event.target.value)?.id ?? 'most-left',
                })
              }
            >
              {handoffModes.map((item) => (
                <option key={item.id} value={item.id} title={item.title}>
                  {item.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="st-row">
          <span className="st-field" id="settings-theme">
            <span className="st-name">Theme</span>
          </span>
          <div className="st-controls">
            <fieldset className="st-segment" aria-labelledby="settings-theme">
              {(['light', 'dark', 'system'] as const).map((name) => (
                <label key={name} className={theme === name ? 'is-on' : undefined}>
                  <input
                    type="radio"
                    name="settings-theme"
                    value={name}
                    checked={theme === name}
                    onChange={() => onTheme(name)}
                  />
                  {name === 'dark' ? 'Dark' : name === 'light' ? 'Light' : 'System'}
                </label>
              ))}
            </fieldset>
          </div>
        </div>
        {onShowWelcome && (
          <div className="st-row">
            <span className="st-field" id="settings-welcome">
              <span className="st-name">Welcome</span>
              <small className="st-hint">
                The first-run steps: connect a provider, pick a crew, add a project and start a
                thread.
              </small>
            </span>
            <div className="st-controls">
              <button
                type="button"
                className="button secondary"
                aria-describedby="settings-welcome"
                onClick={onShowWelcome}
              >
                Show the welcome again
              </button>
            </div>
          </div>
        )}
        <div className="st-row">
          <span className="st-field">
            <span className="st-name">Diagnostics</span>
            <small className="st-hint">
              Saves a folder with versions, the end of the controller log and the last 200 events of
              the open thread. Secrets, your home folder and email addresses are removed, and
              nothing is sent anywhere.
            </small>
          </span>
          <div className="st-controls">
            <button
              type="button"
              className="button secondary"
              onClick={() => void runExport(source, threadId).then(setExportNote)}
            >
              Export diagnostics
            </button>
          </div>
        </div>
      </div>
      {exportNote && (
        <p className="st-note" role="status">
          {exportNote}
        </p>
      )}
    </section>
  );
}
