import type { ChatCatalogRead, ChatModelSelection } from '@crewkite/contracts';
import { useState } from 'react';
import { familyName } from '../components.tsx';
import { EffortSelect } from '../thread/model-picker.tsx';
import {
  type CrewPreset,
  crewRoleNames,
  handoffModes,
  permissionPolicies,
  readCrewPresets,
  readThreadDefaults,
  type ThreadDefaults,
  writeCrewPresets,
  writeThreadDefaults,
} from './preferences.ts';
import '../thread/crew.css';

const auto = 'auto';
const saved_ = 'saved';

type Entry = ChatCatalogRead['families'][number];
type Choice = { entry: Entry; model: Entry['models'][number] };

const presetId = (name: string) => name.toLowerCase().replace(/\s+/g, '-');
const presetHints: Record<CrewPreset['name'], string> = {
  Solo: 'The builder only. Nothing runs after a reply.',
  Pair: 'A builder and a reviewer on another family.',
  'Full crew': 'Builder, reviewer, challenger and fixer, with an orchestrator that plans the work.',
};
// The fixer and the orchestrator are the builder's model unless the person pins another.
const autoLabel = (role: string) =>
  role === 'builder'
    ? "The thread's model"
    : role === 'fixer' || role === 'orchestrator'
      ? 'Same as the builder'
      : 'Another connected family';

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
    <select
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
    </select>
  );
}

/**
 * A model select and, when the model offers a choice, an effort select beside it. A new model
 * starts on its default effort.
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
  const efforts =
    choices.find(
      ({ entry, model }) => entry.family === value?.family && model.model === value.model,
    )?.model.efforts ?? [];
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
      {value && efforts.length > 1 && (
        <EffortSelect
          label={effortLabel}
          efforts={efforts}
          value={value.effort}
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
}: {
  catalog: ChatCatalogRead | null;
  theme: string;
  onTheme: (theme: 'system' | 'dark' | 'light') => void;
}) {
  const [saved, setSaved] = useState<ThreadDefaults>(() => readThreadDefaults());
  const change = (next: ThreadDefaults) => {
    setSaved(next);
    writeThreadDefaults(next);
  };
  const [presets, setPresets] = useState<CrewPreset[]>(() => readCrewPresets());
  const pin = (name: CrewPreset['name'], role: string, selection: ChatModelSelection | null) => {
    const next = presets.map((preset) =>
      preset.name === name
        ? {
            ...preset,
            members: preset.members.map((member) =>
              member.role === role ? { ...member, selection } : member,
            ),
          }
        : preset,
    );
    setPresets(next);
    writeCrewPresets(next);
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
            <span className="st-name">Permissions</span>
            <small className="st-hint">
              Each thread can change it under Thread in the inspector.
            </small>
          </label>
          <div className="st-controls">
            <select
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
            </select>
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
            <select
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
            </select>
          </div>
        </div>
        {presets.map((preset) => (
          <div key={preset.name} className="st-row">
            <span className="st-field">
              <span className="st-name">Crew preset: {preset.name}</span>
              <small className="st-hint">
                {presetHints[preset.name]} A thread starts from it under Crew in the inspector.
              </small>
            </span>
            <div className="st-controls st-crew">
              {preset.members.map((member) => (
                <div key={member.role} className="st-crew-role">
                  <label htmlFor={`settings-${presetId(preset.name)}-${member.role}`}>
                    {crewRoleNames[member.role]}
                  </label>
                  <span className="st-crew-pick">
                    <SelectionFields
                      id={`settings-${presetId(preset.name)}-${member.role}`}
                      effortLabel={`${preset.name} ${crewRoleNames[member.role]} effort`}
                      choices={choices}
                      value={member.selection}
                      autoText={autoLabel(member.role)}
                      onChange={(selection) => pin(preset.name, member.role, selection)}
                    />
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
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
      </div>
    </section>
  );
}
