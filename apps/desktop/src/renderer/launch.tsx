import {
  type Guidance,
  type Policy,
  PolicySchema,
  type ReviewMethod,
  type Role,
  type Run,
  RunSchema,
  type Snapshot,
  type Task,
} from '@crewkite/contracts';
import { createDemoFixtures } from '@crewkite/testkit';
import {
  ArrowRight,
  Check,
  ChevronRight,
  Circle,
  GitBranch,
  Info,
  Pin,
  Save,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, familyName, moveTabFocus, RouterCard, SourceFacts } from './components.tsx';
import type { Workspace } from './source.ts';
import { loadTeams, roleLabels, type SavedTeam, saveTeam } from './templates.ts';

const roleNames = Object.keys(roleLabels) as Role['role'][];
const teamNames = ['Glide', 'Formation', 'Expedition', 'Custom'] as const;
type TeamName = (typeof teamNames)[number];
type Method = ReviewMethod;
type MethodId = Method['id'];
const methodCatalog: Array<{ id: MethodId; name: string; description: string; credit: string }> = [
  {
    id: 'keep-it-simple',
    name: 'Keep it simple',
    description: 'Inspect the change for unnecessary machinery and a smaller working solution.',
    credit: 'Ponytail',
  },
  {
    id: 'challenge-assumptions',
    name: 'Challenge assumptions',
    description: 'Test the assumptions behind the plan before accepting its claims.',
    credit: 'ADHD',
  },
  {
    id: 'second-opinion',
    name: 'Second opinion',
    description: 'Request one independent review against the candidate and criteria.',
    credit: 'multi',
  },
  {
    id: 'round-robin',
    name: 'Round-robin review',
    description: 'Run a finite sequence of critiques with an explicit cycle cap.',
    credit: 'multi',
  },
];
const principles = [
  'Keep the source checkout untouched.',
  'Require review for dependency and configuration changes.',
  'Stop on failed checks.',
  'Approve only a named local effect.',
];

export function Launch({
  task,
  snapshot,
  workspace,
  onClose,
}: {
  task: Task;
  snapshot: Snapshot;
  workspace: Workspace;
  onClose: () => void;
}) {
  const fixtures = createDemoFixtures();
  const qualified = snapshot.routes.filter(({ qualified }) => qualified);
  const find = (family: string) => qualified.find((route) => route.family === family)?.id;
  const builder = find('anthropic') ?? qualified[0]?.id;
  const reviewer = find('openai');
  const [team, setTeam] = useState<string>('Glide');
  const [section, setSection] = useState<'Team' | 'Policy' | 'Methods'>('Team');
  const [roles, setRoles] = useState<Role[]>(
    builder
      ? [
          {
            role: 'coder',
            routeId: builder,
            pinned: false,
            approvedFallbacks: reviewer ? [reviewer] : [],
          },
        ]
      : [],
  );
  const [policy, setPolicy] = useState<Policy>(() => ({
    ...fixtures.policy,
    authority: 'guided',
    quality: 'quick',
    limits: { ...fixtures.policy.limits, concurrency: 1 },
    effects: fixtures.policy.effects.map((grant) => ({
      ...grant,
      taskId: task.id,
      target: grant.action === 'export-patch' ? task.id : grant.target,
      usesRemaining: 0,
    })),
    reserves: snapshot.routes
      .filter(({ family }) => ['openai', 'anthropic'].includes(family))
      .map((route) => ({
        routeId: route.id,
        windowId: 'weekly',
        value: route.family === 'openai' ? 40 : 5,
        unit: 'percent' as const,
      })),
  }));
  const [methods, setMethods] = useState<Method[]>([]);
  const [reviewGates, setReviewGates] = useState<Record<string, 'ask' | 'once'>>({});
  const [customGates, setCustomGates] = useState(false);
  const [guidance, setGuidance] = useState<Guidance>({
    goal: task.outcome,
    principles: [...principles],
  });
  const [saved, setSaved] = useState(loadTeams);
  const [saveName, setSaveName] = useState('My custom team');
  const [message, setMessage] = useState<string | null>(null);
  const [source, setSource] = useState<Run['source'] | null>(null);
  const [prepared, setPrepared] = useState<Run | null>(
    snapshot.runs.find(({ id }) => id === task.runId) ?? null,
  );
  const requiredMethods: MethodId[] =
    policy.quality === 'quick'
      ? []
      : policy.quality === 'standard'
        ? ['second-opinion', 'keep-it-simple']
        : ['second-opinion', 'keep-it-simple', 'challenge-assumptions'];
  const resolvedMethods = [...methods];
  for (const id of requiredMethods) {
    if (!resolvedMethods.some((method) => method.id === id))
      resolvedMethods.push({
        id,
        cycles: 1,
        reviewerRole: roles.some(({ role }) => role === 'reviewer') ? 'reviewer' : 'advisor',
      });
  }
  const minimumAttempts = 2 + resolvedMethods.reduce((total, method) => total + method.cycles, 0);
  const recoveryAttempts = minimumAttempts + 2;
  const reviewExecutionReady =
    !workspace.preview &&
    workspace.connection === 'connected' &&
    resolvedMethods.every((method) => {
      const assigned = roles.find((role) => role.role === method.reviewerRole);
      return qualified.some((route) => route.id === assigned?.routeId && route.fake);
    });
  useEffect(() => {
    let active = true;
    void workspace
      .command({ command: 'InspectSource', payload: { projectId: task.projectId } })
      .then((result) => {
        if (active && result.data?.kind === 'source') setSource(result.data.source);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [task.projectId, workspace.command]);
  const unavailable = roles.filter(
    (role) =>
      !qualified.some(({ id }) => id === role.routeId) ||
      role.approvedFallbacks.some((fallback) => !qualified.some(({ id }) => id === fallback)),
  );
  const observedWindows = snapshot.usage.flatMap(({ observation }) =>
    observation.remaining
      ? [
          {
            routeId: observation.routeId,
            windowId: observation.windowId,
            unit: observation.remaining.unit,
          },
        ]
      : [],
  );
  const unmappedReserves = policy.reserves.some(
    (reserve) =>
      !qualified.some(({ id }) => id === reserve.routeId) ||
      !observedWindows.some(
        (window) =>
          window.routeId === reserve.routeId &&
          window.windowId === reserve.windowId &&
          window.unit === reserve.unit,
      ),
  );
  const missingReviewer = resolvedMethods.some(
    (method) => !roles.some(({ role }) => role === method.reviewerRole),
  );
  const canPrepare =
    source &&
    roles.some(({ role }) => role === 'coder') &&
    unavailable.length === 0 &&
    !unmappedReserves &&
    !missingReviewer &&
    policy.limits.attempts >= minimumAttempts &&
    (!resolvedMethods.length || reviewExecutionReady);

  function applyBuiltin(name: TeamName) {
    setTeam(name);
    setCustomGates(false);
    setReviewGates({});
    setPrepared(null);
    setMessage(null);
    const selected: Role[] =
      builder && name !== 'Custom'
        ? [
            {
              role: 'coder',
              routeId: builder,
              pinned: false,
              approvedFallbacks: reviewer ? [reviewer] : [],
            },
          ]
        : [];
    if (reviewer && ['Formation', 'Expedition'].includes(name))
      selected.push({ role: 'reviewer', routeId: reviewer, pinned: true, approvedFallbacks: [] });
    const architect = find('google');
    if (architect && name === 'Expedition')
      selected.push({ role: 'lead', routeId: architect, pinned: false, approvedFallbacks: [] });
    setRoles(selected);
    setPolicy((value) => ({
      ...value,
      effects: value.effects.map((grant) => ({ ...grant, usesRemaining: 0 })),
    }));
    setMethods(
      name === 'Formation'
        ? [{ id: 'second-opinion', cycles: 1, reviewerRole: 'reviewer' }]
        : name === 'Expedition'
          ? [
              { id: 'keep-it-simple', cycles: 1, reviewerRole: 'reviewer' },
              { id: 'challenge-assumptions', cycles: 1, reviewerRole: 'reviewer' },
            ]
          : [],
    );
    setPolicy((value) => ({
      ...value,
      quality: name === 'Glide' ? 'quick' : name === 'Expedition' ? 'thorough' : 'standard',
      limits: {
        ...value.limits,
        attempts: name === 'Expedition' ? 7 : name === 'Formation' ? 6 : value.limits.attempts,
      },
    }));
  }
  function changeRole(role: Role['role'], routeId: string | null) {
    setRoles((current) => {
      const existing = current.find((value) => value.role === role);
      return [
        ...current.filter((value) => value.role !== role),
        ...(routeId
          ? [
              {
                role,
                routeId,
                pinned: existing?.pinned ?? false,
                approvedFallbacks: existing?.approvedFallbacks.filter((id) => id !== routeId) ?? [],
              },
            ]
          : []),
      ];
    });
  }
  function applySaved(value: SavedTeam) {
    setTeam(value.name);
    setPrepared(null);
    setMessage(null);
    setRoles(structuredClone(value.roles));
    const plan = value.preferences;
    setCustomGates(true);
    setReviewGates(
      Object.fromEntries(
        value.gates
          .filter((gate) => gate.methodId && gate.cycle)
          .map((gate) => [`${gate.methodId}/cycle-${gate.cycle}`, gate.mode]),
      ),
    );
    setMethods(plan.methods ?? []);
    setGuidance(plan.guidance ?? { goal: task.outcome, principles: [...principles] });
    setPolicy((current) => ({
      ...current,
      ...value.preferences,
      effects: current.effects.map((grant) => ({
        ...grant,
        taskId: task.id,
        target: grant.action === 'export-patch' ? task.id : grant.target,
        usesRemaining:
          value.gates.find(({ action }) => action === grant.action)?.mode === 'once' ? 1 : 0,
      })),
    }));
  }
  function resolvedEffects(expiresAt?: string): Policy['effects'] {
    const project = snapshot.projects.find((project) => project.id === task.projectId);
    const base = policy.effects
      .filter(({ action }) => action !== 'run-review')
      .map((grant) => ({
        ...grant,
        taskId: task.id,
        target:
          grant.action === 'write-scratch'
            ? (project?.name ?? grant.target)
            : grant.action === 'export-patch'
              ? task.id
              : grant.target,
        expiresAt: expiresAt ?? grant.expiresAt,
      }));
    const expiry = expiresAt ?? base[0]?.expiresAt ?? fixtures.policy.effects[0].expiresAt;
    return [
      ...base,
      ...resolvedMethods.flatMap((method) =>
        Array.from({ length: method.cycles }, (_, index) => {
          const target = `${method.id}/cycle-${index + 1}`;
          return {
            action: 'run-review' as const,
            target,
            taskId: task.id,
            expiresAt: expiry,
            revoked: false,
            usesRemaining: reviewGates[target] === 'once' ? (1 as const) : (0 as const),
          };
        }),
      ),
    ];
  }
  function resolvedPolicy(expiresAt?: string): Policy {
    return PolicySchema.parse({
      ...policy,
      effects: resolvedEffects(expiresAt),
      methods: resolvedMethods,
      guidance,
    });
  }
  function applyAuthority(authority: Policy['authority']) {
    setCustomGates(false);
    setReviewGates(
      Object.fromEntries(
        resolvedMethods.flatMap((method) =>
          Array.from({ length: method.cycles }, (_, index) => [
            `${method.id}/cycle-${index + 1}`,
            authority === 'autopilot' ? 'once' : 'ask',
          ]),
        ),
      ),
    );
    setPolicy((value) => ({
      ...value,
      authority,
      effects: value.effects.map((grant) => ({
        ...grant,
        usesRemaining:
          authority !== 'guided' && ['write-scratch', 'run-check'].includes(grant.action) ? 1 : 0,
      })),
    }));
  }
  function save() {
    try {
      setSaved(saveTeam(saveName, roles, snapshot.routes, resolvedPolicy()));
      setTeam(saveName.trim());
      setMessage(
        'Custom team saved for this workspace. Exact grants resolve again on each launch.',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The team could not be saved.');
    }
  }
  async function prepare() {
    if (!canPrepare) return;
    try {
      const result = await workspace.command({
        command: 'PrepareRun',
        expectedRevision: task.revision,
        payload: {
          taskId: task.id,
          policy: resolvedPolicy(new Date(Date.now() + 86_400_000).toISOString()),
          roles,
        },
      });
      const run = RunSchema.safeParse(result.entity);
      if (run.success) setPrepared(run.data);
    } catch {}
  }
  return (
    <Dialog
      title={prepared ? 'Review the prepared run' : 'Configure this run'}
      eyebrow={prepared ? 'FROZEN SOURCE AND POLICY' : 'TEAM, PERMISSIONS AND REVIEW'}
      onClose={onClose}
      wide
    >
      <div className="launch-summary">
        <span>
          <Users size={13} />
          {prepared?.roles.length ?? roles.length} role(s)
        </span>
        <span>
          <ShieldCheck size={13} />
          {
            (prepared?.policy.policy.effects ?? resolvedEffects()).filter(
              ({ usesRemaining }) => usesRemaining === 0,
            ).length
          }{' '}
          manual gates
        </span>
        <span>
          <GitBranch size={13} />
          {(prepared?.policy.policy.methods ?? resolvedMethods).length} method(s)
        </span>
        {workspace.preview && <span className="fake-tag">Interface preview</span>}
      </div>
      {!prepared && (
        <div
          className="setup-tabs"
          role="tablist"
          aria-label="Run configuration"
          onKeyDown={moveTabFocus}
        >
          {(['Team', 'Policy', 'Methods'] as const).map((value) => (
            <button
              type="button"
              role="tab"
              key={value}
              aria-selected={section === value}
              id={`setup-${value}`}
              aria-controls="setup-panel"
              tabIndex={section === value ? 0 : -1}
              className={section === value ? 'active' : ''}
              onClick={() => setSection(value)}
            >
              {value}
            </button>
          ))}
        </div>
      )}
      <div
        className="launch-content"
        id="setup-panel"
        role="tabpanel"
        aria-label={prepared ? 'Prepared run' : undefined}
        aria-labelledby={prepared ? undefined : `setup-${section}`}
      >
        {message && (
          <p className="notice" role="status">
            <Info size={14} />
            {message}
          </p>
        )}
        {prepared ? (
          <>
            <SourceFacts source={prepared.source} />
            <RouterCard run={prepared} routes={snapshot.routes} />
            <section className="card">
              <div className="section-heading">
                <h2>Resolved permissions</h2>
                <span>Frozen for this run</span>
              </div>
              <EffectSummary policy={prepared.policy.policy} />
              {prepared.policy.policy.effects.length > 0 && (
                <p className="muted small">
                  Earliest saved grant expiry:{' '}
                  {new Date(
                    Math.min(
                      ...prepared.policy.policy.effects.map((grant) => Date.parse(grant.expiresAt)),
                    ),
                  ).toLocaleString()}
                  . Expiry stays fixed after preparation.
                </p>
              )}
              <div className="resolved-limits">
                <span>{prepared.policy.policy.limits.attempts} attempts maximum</span>
                <span>{prepared.policy.policy.limits.minutes} min maximum</span>
                <span>{prepared.policy.policy.limits.concurrency} slot cap</span>
              </div>
            </section>
            <div className="launch-warning">
              <ShieldCheck size={17} />
              <p>
                Start uses this exact source, roster and policy. Changes to team preferences apply
                to the next run. Current revocations and consumed grants still apply.
              </p>
            </div>
          </>
        ) : (
          <fieldset disabled={workspace.pending} className="policy-fields">
            {section === 'Team' && (
              <>
                <div className="team-presets">
                  {teamNames.map((name) => (
                    <button
                      type="button"
                      key={name}
                      className={team === name ? 'active' : ''}
                      onClick={() => applyBuiltin(name)}
                    >
                      <strong>
                        {name}
                        {team === name && <Check size={12} />}
                      </strong>
                      <span>
                        {name === 'Glide'
                          ? 'Small change'
                          : name === 'Formation'
                            ? 'Reviewed work'
                            : name === 'Expedition'
                              ? 'Planned work'
                              : 'Build your own'}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="custom-tools">
                  <label>
                    Saved custom team
                    <select
                      aria-label="Saved custom team"
                      value={saved.some(({ name }) => name === team) ? team : ''}
                      onChange={(event) => {
                        const match = saved.find(({ name }) => name === event.target.value);
                        if (match) applySaved(match);
                      }}
                    >
                      <option value="">Choose a saved team</option>
                      {saved.map(({ name }) => (
                        <option key={name}>{name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Save preferences as
                    <input
                      aria-label="Custom team name"
                      value={saveName}
                      maxLength={80}
                      onChange={(event) => setSaveName(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={save}
                    disabled={!saveName.trim()}
                  >
                    <Save size={14} />
                    Save team
                  </button>
                </div>
                <p className="muted small">
                  Templates are editable. Every role is optional. A blank team can be saved; this
                  writing task needs a builder before launch.
                </p>
                {unavailable.length > 0 && (
                  <p className="notice">
                    <Info size={14} />A saved route or fallback is unavailable. Choose its
                    replacement explicitly before resolving the run.
                  </p>
                )}
                <div className="assignment-grid">
                  {roleNames.map((role) => {
                    const assignment = roles.find((value) => value.role === role);
                    const route = qualified.find(({ id }) => id === assignment?.routeId);
                    const candidates = qualified.filter((value) => value.family === route?.family);
                    const models = [...new Set(candidates.map(({ model }) => model))];
                    const efforts = candidates.filter((value) => value.model === route?.model);
                    return (
                      <section
                        className={`assignment-card ${assignment ? 'enabled' : ''}`}
                        key={role}
                      >
                        <div className="assignment-title">
                          <label className="assignment-toggle">
                            <input
                              type="checkbox"
                              checked={!!assignment}
                              onChange={(event) =>
                                changeRole(
                                  role,
                                  event.target.checked ? (qualified[0]?.id ?? null) : null,
                                )
                              }
                            />
                            {roleLabels[role]}
                          </label>
                          <span>{assignment ? 'Configured' : 'Optional'}</span>
                        </div>
                        {assignment ? (
                          <>
                            <div className="catalog-pickers">
                              <label>
                                Provider
                                <select
                                  aria-label={`${roleLabels[role]} provider`}
                                  value={route?.family ?? ''}
                                  onChange={(event) => {
                                    const next = qualified.find(
                                      (value) => value.family === event.target.value,
                                    );
                                    if (next) changeRole(role, next.id);
                                  }}
                                >
                                  {!route && <option value="">Map unavailable route</option>}
                                  {[...new Set(qualified.map(({ family }) => family))].map(
                                    (family) => (
                                      <option key={family} value={family}>
                                        {familyName(family)}
                                      </option>
                                    ),
                                  )}
                                </select>
                              </label>
                              <label>
                                Model
                                <select
                                  aria-label={`${roleLabels[role]} model`}
                                  value={route?.model ?? ''}
                                  disabled={!route}
                                  onChange={(event) => {
                                    const next = candidates.find(
                                      ({ model }) => model === event.target.value,
                                    );
                                    if (next) changeRole(role, next.id);
                                  }}
                                >
                                  {models.map((model) => (
                                    <option key={model}>{model}</option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                Requested effort
                                <select
                                  aria-label={`${roleLabels[role]} requested effort`}
                                  value={route?.id ?? ''}
                                  disabled={!route}
                                  onChange={(event) => changeRole(role, event.target.value)}
                                >
                                  {efforts.map((value) => (
                                    <option value={value.id} key={value.id}>
                                      {value.effort.requested}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <div className="effective-effort">
                                <span>Effective effort</span>
                                <strong>{route?.effort.effective ?? 'Unavailable'}</strong>
                              </div>
                            </div>
                            <div className="assignment-options">
                              <label className="checkbox-label">
                                <input
                                  type="checkbox"
                                  checked={assignment.pinned}
                                  onChange={(event) =>
                                    setRoles((current) =>
                                      current.map((value) =>
                                        value.role === role
                                          ? { ...value, pinned: event.target.checked }
                                          : value,
                                      ),
                                    )
                                  }
                                />
                                <Pin size={11} />
                                Pin route
                              </label>
                              <span>1 useful slot maximum</span>
                            </div>
                            <details className="fallback-details">
                              <summary>
                                {assignment.approvedFallbacks.length} approved fallback(s)
                                <ChevronRight size={12} />
                              </summary>
                              <div>
                                {qualified
                                  .filter(({ id }) => id !== assignment.routeId)
                                  .map((value) => (
                                    <label className="checkbox-label" key={value.id}>
                                      <input
                                        type="checkbox"
                                        checked={assignment.approvedFallbacks.includes(value.id)}
                                        onChange={(event) =>
                                          setRoles((current) =>
                                            current.map((entry) =>
                                              entry.role === role
                                                ? {
                                                    ...entry,
                                                    approvedFallbacks: event.target.checked
                                                      ? [...entry.approvedFallbacks, value.id]
                                                      : entry.approvedFallbacks.filter(
                                                          (id) => id !== value.id,
                                                        ),
                                                  }
                                                : entry,
                                            ),
                                          )
                                        }
                                      />
                                      {familyName(value.family)} · {value.model}
                                    </label>
                                  ))}
                                {assignment.approvedFallbacks
                                  .filter((id) => !qualified.some((value) => value.id === id))
                                  .map((id) => (
                                    <label className="checkbox-label" key={id}>
                                      <input
                                        type="checkbox"
                                        checked
                                        onChange={() =>
                                          setRoles((current) =>
                                            current.map((entry) =>
                                              entry.role === role
                                                ? {
                                                    ...entry,
                                                    approvedFallbacks:
                                                      entry.approvedFallbacks.filter(
                                                        (value) => value !== id,
                                                      ),
                                                  }
                                                : entry,
                                            ),
                                          )
                                        }
                                      />
                                      Unavailable fallback: remove or map it above
                                    </label>
                                  ))}
                              </div>
                            </details>
                          </>
                        ) : (
                          <p className="muted small">Add this role only when the task needs it.</p>
                        )}
                      </section>
                    );
                  })}
                </div>
                <p className="muted small">
                  D0 uses a finite fake catalog and one writer per task. Slot caps limit concurrent
                  useful work; they never create work to fill a quota.
                </p>
              </>
            )}
            {section === 'Policy' && (
              <>
                <section className="card">
                  <div className="section-heading">
                    <h2>
                      <ShieldCheck size={15} />
                      Concrete gates
                    </h2>
                    <span>
                      {customGates ? 'Custom gates' : 'Preset gates'} · Quality is independent
                    </span>
                  </div>
                  <div className="policy-grid">
                    <label>
                      Authority profile
                      <select
                        value={policy.authority}
                        onChange={(event) =>
                          applyAuthority(event.target.value as Policy['authority'])
                        }
                      >
                        <option value="guided">Guided</option>
                        <option value="balanced">Balanced</option>
                        <option value="autopilot">Autopilot</option>
                      </select>
                    </label>
                    <label>
                      Quality profile
                      <select
                        value={policy.quality}
                        onChange={(event) =>
                          setPolicy({ ...policy, quality: event.target.value as Policy['quality'] })
                        }
                      >
                        <option value="quick">Quick</option>
                        <option value="standard">Standard</option>
                        <option value="thorough">Thorough</option>
                      </select>
                    </label>
                  </div>
                  <p className="muted small">
                    Guided defaults to manual approval. Balanced allows scratch writes and checks
                    once. Autopilot also allows bounded review dispatch. Acceptance and export stay
                    manual until explicitly changed.
                  </p>
                  <div className="effect-list">
                    {resolvedEffects().map((grant) => (
                      <div key={`${grant.action}-${grant.target}`}>
                        <div>
                          <strong>
                            {grant.action === 'write-scratch'
                              ? 'Write the scratch copy'
                              : grant.action === 'run-check'
                                ? 'Run candidate checks'
                                : grant.action === 'accept-candidate'
                                  ? 'Create the named local branch'
                                  : grant.action === 'export-patch'
                                    ? 'Export the retained patch'
                                    : grant.action}
                          </strong>
                          <code>{grant.target}</code>
                        </div>
                        <select
                          aria-label={`${grant.action} ${grant.target} approval gate`}
                          value={grant.usesRemaining === 1 ? 'once' : 'ask'}
                          onChange={(event) => {
                            setCustomGates(true);
                            if (grant.action === 'run-review') {
                              setReviewGates((current) => ({
                                ...current,
                                [grant.target]: event.target.value as 'ask' | 'once',
                              }));
                            } else
                              setPolicy({
                                ...policy,
                                effects: policy.effects.map((value) =>
                                  value.action === grant.action
                                    ? {
                                        ...value,
                                        usesRemaining: event.target.value === 'once' ? 1 : 0,
                                      }
                                    : value,
                                ),
                              });
                          }}
                        >
                          <option value="ask">Manual approval</option>
                          <option value="once">Automatic, once</option>
                        </select>
                      </div>
                    ))}
                  </div>
                  <p className="muted small">
                    An automatic gate grants one named effect for this task and target. It expires
                    and cannot widen itself. Editing a gate creates custom settings.
                  </p>
                </section>
                <section className="card">
                  <div className="section-heading">
                    <h2>Allowance reserves</h2>
                    <span>Provider units</span>
                  </div>
                  <p className="muted small">
                    Saved reserves need an exact route, window and unit match. Choose a new mapping
                    when a workspace catalog changes.
                  </p>
                  <div className="reserve-controls">
                    {policy.reserves.map((reserve) => {
                      const mapped = observedWindows.some(
                        (window) =>
                          window.routeId === reserve.routeId &&
                          window.windowId === reserve.windowId &&
                          window.unit === reserve.unit,
                      );
                      const identity = `${reserve.routeId}/${reserve.windowId}/${reserve.unit}`;
                      return (
                        <div key={identity}>
                          <label>
                            Observed route and window
                            <select
                              aria-label={`Reserve mapping ${reserve.windowId}`}
                              value={mapped ? identity : ''}
                              onChange={(event) => {
                                const window = observedWindows.find(
                                  (value) =>
                                    `${value.routeId}/${value.windowId}/${value.unit}` ===
                                    event.target.value,
                                );
                                if (window)
                                  setPolicy({
                                    ...policy,
                                    reserves: policy.reserves.map((value) =>
                                      value === reserve ? { ...value, ...window } : value,
                                    ),
                                  });
                              }}
                            >
                              {!mapped && <option value="">Map unavailable reserve</option>}
                              {observedWindows.map((window) => (
                                <option
                                  value={`${window.routeId}/${window.windowId}/${window.unit}`}
                                  key={`${window.routeId}/${window.windowId}/${window.unit}`}
                                >
                                  {familyName(
                                    qualified.find(({ id }) => id === window.routeId)?.family ??
                                      'Unavailable',
                                  )}{' '}
                                  · {window.windowId} · {window.unit}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Reserve ({reserve.unit})
                            <input
                              type="number"
                              min="0"
                              max={reserve.unit === 'percent' ? 100 : undefined}
                              value={reserve.value}
                              onChange={(event) =>
                                setPolicy({
                                  ...policy,
                                  reserves: policy.reserves.map((value) =>
                                    value === reserve
                                      ? { ...value, value: Number(event.target.value) }
                                      : value,
                                  ),
                                })
                              }
                            />
                          </label>
                        </div>
                      );
                    })}
                  </div>
                  {unmappedReserves && (
                    <p className="notice">
                      <Info size={14} />
                      Map every saved reserve explicitly before resolving. A missing window cannot
                      be assumed empty.
                    </p>
                  )}
                </section>
                <section className="card">
                  <div className="section-heading">
                    <h2>Hard limits</h2>
                    <span>Maximums, not targets</span>
                  </div>
                  <div className="policy-grid">
                    <label>
                      Attempts
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={policy.limits.attempts}
                        onChange={(event) =>
                          setPolicy({
                            ...policy,
                            limits: { ...policy.limits, attempts: Number(event.target.value) },
                          })
                        }
                      />
                    </label>
                    <label>
                      Minutes
                      <input
                        type="number"
                        min={1}
                        max={1440}
                        value={policy.limits.minutes}
                        onChange={(event) =>
                          setPolicy({
                            ...policy,
                            limits: { ...policy.limits, minutes: Number(event.target.value) },
                          })
                        }
                      />
                    </label>
                    <label>
                      Writer concurrency
                      <input type="number" value={1} disabled />
                    </label>
                    <label>
                      Unknown usage
                      <select
                        value={policy.unknownUsage.rule}
                        onChange={(event) =>
                          setPolicy({
                            ...policy,
                            unknownUsage:
                              event.target.value === 'waiting'
                                ? { rule: 'waiting' }
                                : event.target.value === 'manual'
                                  ? {
                                      rule: 'manual',
                                      approvedRouteIds: roles.flatMap(
                                        ({ routeId, approvedFallbacks }) => [
                                          routeId,
                                          ...approvedFallbacks,
                                        ],
                                      ),
                                    }
                                  : {
                                      rule: 'fixed-allowance',
                                      allowance: { launches: 1, minutes: 5 },
                                    },
                          })
                        }
                      >
                        <option value="waiting">Wait for fresh observations</option>
                        <option value="fixed-allowance">One launch, five minutes</option>
                        <option value="manual">Named roster routes only</option>
                      </select>
                    </label>
                  </div>
                  <p className="muted small">
                    Source preservation and failed-check blocking are controller-enforced
                    boundaries.
                  </p>
                </section>
                <section className="card guidance-card">
                  <div className="section-heading">
                    <h2>Goal and working principles</h2>
                    <span>Advisory guidance</span>
                  </div>
                  <label>
                    Goal
                    <textarea
                      rows={2}
                      maxLength={4096}
                      value={guidance.goal}
                      onChange={(event) => setGuidance({ ...guidance, goal: event.target.value })}
                    />
                  </label>
                  <div className="principle-list">
                    {principles.map((principle) => (
                      <label className="checkbox-label" key={principle}>
                        <input
                          type="checkbox"
                          checked={guidance.principles.includes(principle)}
                          onChange={(event) =>
                            setGuidance({
                              ...guidance,
                              principles: event.target.checked
                                ? [...guidance.principles, principle]
                                : guidance.principles.filter((value) => value !== principle),
                            })
                          }
                        />
                        {principle}
                      </label>
                    ))}
                  </div>
                  <p className="muted small">
                    Guidance can shape a plan and its review criteria. Its prose grants no
                    permission. Dependency/configuration review is advisory until a recorded review
                    enforces it.
                  </p>
                </section>
              </>
            )}
            {section === 'Methods' && (
              <>
                <div className="method-intro">
                  <span className="scripted-badge">
                    <Circle size={8} />
                    Scripted D0 evaluation
                  </span>
                  <h3>Choose only the review this task needs</h3>
                  <p>
                    Each enabled method names a reviewer role and a finite cycle cap. Its jobs share
                    the run's limits and inspect a read-only candidate copy.
                  </p>
                </div>
                <div className="method-grid">
                  {methodCatalog.map((method) => {
                    const selected = resolvedMethods.find(({ id }) => id === method.id);
                    const required = requiredMethods.includes(method.id);
                    const reviewerRole = roles.find(({ role }) => role === selected?.reviewerRole);
                    const route = qualified.find(({ id }) => id === reviewerRole?.routeId);
                    return (
                      <section
                        className={`method-card ${selected ? 'enabled' : ''}`}
                        key={method.id}
                      >
                        <label className="method-toggle">
                          <input
                            type="checkbox"
                            checked={!!selected}
                            disabled={required}
                            onChange={(event) =>
                              setMethods((current) =>
                                event.target.checked
                                  ? [
                                      ...current,
                                      { id: method.id, cycles: 1, reviewerRole: 'reviewer' },
                                    ]
                                  : current.filter(({ id }) => id !== method.id),
                              )
                            }
                          />
                          <strong>{method.name}</strong>
                          {required && <span className="fake-tag">Required by quality</span>}
                        </label>
                        <p>{method.description}</p>
                        <span className="method-credit">Method influence: {method.credit}</span>
                        {selected && (
                          <>
                            <div className="method-controls">
                              <label>
                                Cycle cap
                                <select
                                  value={selected.cycles}
                                  onChange={(event) =>
                                    setMethods(
                                      resolvedMethods.map((value) =>
                                        value.id === method.id
                                          ? { ...value, cycles: Number(event.target.value) }
                                          : value,
                                      ),
                                    )
                                  }
                                >
                                  {[1, 2, 3].map((count) => (
                                    <option key={count} value={count}>
                                      {count} cycle{count === 1 ? '' : 's'}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                Reviewer role
                                <select
                                  value={selected.reviewerRole}
                                  onChange={(event) =>
                                    setMethods(
                                      resolvedMethods.map((value) =>
                                        value.id === method.id
                                          ? {
                                              ...value,
                                              reviewerRole: event.target.value as
                                                | 'reviewer'
                                                | 'advisor',
                                            }
                                          : value,
                                      ),
                                    )
                                  }
                                >
                                  <option value="reviewer">Reviewer</option>
                                  <option value="advisor">Advisor</option>
                                </select>
                              </label>
                            </div>
                            <p className={route ? 'method-route' : 'method-blocker'}>
                              {route
                                ? `${familyName(route.family)} · ${route.model} · ${route.effort.effective} effort`
                                : 'Assign this reviewer role in Team before resolving.'}
                            </p>
                          </>
                        )}
                      </section>
                    );
                  })}
                </div>
                {resolvedMethods.length > 0 && !reviewExecutionReady && (
                  <p className="notice">
                    <Info size={14} />
                    Selected methods require a connected controller and an assigned qualified fake
                    review route. Preview does not execute reviews.
                  </p>
                )}
              </>
            )}
          </fieldset>
        )}
        {!prepared && !roles.some(({ role }) => role === 'coder') && (
          <p className="notice">
            <Info size={14} />
            This task needs a builder. Other roles remain optional.
          </p>
        )}
        {!prepared && policy.limits.attempts < minimumAttempts && (
          <p className="notice">
            <Info size={14} />
            This plan needs at least {minimumAttempts} attempts for one writer, declared checks and{' '}
            {minimumAttempts - 2} scripted review cycle(s). A handoff needs another writer attempt.
          </p>
        )}
        {!prepared &&
          policy.limits.attempts >= minimumAttempts &&
          policy.limits.attempts < recoveryAttempts && (
            <p className="notice">
              <Info size={14} />
              The scripted handoff and restart walkthrough needs {recoveryAttempts} attempts,
              including all selected review cycles. Raise the visible limit before preparing that
              walkthrough.
            </p>
          )}
        {!prepared && missingReviewer && (
          <p className="notice">
            <Info size={14} />
            An enabled method needs its selected reviewer role assigned.
          </p>
        )}
      </div>
      <div className="dialog-footer">
        <button type="button" className="button secondary" onClick={onClose}>
          Cancel
        </button>
        {prepared ? (
          <button
            type="button"
            className="button primary"
            disabled={workspace.pending || !prepared.decision.chosen}
            onClick={() =>
              void workspace
                .command({
                  command: 'StartRun',
                  expectedRevision: task.revision,
                  payload: { taskId: task.id, runId: prepared.id },
                })
                .then((result) => {
                  if (result.outcome === 'applied') onClose();
                })
                .catch(() => {})
            }
          >
            Start run
            <ArrowRight size={14} />
          </button>
        ) : (
          <>
            <span className="muted small">
              Source, routes and permissions resolve before launch.
            </span>
            <button
              type="button"
              className="button primary"
              disabled={workspace.pending || !canPrepare}
              onClick={() => void prepare()}
            >
              Resolve and review
              <ArrowRight size={14} />
            </button>
          </>
        )}
      </div>
    </Dialog>
  );
}

function EffectSummary({ policy }: { policy: Policy }) {
  return (
    <div className="effect-summary">
      {policy.effects.map((grant) => (
        <div key={`${grant.action}-${grant.target}`}>
          <span>
            {grant.usesRemaining === 1 ? <Check size={13} /> : <ShieldCheck size={13} />}
            {grant.action}
          </span>
          <code>{grant.target}</code>
          <strong>{grant.usesRemaining === 1 ? 'Automatic, once' : 'Manual approval'}</strong>
        </div>
      ))}
    </div>
  );
}
