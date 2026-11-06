import {
  allowsSubagents,
  type ChatCatalogRead,
  ChatCrewRoleSchema,
  type ChatFlightMode,
  SAVED_CREWS_MAX,
} from '@crewkite/contracts';
import { Pencil, Plus, RotateCw, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Dialog } from '../components.tsx';
import { InfoMark, RoleInfo } from '../thread/role-info.tsx';
import { SubagentSwitch } from '../thread/subagent-switch.tsx';
import {
  type CrewLoad,
  deleteCrew,
  onCrewLoad,
  readCrewLoad,
  reloadCrews,
  saveCrew,
  setDefaultCrew,
} from './crew-store.ts';
import { modelChoices, SelectionFields } from './general-card.tsx';
import {
  type CrewChoice,
  type CrewMemberPin,
  type CrewPreset,
  crewChoices,
  crewNameProblem,
  crewPresetHints,
  crewRoleNames,
  flightModeInfo,
  flightModes,
  onCrewChoices,
  readCrewPresets,
  readDefaultCrew,
  readProjectCrews,
  readSavedCrews,
  type SavedCrew,
  savedCrewId,
  savedCrewsLoaded,
  writeCrewPresets,
  writeProjectCrew,
} from './preferences.ts';
import '../thread/crew.css';
import { Select } from '../select.tsx';

const presetId = (name: string) => name.toLowerCase().replace(/\s+/g, '-');
// The fixer and the orchestrator are the builder's model unless the person pins another.
export const autoLabel = (role: string) =>
  role === 'builder'
    ? "The thread's model"
    : role === 'fixer' || role === 'orchestrator'
      ? 'Same as the builder'
      : 'Another connected family';

const readChoices = () => ({
  choices: crewChoices(),
  defaultId: readDefaultCrew(),
  projects: readProjectCrews(),
  saved: readSavedCrews(),
  loaded: savedCrewsLoaded(),
});

/** Where the read of the saved crews stands. */
function useCrewLoad(): CrewLoad {
  const [state, setState] = useState(readCrewLoad);
  useEffect(() => onCrewLoad(() => setState(readCrewLoad())), []);
  return state;
}

/** The crews a thread can start from, read again whenever a saved crew or a default changes. */
export function useCrewChoices() {
  const [state, setState] = useState(readChoices);
  useEffect(() => onCrewChoices(() => setState(readChoices())), []);
  return state;
}

/** One select of the built-in presets and the saved crews. */
export function CrewSelect({
  id,
  label,
  value,
  choices,
  placeholder,
  extra,
  disabled,
  onChange,
}: {
  id?: string;
  label?: string;
  value: string;
  choices: readonly CrewChoice[];
  /** A first entry for a value no choice has, such as a thread with no crew yet. */
  placeholder?: string;
  /** An entry above the crews, such as "Use the default crew". */
  extra?: { value: string; label: string };
  disabled?: boolean;
  onChange: (id: string) => void;
}) {
  const presets = choices.filter((choice) => choice.id.startsWith('preset:'));
  const saved = choices.filter((choice) => choice.id.startsWith('saved:'));
  const known = choices.some((choice) => choice.id === value) || extra?.value === value;
  return (
    <Select
      id={id}
      aria-label={label}
      value={known ? value : ''}
      disabled={disabled}
      title={choices.find((choice) => choice.id === value)?.hint}
      onChange={(event) => event.target.value && onChange(event.target.value)}
    >
      {!known && (
        <option value="" disabled>
          {placeholder ?? 'Pick a crew'}
        </option>
      )}
      {extra && <option value={extra.value}>{extra.label}</option>}
      <optgroup label="Presets">
        {presets.map((choice) => (
          <option key={choice.id} value={choice.id} title={choice.hint}>
            {choice.name}
          </option>
        ))}
      </optgroup>
      {saved.length > 0 && (
        <optgroup label="Saved crews">
          {saved.map((choice) => (
            <option key={choice.id} value={choice.id} title={choice.hint}>
              {choice.name}
            </option>
          ))}
        </optgroup>
      )}
    </Select>
  );
}

/**
 * Build or edit a saved crew: which roles it has, the model and effort of each (or a pick when a
 * thread starts), the subagent switch, the flight mode and a name.
 */
export function CrewDialog({
  catalog,
  initial,
  saved,
  onSave,
  onClose,
}: {
  catalog: ChatCatalogRead | null;
  /** The crew to edit. Null builds a new one. */
  initial: SavedCrew | null;
  saved: readonly SavedCrew[];
  onSave: (crew: SavedCrew) => void;
  onClose: () => void;
}) {
  const idBase = useId();
  const [name, setName] = useState(initial?.name ?? '');
  const [members, setMembers] = useState<CrewMemberPin[]>(
    initial?.members ?? [{ role: 'builder', selection: null }],
  );
  const [flightMode, setFlightMode] = useState<ChatFlightMode>(initial?.flightMode ?? 'manual');
  const [tried, setTried] = useState(false);
  const choices = modelChoices(catalog);
  const problem = crewNameProblem(name, saved, initial?.id ?? null);
  const mode = flightModes.find(({ id }) => id === flightMode) ?? flightModes[0];
  const update = (role: CrewMemberPin['role'], change: Partial<CrewMemberPin>) =>
    setMembers((current) =>
      current.map((member) => (member.role === role ? { ...member, ...change } : member)),
    );
  const include = (role: CrewMemberPin['role'], on: boolean) =>
    setMembers((current) =>
      on
        ? ChatCrewRoleSchema.options.flatMap((value) => {
            const member = current.find((item) => item.role === value);
            return member ? [member] : value === role ? [{ role, selection: null }] : [];
          })
        : current.filter((member) => member.role !== role),
    );
  function save() {
    setTried(true);
    if (problem) return;
    onSave({ id: initial?.id ?? savedCrewId(), name: name.trim(), members, flightMode });
  }
  return (
    <Dialog title={initial ? 'Edit crew' : 'New crew'} onClose={onClose} wide>
      <form
        className="crew-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="crew-dialog-body">
          <label className="crew-dialog-field" htmlFor={`${idBase}-name`}>
            <span className="st-name">Name</span>
            <input
              id={`${idBase}-name`}
              value={name}
              maxLength={60}
              placeholder="Review heavy"
              aria-invalid={tried && !!problem}
              aria-describedby={tried && problem ? `${idBase}-name-problem` : undefined}
              onChange={(event) => setName(event.target.value)}
            />
            {tried && problem && (
              <small className="crew-dialog-problem" id={`${idBase}-name-problem`} role="alert">
                {problem}
              </small>
            )}
          </label>
          <fieldset className="crew-dialog-roles">
            <legend className="st-name">Roles</legend>
            <small className="st-hint">
              The builder is in every crew. A role left on its automatic choice gets a model when a
              thread starts from the crew, so the crew still works after a provider disconnects.
            </small>
            {ChatCrewRoleSchema.options.map((role) => {
              const member = members.find((item) => item.role === role);
              const field = `${idBase}-${role}`;
              return (
                <div key={role} className="crew-dialog-role">
                  <span className="role-name">
                    <label className="sa-switch" htmlFor={`${field}-in`}>
                      <input
                        id={`${field}-in`}
                        type="checkbox"
                        checked={!!member}
                        disabled={role === 'builder'}
                        onChange={(event) => include(role, event.target.checked)}
                      />
                      <span>{crewRoleNames[role]}</span>
                    </label>
                    <RoleInfo of={role} />
                  </span>
                  {member ? (
                    <span className="st-crew-pick">
                      <SelectionFields
                        id={field}
                        label={`${crewRoleNames[role]} model`}
                        effortLabel={`${crewRoleNames[role]} effort`}
                        choices={choices}
                        value={member.selection}
                        autoText={autoLabel(role)}
                        onChange={(selection) => update(role, { selection })}
                      />
                      <SubagentSwitch
                        id={`${field}-subagents`}
                        role={crewRoleNames[role]}
                        family={member.selection?.family ?? null}
                        checked={allowsSubagents(member, member.selection?.family)}
                        onChange={(allowSubagents) => update(role, { allowSubagents })}
                      />
                    </span>
                  ) : (
                    <span className="st-hint">
                      {role === 'fixer' && members.some((item) => item.role === 'reviewer')
                        ? 'Not in this crew. The builder fixes the findings.'
                        : 'Not in this crew'}
                    </span>
                  )}
                </div>
              );
            })}
          </fieldset>
          <label className="crew-dialog-field" htmlFor={`${idBase}-mode`}>
            <span className="role-name st-name">
              Flight mode <InfoMark {...flightModeInfo[flightMode]} />
            </span>
            <Select
              id={`${idBase}-mode`}
              value={flightMode}
              title={mode.title}
              onChange={(event) => setFlightMode(event.target.value as ChatFlightMode)}
            >
              {flightModes.map((item) => (
                <option key={item.id} value={item.id} title={item.title}>
                  {item.label}
                </option>
              ))}
            </Select>
            <small className="st-hint">{mode.title}</small>
          </label>
        </div>
        <div className="dialog-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary">
            Save crew
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Crews in Settings: the crew new threads start with, a project's own crew, the built-in presets
 * and the crews the person saved.
 */
export function CrewsCard({
  catalog,
  projects,
}: {
  catalog: ChatCatalogRead | null;
  projects: readonly { id: string; name: string }[];
}) {
  const { choices, defaultId, projects: projectCrews, saved, loaded } = useCrewChoices();
  const load = useCrewLoad();
  const [presets, setPresets] = useState<CrewPreset[]>(() => readCrewPresets());
  const [editing, setEditing] = useState<SavedCrew | 'new' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // One project at a time, so the row stays one line however many projects there are.
  const [projectId, setProjectId] = useState<string | null>(null);
  const project = projects.find((value) => value.id === projectId) ?? projects[0];
  // The controller keeps saved crews and the default. A change it refuses leaves the list as it
  // was and says why.
  async function change(work: () => Promise<void>): Promise<boolean> {
    try {
      await work();
      setProblem(null);
      return true;
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : 'The change was not saved.');
      return false;
    }
  }
  const choicesOfModels = modelChoices(catalog);
  const pin = (
    name: CrewPreset['name'],
    role: string,
    change: Partial<Pick<CrewMemberPin, 'selection' | 'allowSubagents'>>,
  ) => {
    const next = presets.map((preset) =>
      preset.name === name
        ? {
            ...preset,
            members: preset.members.map((member) =>
              member.role === role ? { ...member, ...change } : member,
            ),
          }
        : preset,
    );
    setPresets(next);
    writeCrewPresets(next);
  };
  // The controller hands the default back to Solo when it named the crew. A project crew that
  // named it follows the default again.
  async function remove(crew: SavedCrew) {
    if (!(await change(() => deleteCrew(crew.id)))) return;
    for (const [project, id] of Object.entries(projectCrews))
      if (id === `saved:${crew.id}`) writeProjectCrew(project, null);
  }
  const defaultName = choices.find((choice) => choice.id === defaultId)?.name ?? 'Solo';
  return (
    <section className="st-card" aria-labelledby="settings-crews">
      <header className="st-card-head">
        <h2 id="settings-crews">Crews</h2>
        <span className="st-detail">Who runs each step of a thread</span>
      </header>
      <div className="st-rows">
        <div className="st-row">
          <label className="st-field" htmlFor="settings-default-crew">
            <span className="st-name">Default crew for new threads</span>
            <small className="st-hint">
              A project below can start with another. Each thread can change it under Crew in the
              inspector.
            </small>
          </label>
          <div className="st-controls">
            <CrewSelect
              id="settings-default-crew"
              value={defaultId}
              choices={choices}
              onChange={(id) => void change(() => setDefaultCrew(id))}
            />
          </div>
        </div>
        {problem && (
          <p className="st-note" role="alert">
            {problem}
          </p>
        )}
        {project && (
          <div className="st-row">
            <span className="st-field">
              <span className="st-name">Project crews</span>
              <small className="st-hint">New threads in a project start with its crew.</small>
            </span>
            <div className="st-controls">
              <Select
                aria-label="Project"
                value={project.id}
                onChange={(event) => setProjectId(event.target.value)}
              >
                {projects.map((value) => {
                  const own = projectCrews[value.id];
                  const name = own && choices.find((choice) => choice.id === own)?.name;
                  return (
                    <option key={value.id} value={value.id}>
                      {name ? `${value.name} (${name})` : value.name}
                    </option>
                  );
                })}
              </Select>
              <CrewSelect
                label={`Crew for ${project.name}`}
                value={projectCrews[project.id] ?? 'default'}
                extra={{ value: 'default', label: `Default (${defaultName})` }}
                choices={choices}
                onChange={(id) => writeProjectCrew(project.id, id === 'default' ? null : id)}
              />
            </div>
          </div>
        )}
        <div className="st-row">
          <span className="st-field">
            <span className="st-name">Saved crews</span>
            <small className="st-hint">
              Crews you build. They show with the presets wherever a crew is picked.
            </small>
          </span>
          <div className="st-controls st-saved-crews">
            {!loaded && load.state === 'failed' ? (
              <div className="st-crews-failed" role="alert">
                <p className="st-note">Saved crews could not be read. {load.message}</p>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void reloadCrews().catch(() => {})}
                >
                  <RotateCw size={13} aria-hidden="true" />
                  Try again
                </button>
              </div>
            ) : !loaded ? (
              <p className="st-hint">
                {load.state === 'loading'
                  ? 'Loading saved crews.'
                  : 'Saved crews load when the controller connects.'}
              </p>
            ) : saved.length === 0 ? (
              <p className="st-hint">None yet.</p>
            ) : (
              <ul className="st-saved-list">
                {saved.map((crew) => (
                  <li key={crew.id}>
                    <span className="st-field">
                      <span className="st-name">
                        {crew.name}
                        {defaultId === `saved:${crew.id}` && (
                          <span className="st-pill is-on">Default</span>
                        )}
                      </span>
                      <small className="st-hint">
                        {choices.find((choice) => choice.id === `saved:${crew.id}`)?.hint}
                      </small>
                    </span>
                    <button
                      type="button"
                      className="button secondary"
                      aria-label={`Edit ${crew.name}`}
                      onClick={() => setEditing(crew)}
                    >
                      <Pencil size={13} aria-hidden="true" />
                      Edit
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      aria-label={`Delete ${crew.name}`}
                      onClick={() => void remove(crew)}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="button secondary"
              disabled={!loaded || saved.length >= SAVED_CREWS_MAX}
              onClick={() => setEditing('new')}
            >
              <Plus size={14} aria-hidden="true" />
              New crew
            </button>
          </div>
        </div>
        {presets.map((preset) => (
          <div key={preset.name} className="st-row">
            <span className="st-field">
              <span className="st-name">Crew preset: {preset.name}</span>
              <small className="st-hint">{crewPresetHints[preset.name]}</small>
            </span>
            <div className="st-controls st-crew">
              {preset.members.map((member) => (
                <div key={member.role} className="st-crew-role">
                  <span className="role-name">
                    <label htmlFor={`settings-${presetId(preset.name)}-${member.role}`}>
                      {crewRoleNames[member.role]}
                    </label>
                    <RoleInfo of={member.role} />
                  </span>
                  <span className="st-crew-pick">
                    <SelectionFields
                      id={`settings-${presetId(preset.name)}-${member.role}`}
                      effortLabel={`${preset.name} ${crewRoleNames[member.role]} effort`}
                      choices={choicesOfModels}
                      value={member.selection}
                      autoText={autoLabel(member.role)}
                      onChange={(selection) => pin(preset.name, member.role, { selection })}
                    />
                    <SubagentSwitch
                      id={`settings-${presetId(preset.name)}-${member.role}-subagents`}
                      role={`${preset.name} ${crewRoleNames[member.role]}`}
                      family={member.selection?.family ?? null}
                      checked={allowsSubagents(member, member.selection?.family)}
                      onChange={(allowSubagents) =>
                        pin(preset.name, member.role, { allowSubagents })
                      }
                    />
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="st-row">
          <span className="st-field">
            <span className="st-name">Other roles</span>
            <small className="st-hint">A thread runs these outside any crew.</small>
          </span>
          <div className="st-controls st-crew">
            <span className="role-name">
              Advisor <RoleInfo of="advisor" />
            </span>
            <span className="role-name">
              Ask <RoleInfo of="ask" />
            </span>
          </div>
        </div>
      </div>
      {editing && (
        <CrewDialog
          catalog={catalog}
          initial={editing === 'new' ? null : editing}
          saved={saved}
          onClose={() => setEditing(null)}
          onSave={(crew) =>
            void change(() => saveCrew(crew)).then((done) => done && setEditing(null))
          }
        />
      )}
    </section>
  );
}
