import type { ChatCatalogRead, ChatEffort } from '@crewkite/contracts';
import { useState } from 'react';
import { familyName } from '../components.tsx';
import { effortLabels } from '../thread/model-picker.tsx';
import {
  permissionPolicies,
  readThreadDefaults,
  type ThreadDefaults,
  writeThreadDefaults,
} from './preferences.ts';

const auto = 'auto';
const saved_ = 'saved';

export function GeneralCard({
  catalog,
  theme,
  onTheme,
}: {
  catalog: ChatCatalogRead | null;
  theme: string;
  onTheme: (theme: 'dark' | 'light') => void;
}) {
  const [saved, setSaved] = useState<ThreadDefaults>(() => readThreadDefaults());
  const change = (next: ThreadDefaults) => {
    setSaved(next);
    writeThreadDefaults(next);
  };
  const entries = (catalog?.families ?? []).filter(
    (entry) => entry.connected && entry.models.length > 0,
  );
  const choices = entries.flatMap((entry) => entry.models.map((model) => ({ entry, model })));
  const current = saved.selection;
  const listed = choices.findIndex(
    ({ entry, model }) => entry.family === current?.family && model.model === current.model,
  );
  const efforts = choices[listed]?.model.efforts ?? [];
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
            <select
              id="settings-model"
              value={listed >= 0 ? String(listed) : current ? saved_ : auto}
              onChange={(event) => {
                const choice = choices[Number(event.target.value)];
                if (event.target.value === saved_) return;
                change({
                  ...saved,
                  selection: choice
                    ? {
                        family: choice.entry.family,
                        model: choice.model.model,
                        effort: choice.model.defaultEffort,
                      }
                    : null,
                });
              }}
            >
              <option value={auto}>Most allowance left</option>
              {current && listed < 0 && (
                <option value={saved_}>
                  {familyName(current.family)} · {current.model} (not available now)
                </option>
              )}
              {entries.map((entry) => (
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
            {current && efforts.length > 1 && (
              <select
                aria-label="Effort"
                value={current.effort}
                onChange={(event) =>
                  change({
                    ...saved,
                    selection: { ...current, effort: event.target.value as ChatEffort },
                  })
                }
              >
                {efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effortLabels[effort]}
                  </option>
                ))}
              </select>
            )}
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
          <span className="st-field" id="settings-theme">
            <span className="st-name">Theme</span>
          </span>
          <div className="st-controls">
            <fieldset className="st-segment" aria-labelledby="settings-theme">
              {(['dark', 'light'] as const).map((name) => (
                <label key={name} className={theme === name ? 'is-on' : undefined}>
                  <input
                    type="radio"
                    name="settings-theme"
                    value={name}
                    checked={theme === name}
                    onChange={() => onTheme(name)}
                  />
                  {name === 'dark' ? 'Dark' : 'Light'}
                </label>
              ))}
            </fieldset>
          </div>
        </div>
      </div>
    </section>
  );
}
