import {
  type ChatCatalogRead,
  type ChatCrewRole,
  type ChatFamily,
  MAX_PLAN_RECIPE_CHECKS,
  MAX_PLAN_SLICES,
  MeteredFamilySchema,
  type PlanRecipe,
} from '@crewkite/contracts';
import { Plus, X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { familyName } from '../family-name.ts';
import { Select } from '../select.tsx';
import { modelChoices, SelectionFields } from '../settings/general-card.tsx';
import {
  crewRoleNames,
  flightModes,
  handoffModes,
  permissionPolicies,
} from '../settings/preferences.ts';
import {
  type Available,
  addMember,
  limitFamilies,
  member,
  offLines,
  type Problem,
  ROLE_ORDER,
  shapeWords,
} from './model.ts';

// The form half of the recipe editor: crew, how it runs, checks, schedule and budget. Each field
// writes into the draft through `change`, and nothing here talks to the controller.

type Change = (edit: (draft: PlanRecipe) => void) => void;
type Props = {
  draft: PlanRecipe;
  change: Change;
  problems: readonly Problem[];
  catalog: ChatCatalogRead | null;
  /** The choices the controller has switched on. One it has off is shown, not offered. */
  available: Available;
  /** Why a role cannot take a turn now, by role. The editor works these out once for the page. */
  readiness: Partial<Record<ChatCrewRole, string>>;
  readOnly: boolean;
};

const OPTIONAL: readonly ChatCrewRole[] = ['reviewer', 'fixer', 'challenger'];

/** Why a crew member cannot take a turn now, from the catalog the page already holds. */
export function readinessLine(
  catalog: ChatCatalogRead | null,
  family: ChatFamily,
  model: string,
): string | null {
  if (!catalog || !model) return null;
  const entry = catalog.families.find((item) => item.family === family);
  if (!entry?.connected)
    return `${familyName(family)} is not connected. Connect it in Settings, or pick another provider.`;
  if (!entry.models.some((item) => item.model === model))
    return `${familyName(family)} does not list this model. Pick another.`;
  return null;
}

function Problems({
  id,
  field,
  problems,
}: {
  id: string;
  field: string;
  problems: Props['problems'];
}) {
  const lines = problems.filter((problem) => problem.field === field);
  if (lines.length === 0) return null;
  return (
    <p id={id} className="rc-problem">
      {lines.map((problem) => problem.text).join(' ')}
    </p>
  );
}

const number = (value: string) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** An ISO time as the value a datetime-local input takes, in the person's own zone. */
const localInput = (iso: string) => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
};

const UNITS = [
  { id: 'min', label: 'Minutes', minutes: 1 },
  { id: 'h', label: 'Hours', minutes: 60 },
  { id: 'd', label: 'Days', minutes: 1440 },
] as const;
type Unit = (typeof UNITS)[number];
const unitOf = (minutes: number): Unit =>
  minutes > 0 && minutes % 1440 === 0
    ? UNITS[2]
    : minutes > 0 && minutes % 60 === 0
      ? UNITS[1]
      : UNITS[0];

/** The ids of the lines that describe a control, or nothing when no line shows. */
const describedBy = (...list: (string | undefined)[]) =>
  list.filter((id) => id !== undefined).join(' ') || undefined;

export function RecipeForm({
  draft,
  change,
  problems,
  catalog,
  available,
  readiness,
  readOnly,
}: Props) {
  const ids = useId();
  const off = offLines(draft, available);
  const choices = modelChoices(catalog);
  const has = (field: string) => problems.some((problem) => problem.field === field);
  const describe = (field: string) => (has(field) ? `${ids}-${field}-problem` : undefined);
  // A remove button takes its own row away, so focus moves on once the next render is drawn.
  const focusNext = useRef<(() => HTMLElement | null | undefined) | null>(null);
  const checkFields = useRef<(HTMLInputElement | null)[]>([]);
  const addCheck = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const pick = focusNext.current;
    if (!pick) return;
    focusNext.current = null;
    pick()?.focus();
  });
  const first = choices[0];
  const add = (role: ChatCrewRole) =>
    change((next) => {
      const like = member(next, 'builder')?.selection;
      addMember(next, {
        role,
        selection: like
          ? { ...like }
          : {
              family: first?.entry.family ?? 'openai',
              model: first?.model.model ?? '',
              effort: first?.model.defaultEffort ?? 'default',
            },
      });
    });
  const scheduled = draft.trigger.kind !== 'manual';
  const families = limitFamilies(draft);
  const interval = draft.trigger.kind === 'interval' ? draft.trigger.everyMinutes : 60;
  // The unit the person picked holds while the value is the one they wrote with it, so a cleared
  // field does not turn into minutes while they type. A value from elsewhere, such as an older
  // version or a refresh, shows in the largest unit that divides it.
  const [pick, setPick] = useState<{ id: Unit['id']; minutes: number } | null>(null);
  const unit =
    (pick?.minutes === interval ? UNITS.find(({ id }) => id === pick.id) : undefined) ??
    unitOf(interval);
  return (
    <fieldset className="rc-form" disabled={readOnly}>
      <section className="rc-section" aria-labelledby={`${ids}-crew`}>
        <h4 id={`${ids}-crew`}>Crew</h4>
        <Problems id={`${ids}-crew-problem`} field="crew" problems={problems} />
        {ROLE_ORDER.map((role) => {
          const found = member(draft, role);
          if (!found) return null;
          const line = readiness[role] ?? null;
          return (
            <fieldset
              key={role}
              className="rc-row is-member"
              aria-labelledby={`${ids}-${role}-role`}
              aria-describedby={describedBy(
                describe(`crew.${role}`),
                line ? `${ids}-${role}-ready` : undefined,
              )}
            >
              <span id={`${ids}-${role}-role`} className="rc-label">
                {crewRoleNames[role]}
              </span>
              <span className="rc-controls">
                <SelectionFields
                  id={`${ids}-${role}`}
                  label={`${crewRoleNames[role]} model`}
                  effortLabel={`${crewRoleNames[role]} effort`}
                  choices={choices}
                  value={found.selection.model ? found.selection : null}
                  onChange={(selection) =>
                    change((next) => {
                      const target = member(next, role);
                      if (target && selection) target.selection = selection;
                    })
                  }
                />
                {OPTIONAL.includes(role) && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${role}`}
                    data-tooltip={`Remove ${role}`}
                    onClick={() => {
                      change((next) => {
                        next.crew.members = next.crew.members.filter((item) => item.role !== role);
                      });
                      // The next row's model picker, else the one before.
                      const rows = ROLE_ORDER.filter((other) => member(draft, other));
                      const at = rows.indexOf(role);
                      const to = rows[at + 1] ?? rows[at - 1];
                      focusNext.current = () => document.getElementById(`${ids}-${to}`);
                    }}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </span>
              <Problems
                id={`${ids}-crew.${role}-problem`}
                field={`crew.${role}`}
                problems={problems}
              />
              {line && (
                <p id={`${ids}-${role}-ready`} className="rc-note is-warn">
                  {line}
                </p>
              )}
            </fieldset>
          );
        })}
        <div className="rc-adds">
          {OPTIONAL.filter((role) => !member(draft, role)).map((role) => (
            <button key={role} type="button" className="button secondary" onClick={() => add(role)}>
              <Plus size={13} aria-hidden="true" />
              Add {role}
            </button>
          ))}
        </div>
        <div className="rc-row">
          <label className="rc-label" htmlFor={`${ids}-slices`}>
            Most slices
          </label>
          <span className="rc-controls">
            <input
              id={`${ids}-slices`}
              className="rc-number"
              type="number"
              min={1}
              max={MAX_PLAN_SLICES}
              aria-invalid={has('run.maxSlices') || undefined}
              aria-describedby={describedBy(describe('run.maxSlices'), `${ids}-slices-hint`)}
              value={draft.run.maxSlices || ''}
              onChange={(event) =>
                change((next) => {
                  next.run.maxSlices = number(event.target.value);
                })
              }
            />
            <span id={`${ids}-slices-hint`} className="rc-unit">
              1 to {MAX_PLAN_SLICES}.
            </span>
          </span>
          <Problems id={`${ids}-run.maxSlices-problem`} field="run.maxSlices" problems={problems} />
        </div>
      </section>

      <section className="rc-section" aria-labelledby={`${ids}-run`}>
        <h3 id={`${ids}-run`}>How it runs</h3>
        <div className="rc-row">
          <label className="rc-label" htmlFor={`${ids}-shape`}>
            Run type
          </label>
          <span className="rc-controls">
            <Select
              id={`${ids}-shape`}
              value={draft.shape}
              aria-describedby={`${ids}-shape-hint`}
              onChange={(event) =>
                change((next) => {
                  next.shape = event.target.value === 'report' ? 'report' : 'change';
                  // A report needs a challenger to argue against its findings.
                  if (next.shape === 'report' && !member(next, 'challenger')) {
                    const like = member(next, 'builder')?.selection;
                    if (like) addMember(next, { role: 'challenger', selection: { ...like } });
                  }
                })
              }
            >
              <option value="change">{shapeWords.change}</option>
              <option value="report" disabled={off.shape !== null}>
                {shapeWords.report}
              </option>
            </Select>
          </span>
          {off.shape ? (
            <p
              id={`${ids}-shape-hint`}
              className={draft.shape === 'report' ? 'rc-problem' : 'rc-note'}
            >
              {off.shape}
            </p>
          ) : (
            <p id={`${ids}-shape-hint`} className="rc-note">
              Changes files: the crew edits and the run ends ready for Accept. Report only: every
              slice reads, and the run ends with one message.
            </p>
          )}
        </div>
        <div className="rc-row">
          <label className="rc-label" htmlFor={`${ids}-flight`}>
            Flight mode
          </label>
          <span className="rc-controls">
            <Select
              id={`${ids}-flight`}
              value={draft.run.flightMode}
              onChange={(event) =>
                change((next) => {
                  next.run.flightMode = event.target.value === 'glide' ? 'glide' : 'balanced';
                })
              }
            >
              {flightModes
                .filter((mode) => mode.id !== 'manual')
                .map((mode) => (
                  <option key={mode.id} value={mode.id} title={mode.title}>
                    {mode.label}
                  </option>
                ))}
            </Select>
          </span>
        </div>
        <div className="rc-row">
          <label className="rc-label" htmlFor={`${ids}-policy`}>
            Permissions
          </label>
          <span className="rc-controls">
            <Select
              id={`${ids}-policy`}
              value={draft.run.permissionPolicy}
              onChange={(event) =>
                change((next) => {
                  const picked = permissionPolicies.find(({ id }) => id === event.target.value);
                  if (picked) next.run.permissionPolicy = picked.id;
                })
              }
            >
              {permissionPolicies.map((policy) => (
                <option key={policy.id} value={policy.id} title={policy.title}>
                  {policy.label}
                </option>
              ))}
            </Select>
          </span>
        </div>
        <div className="rc-row">
          <label className="rc-label" htmlFor={`${ids}-handoff`}>
            When a provider reaches a limit
          </label>
          <span className="rc-controls">
            <Select
              id={`${ids}-handoff`}
              value={draft.run.handoff.auto ? 'move' : 'stop'}
              onChange={(event) =>
                change((next) => {
                  next.run.handoff.auto = event.target.value === 'move';
                })
              }
            >
              <option value="stop">Stop and say so</option>
              <option value="move">Move to another provider</option>
            </Select>
          </span>
        </div>
        {draft.run.handoff.auto && (
          <div className="rc-row">
            <label className="rc-label" htmlFor={`${ids}-move-by`}>
              Move by
            </label>
            <span className="rc-controls">
              <Select
                id={`${ids}-move-by`}
                value={draft.run.handoff.mode}
                onChange={(event) =>
                  change((next) => {
                    const picked = handoffModes.find(({ id }) => id === event.target.value);
                    if (picked) next.run.handoff.mode = picked.id;
                  })
                }
              >
                {handoffModes.map((mode) => (
                  <option key={mode.id} value={mode.id} title={mode.title}>
                    {mode.label}
                  </option>
                ))}
              </Select>
            </span>
          </div>
        )}
      </section>

      <section className="rc-section" aria-labelledby={`${ids}-checks`}>
        <h3 id={`${ids}-checks`}>Hooks</h3>
        <p className="rc-note">
          {draft.checks.length === 0
            ? 'No checks. A run ends without one.'
            : 'The same checks run at three points: after each slice, after each merge and at Accept.'}{' '}
          One line each, as you would type it.
        </p>
        {draft.checks.map((check, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a check has no identity but its place while it is typed
          <div key={index} className="rc-row is-check">
            <span className="rc-controls">
              <input
                ref={(node) => {
                  checkFields.current[index] = node;
                }}
                className="rc-command"
                type="text"
                aria-label={`Check ${index + 1} command`}
                aria-invalid={has(`checks.${index}`) || undefined}
                aria-describedby={describe(`checks.${index}`)}
                placeholder="pnpm test"
                maxLength={500}
                spellCheck={false}
                value={check.command}
                onChange={(event) =>
                  change((next) => {
                    const target = next.checks[index];
                    if (target) target.command = event.target.value;
                  })
                }
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove check ${index + 1}`}
                data-tooltip="Remove check"
                onClick={() => {
                  change((next) => {
                    next.checks.splice(index, 1);
                  });
                  // The field now in this row's place, else the row before, else Add check.
                  focusNext.current = () =>
                    checkFields.current[index] ??
                    checkFields.current[index - 1] ??
                    addCheck.current;
                }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </span>
            <Problems
              id={`${ids}-checks.${index}-problem`}
              field={`checks.${index}`}
              problems={problems}
            />
          </div>
        ))}
        {draft.checks.length < MAX_PLAN_RECIPE_CHECKS && (
          <div className="rc-adds">
            <button
              ref={addCheck}
              type="button"
              className="button secondary"
              onClick={() =>
                change((next) => {
                  next.checks.push({ command: '' });
                })
              }
            >
              <Plus size={13} aria-hidden="true" />
              Add check
            </button>
          </div>
        )}
      </section>

      <section className="rc-section" aria-labelledby={`${ids}-schedule`}>
        <h3 id={`${ids}-schedule`}>Loop</h3>
        <div className="rc-row">
          <label className="rc-label" htmlFor={`${ids}-starts`}>
            Starts
          </label>
          <span className="rc-controls">
            <Select
              id={`${ids}-starts`}
              value={draft.trigger.kind}
              aria-describedby={describe('trigger')}
              onChange={(event) =>
                change((next) => {
                  const kind = event.target.value;
                  if (kind === 'manual') {
                    next.trigger = { kind: 'manual' };
                    next.budget = null;
                    next.work = null;
                    return;
                  }
                  if (kind === 'once')
                    next.trigger = {
                      kind: 'once',
                      at: new Date(Math.ceil(Date.now() / 3_600_000 + 1) * 3_600_000).toISOString(),
                    };
                  else if (kind === 'interval')
                    next.trigger = { kind: 'interval', everyMinutes: 60 };
                  else
                    next.trigger = {
                      kind: 'reset',
                      family: limitFamilies(next)[0] ?? MeteredFamilySchema.options[0],
                    };
                  // The run limit and the provider limits start empty. The person states them.
                  next.budget ??= { maxRuns: 0, maxUsedPercent: {}, maxWaiting: 3 };
                  next.work ??= { kind: 'request', text: '' };
                })
              }
            >
              <option value="manual">Manual</option>
              <option value="once">Once</option>
              <option value="interval">Every</option>
              <option value="reset">At a provider reset</option>
            </Select>
            {draft.trigger.kind === 'once' && (
              <input
                type="datetime-local"
                aria-label="Date and time"
                aria-invalid={has('trigger') || undefined}
                aria-describedby={describe('trigger')}
                value={localInput(draft.trigger.at)}
                onChange={(event) =>
                  change((next) => {
                    const at = new Date(event.target.value);
                    if (next.trigger.kind === 'once' && !Number.isNaN(at.getTime()))
                      next.trigger.at = at.toISOString();
                  })
                }
              />
            )}
            {draft.trigger.kind === 'interval' && (
              <>
                <input
                  className="rc-number"
                  type="number"
                  min={1}
                  aria-label="Every"
                  aria-invalid={has('trigger') || undefined}
                  aria-describedby={describedBy(describe('trigger'), `${ids}-every-hint`)}
                  value={interval / unit.minutes || ''}
                  onChange={(event) => {
                    const minutes = number(event.target.value) * unit.minutes;
                    setPick({ id: unit.id, minutes });
                    change((next) => {
                      if (next.trigger.kind === 'interval') next.trigger.everyMinutes = minutes;
                    });
                  }}
                />
                <Select
                  aria-label="Unit"
                  value={unit.id}
                  onChange={(event) => {
                    const picked = UNITS.find(({ id }) => id === event.target.value) ?? UNITS[0];
                    const minutes = (interval / unit.minutes) * picked.minutes;
                    setPick({ id: picked.id, minutes });
                    change((next) => {
                      if (next.trigger.kind === 'interval') next.trigger.everyMinutes = minutes;
                    });
                  }}
                >
                  {UNITS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </Select>
                <span id={`${ids}-every-hint`} className="rc-unit">
                  At least 15 minutes.
                </span>
              </>
            )}
            {draft.trigger.kind === 'reset' && (
              <Select
                aria-label="Provider"
                value={draft.trigger.family}
                onChange={(event) =>
                  change((next) => {
                    const picked = MeteredFamilySchema.options.find(
                      (family) => family === event.target.value,
                    );
                    if (next.trigger.kind === 'reset' && picked) next.trigger.family = picked;
                  })
                }
              >
                {MeteredFamilySchema.options.map((family) => (
                  <option key={family} value={family}>
                    {familyName(family)}
                  </option>
                ))}
              </Select>
            )}
          </span>
          <Problems id={`${ids}-trigger-problem`} field="trigger" problems={problems} />
        </div>
        {scheduled && draft.work && (
          <div className="rc-row">
            <label className="rc-label" htmlFor={`${ids}-work`}>
              Work
            </label>
            <span className="rc-controls">
              <Select
                id={`${ids}-work`}
                value={draft.work.kind}
                aria-describedby={off.work && !has('work') ? `${ids}-work-off` : undefined}
                onChange={(event) =>
                  change((next) => {
                    next.work =
                      event.target.value === 'checklist'
                        ? { kind: 'checklist', path: '' }
                        : { kind: 'request', text: '' };
                  })
                }
              >
                <option value="request">A fixed request</option>
                <option value="checklist" disabled={off.work !== null}>
                  A checklist file
                </option>
              </Select>
            </span>
            {/* After a save attempt the same sentence shows as the field's problem. */}
            {off.work && !has('work') && (
              <p
                id={`${ids}-work-off`}
                className={draft.work.kind === 'checklist' ? 'rc-problem' : 'rc-note'}
              >
                {off.work}
              </p>
            )}
            {draft.work.kind === 'request' ? (
              <textarea
                className="rc-text"
                aria-label="Request"
                aria-invalid={has('work') || undefined}
                aria-describedby={describe('work')}
                placeholder="The same words every run."
                maxLength={8000}
                rows={3}
                value={draft.work.text}
                onChange={(event) =>
                  change((next) => {
                    if (next.work?.kind === 'request') next.work.text = event.target.value;
                  })
                }
              />
            ) : (
              <>
                <input
                  className="rc-command"
                  type="text"
                  aria-label="Checklist file"
                  aria-invalid={has('work') || undefined}
                  aria-describedby={describedBy(describe('work'), `${ids}-checklist-hint`)}
                  spellCheck={false}
                  maxLength={1024}
                  value={draft.work.path}
                  onChange={(event) =>
                    change((next) => {
                      if (next.work?.kind === 'checklist') next.work.path = event.target.value;
                    })
                  }
                />
                <p id={`${ids}-checklist-hint`} className="rc-note">
                  The run takes the first unchecked item and proposes ticking it.
                </p>
              </>
            )}
            <Problems id={`${ids}-work-problem`} field="work" problems={problems} />
          </div>
        )}
        {scheduled && draft.budget && (
          <section className="rc-section" aria-labelledby={`${ids}-budget`}>
            <h4 id={`${ids}-budget`}>Budget</h4>
            <p className="rc-note">A loop needs these before it can be saved.</p>
            <div className="rc-row">
              <label className="rc-label" htmlFor={`${ids}-max-runs`}>
                Most runs
              </label>
              <span className="rc-controls">
                <input
                  id={`${ids}-max-runs`}
                  className="rc-number"
                  type="number"
                  min={1}
                  max={1000}
                  aria-invalid={has('budget.maxRuns') || undefined}
                  aria-describedby={describedBy(describe('budget.maxRuns'), `${ids}-max-runs-hint`)}
                  value={draft.budget.maxRuns || ''}
                  onChange={(event) =>
                    change((next) => {
                      if (next.budget) next.budget.maxRuns = number(event.target.value);
                    })
                  }
                />
                <span id={`${ids}-max-runs-hint`} className="rc-unit">
                  Then the loop stops.
                </span>
              </span>
              <Problems
                id={`${ids}-budget.maxRuns-problem`}
                field="budget.maxRuns"
                problems={problems}
              />
            </div>
            {families.map((family) => (
              <div key={family} className="rc-row">
                <label className="rc-label" htmlFor={`${ids}-limit-${family}`}>
                  {familyName(family)}: stop starting at
                </label>
                <span className="rc-controls">
                  <input
                    id={`${ids}-limit-${family}`}
                    className="rc-number"
                    type="number"
                    min={1}
                    max={99}
                    aria-invalid={has(`budget.${family}`) || undefined}
                    aria-describedby={describe(`budget.${family}`)}
                    value={draft.budget?.maxUsedPercent[family] ?? ''}
                    onChange={(event) =>
                      change((next) => {
                        if (!next.budget) return;
                        if (event.target.value === '') delete next.budget.maxUsedPercent[family];
                        else next.budget.maxUsedPercent[family] = number(event.target.value);
                      })
                    }
                  />
                  <span className="rc-unit">% used</span>
                </span>
                <Problems
                  id={`${ids}-budget.${family}-problem`}
                  field={`budget.${family}`}
                  problems={problems}
                />
              </div>
            ))}
            <div className="rc-row">
              <label className="rc-label" htmlFor={`${ids}-waiting`}>
                Most runs waiting for you
              </label>
              <span className="rc-controls">
                <input
                  id={`${ids}-waiting`}
                  className="rc-number"
                  type="number"
                  min={1}
                  max={20}
                  aria-invalid={has('budget.maxWaiting') || undefined}
                  aria-describedby={describedBy(
                    describe('budget.maxWaiting'),
                    `${ids}-waiting-hint`,
                  )}
                  value={draft.budget.maxWaiting || ''}
                  onChange={(event) =>
                    change((next) => {
                      if (next.budget) next.budget.maxWaiting = number(event.target.value);
                    })
                  }
                />
                <span className="rc-unit">Then the loop pauses.</span>
              </span>
              <p id={`${ids}-waiting-hint`} className="rc-note">
                A run waits when it asks a question or is ready for Accept.
              </p>
              <Problems
                id={`${ids}-budget.maxWaiting-problem`}
                field="budget.maxWaiting"
                problems={problems}
              />
            </div>
            <Problems id={`${ids}-budget-problem`} field="budget" problems={problems} />
          </section>
        )}
      </section>
    </fieldset>
  );
}
