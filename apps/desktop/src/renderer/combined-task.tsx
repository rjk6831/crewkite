import {
  type CombinedRunPreview,
  CombinedWriterSelectionSchema,
  type CommandResult,
  NativeTargetPathSchema,
  PrepareCombinedRunPayloadSchema,
  ProjectNodeTestFilesSchema,
  type Run,
  type Snapshot,
  type Task,
} from '@crewkite/contracts';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Fact, familyName, SourceFacts } from './components.tsx';
import type { DesktopCommand } from './source.ts';

export type CombinedTaskCommand = Extract<
  DesktopCommand,
  {
    command: 'PrepareCombinedRun' | 'StartRun' | 'AssembleCombinedCandidate';
  }
>;
export type CombinedTaskProps = {
  task: Task | null;
  snapshot: Snapshot;
  source: Run['source'] | null;
  connected: boolean;
  pending: boolean;
  retryAvailable: boolean;
  error?: string | null;
  onCommand: (command: CombinedTaskCommand) => Promise<CommandResult>;
  onRetry?: () => Promise<CommandResult | null>;
  onRefreshSource?: () => Promise<void> | void;
  onInspect?: (panel: 'changes' | 'evaluation' | 'activity') => void;
  onSelectTask?: (taskId: Task['id']) => void;
};

type ChildDraft = {
  taskId: string;
  path: string;
  profileId: string;
  maximumMinutes: string;
  credits: boolean;
  subscription: boolean;
  extrasDisabled: boolean;
  quotaAccount: boolean;
  modelId: string;
  thoughtLevelId: string;
};
const emptyChild = (): ChildDraft => ({
  taskId: '',
  path: '',
  profileId: '',
  maximumMinutes: '5',
  credits: false,
  subscription: false,
  extrasDisabled: false,
  quotaAccount: false,
  modelId: '',
  thoughtLevelId: '',
});
const emptyConsents = () => ({
  writers: [false, false] as [boolean, boolean],
  baseline: false,
  replays: [false, false] as [boolean, boolean],
});
const paths = (text: string) => text.split(/\r?\n/u).filter((path) => path.length > 0);
const applied = (outcome: string) => outcome === 'applied' || outcome === 'already-applied';
const writerProfile = (snapshot: Snapshot, id: string) =>
  snapshot.nativeProfiles.find(
    (profile) =>
      profile.id === id &&
      ['openai-file-v1', 'anthropic-file-v1', 'google-acp-v1'].includes(profile.id),
  );
const reasons: Record<NonNullable<CombinedRunPreview['blocker']>, string> = {
  available: 'Available',
  'already-started': 'Already started',
  'baseline-required': 'Baseline required',
  'writers-incomplete': 'Both writers must finish',
  'checks-required': 'Checks required',
  'checks-failed': 'Checks failed',
  'review-required': 'Review required',
  'review-failed': 'Review failed',
  'budget-exhausted': 'Budget exhausted',
  paused: 'Admissions paused',
  'owner-active': 'An owner is active',
  'ownership-unknown': 'Ownership unknown',
  'source-changed': 'Source changed',
  'task-changed': 'Task changed',
  'preparation-changed': 'Preparation changed',
  'scope-changed': 'Scope changed',
  'profile-unavailable': 'Profile unavailable',
  'authority-unavailable': 'Permission unavailable',
  'ref-changed': 'Integration reference changed',
  stopped: 'Stopped',
  accepted: 'Accepted',
};
const phases: Record<CombinedRunPreview['phase'], string> = {
  prepared: 'Prepared',
  baseline: 'Running baseline',
  writers: 'Writer phase',
  assembling: 'Assembling',
  'awaiting-evaluation': 'Awaiting evaluation',
  checking: 'Running final checks',
  'awaiting-review': 'Awaiting review',
  reviewing: 'Running review',
  ready: 'Ready',
  paused: 'Paused',
  stopping: 'Stopping',
  stopped: 'Stopped',
  blocked: 'Blocked',
  unknown: 'Unknown',
  accepted: 'Accepted',
};
const dispatchLabels: Record<CombinedRunPreview['dispatches'][number]['phase'], string> = {
  baseline: 'Baseline',
  'writer-0': 'Writer 1',
  'writer-1': 'Writer 2',
  'replay-0': 'Replay 1',
  'replay-1': 'Replay 2',
  'final-check': 'Final checks',
  review: 'Independent review',
};
function draftExclusions(snapshot: Snapshot) {
  const excluded = new Set<string>(
    snapshot.approvals
      .filter((approval) => approval.status === 'pending')
      .map((approval) => approval.taskId),
  );
  for (const group of snapshot.combinedRuns) {
    excluded.add(group.taskId);
    for (const member of group.members) excluded.add(member.taskId);
  }
  const activeRuns = new Set(
    snapshot.attempts
      .filter((attempt) => ['intent', 'running', 'stopping', 'unknown'].includes(attempt.state))
      .map((attempt) => attempt.runId),
  );
  for (const run of snapshot.runs) if (activeRuns.has(run.id)) excluded.add(run.taskId);
  return excluded;
}
function isDraft(task: Task, excluded: Set<string>) {
  return task.state === 'draft' && !excluded.has(task.id);
}
function writerSelection(draft: ChildDraft, snapshot: Snapshot) {
  const profile = writerProfile(snapshot, draft.profileId);
  const acp = profile?.family === 'google' && 'configOptions' in profile ? profile : null;
  return CombinedWriterSelectionSchema.safeParse(
    draft.profileId === 'openai-file-v1'
      ? {
          profileId: draft.profileId,
          creditPolicy: draft.credits ? 'existing-credits' : 'ordinary',
        }
      : draft.profileId === 'anthropic-file-v1'
        ? {
            profileId: draft.profileId,
            creditPolicy: 'ordinary',
            billingAttestation: {
              source: 'user-attested',
              subscriptionLoginConfirmed: draft.subscription,
              paidExtraUsageDisabled: draft.extrasDisabled,
            },
          }
        : draft.profileId === 'google-acp-v1'
          ? {
              profileId: draft.profileId,
              creditPolicy: 'ordinary',
              billingAttestation: {
                source: 'user-attested',
                subscriptionLoginConfirmed: draft.subscription,
                paidExtraUsageDisabled: draft.extrasDisabled,
                quotaAccountConfirmed: draft.quotaAccount,
              },
              permissionMode: 'request-review',
              proofId: snapshot.googleAcpSetup?.proofId,
              modelId: draft.modelId || acp?.configOptions?.model.currentValue,
              thoughtLevelId: acp?.configOptions?.thoughtLevel
                ? draft.thoughtLevelId || acp.configOptions.thoughtLevel.currentValue
                : null,
            }
          : null,
  );
}

function WriterFields({
  value,
  snapshot,
  disabled,
  onChange,
}: {
  value: ChildDraft;
  snapshot: Snapshot;
  disabled: boolean;
  onChange: (value: ChildDraft) => void;
}) {
  const profile = writerProfile(snapshot, value.profileId);
  const acp = profile?.family === 'google' && 'configOptions' in profile ? profile : null;
  const profiles = snapshot.nativeProfiles.filter((candidate) =>
    ['openai-file-v1', 'anthropic-file-v1', 'google-acp-v1'].includes(candidate.id),
  );
  return (
    <>
      <label>
        Writer profile
        <select
          value={value.profileId}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...value,
              profileId: event.target.value,
              credits: false,
              subscription: false,
              extrasDisabled: false,
              quotaAccount: false,
              modelId: '',
              thoughtLevelId: '',
            })
          }
        >
          <option value="">Choose a writer</option>
          {profiles.map((candidate) => (
            <option key={candidate.id} value={candidate.id} disabled={!candidate.available}>
              {candidate.displayName}
              {candidate.available ? '' : ' (unavailable)'}
            </option>
          ))}
        </select>
      </label>
      {profile && (
        <p className="muted small">
          {familyName(profile.family)} · {profile.model} ·{' '}
          {profile.qualifiedAt
            ? `Profile qualified ${profile.qualifiedAt}`
            : 'Qualification pending'}
          . {profile.available ? 'Profile available.' : `Profile unavailable: ${profile.reason}.`}
        </p>
      )}
      {profile?.family === 'openai' && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={value.credits}
            disabled={disabled || !profile.creditPolicies.includes('existing-credits')}
            onChange={(event) => onChange({ ...value, credits: event.target.checked })}
          />
          Allow existing credits for this writer
        </label>
      )}
      {(profile?.family === 'anthropic' || acp) && (
        <>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={value.subscription}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, subscription: event.target.checked })}
            />
            I confirm this writer uses my existing subscription login
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={value.extrasDisabled}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, extrasDisabled: event.target.checked })}
            />
            I confirm paid extra usage is disabled for this login
          </label>
        </>
      )}
      {acp && (
        <>
          <label>
            Google model
            <select
              value={value.modelId || acp.configOptions?.model.currentValue || ''}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, modelId: event.target.value })}
            >
              {acp.configOptions?.model.supported.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          {acp.configOptions?.thoughtLevel && (
            <label>
              Google thought level
              <select
                value={value.thoughtLevelId || acp.configOptions.thoughtLevel.currentValue}
                disabled={disabled}
                onChange={(event) => onChange({ ...value, thoughtLevelId: event.target.value })}
              >
                {acp.configOptions.thoughtLevel.supported.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="muted small">
            Request permission. Missing thought-level metadata stays unknown.
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={value.quotaAccount}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, quotaAccount: event.target.checked })}
            />
            I confirm quota reads and writer sign-in use the same Google account
          </label>
        </>
      )}
    </>
  );
}

export function CombinedTask({
  task,
  snapshot,
  source,
  connected,
  pending,
  retryAvailable,
  error,
  onCommand,
  onRetry,
  onRefreshSource,
  onInspect,
  onSelectTask,
}: CombinedTaskProps) {
  const [children, setChildren] = useState<[ChildDraft, ChildDraft]>([emptyChild(), emptyChild()]);
  const [authority, setAuthority] = useState<'guided' | 'balanced'>('guided');
  const [attempts, setAttempts] = useState('7');
  const [minutes, setMinutes] = useState('20');
  const [concurrency, setConcurrency] = useState('2');
  const [reviewerId, setReviewerId] = useState('');
  const [reviewerMinutes, setReviewerMinutes] = useState('5');
  const [reviewerCredits, setReviewerCredits] = useState(false);
  const [fullTests, setFullTests] = useState('');
  const [firstTests, setFirstTests] = useState('');
  const [secondTests, setSecondTests] = useState('');
  const [interactionTests, setInteractionTests] = useState('');
  const [consents, setConsents] = useState(emptyConsents);
  const [acknowledgedScope, setAcknowledgedScope] = useState('');
  const [requested, setRequested] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const retrySeen = useRef(retryAvailable);
  useEffect(() => {
    if (retryAvailable) retrySeen.current = true;
    else if (retrySeen.current && !pending) {
      retrySeen.current = false;
      setUncertain(false);
    }
  }, [retryAvailable, pending]);
  const titleId = useId(),
    formId = useId(),
    validationId = useId();
  const memberOf = snapshot.combinedRuns.find((group) =>
    group.members.some((member) => member.taskId === task?.id),
  );
  const preview = snapshot.combinedRuns.find(
    (group) => group.taskId === task?.id && group.runId === task.runId,
  );
  const currentTask = snapshot.tasks.find((value) => value.id === task?.id);
  const project = snapshot.projects.find((value) => value.id === task?.projectId);
  const actualSource = source?.projectId === task?.projectId ? source : null;
  const excludedDrafts = draftExclusions(snapshot);
  const drafts = snapshot.tasks.filter(
    (value) =>
      value.projectId === task?.projectId && value.id !== task.id && isDraft(value, excludedDrafts),
  );
  const childTasks = children.map((child) => drafts.find((value) => value.id === child.taskId));
  const reviewer = snapshot.nativeProfiles.find(
    (profile): profile is Extract<Snapshot['nativeProfiles'][number], { family: 'openai' }> =>
      profile.id === reviewerId && profile.id === 'openai-file-v1' && profile.family === 'openai',
  );
  const writerSelections = children.map((child) => writerSelection(child, snapshot));
  const scopeSignature = JSON.stringify({
    parent: task,
    source: actualSource,
    children,
    childTasks,
    authority,
    attempts,
    minutes,
    concurrency,
    reviewerId,
    reviewerMinutes,
    reviewerCredits,
    fullTests,
    firstTests,
    secondTests,
    interactionTests,
    profiles: snapshot.nativeProfiles,
    acp: snapshot.googleAcpSetup,
  });
  useEffect(() => {
    if (scopeSignature !== acknowledgedScope) {
      setAcknowledgedScope(scopeSignature);
      setConsents(emptyConsents());
    }
  }, [scopeSignature, acknowledgedScope]);
  const busy = pending || requested !== null;
  const currentSelection =
    task && currentTask?.revision === task.revision && currentTask.runId === task.runId;
  const blocked =
    !connected || busy || retryAvailable || uncertain || Boolean(task && !currentSelection);
  const payload = PrepareCombinedRunPayloadSchema.safeParse({
    taskId: task?.id,
    policy: {
      authority,
      quality: 'quick',
      methods: [{ id: 'keep-it-simple', cycles: 1, reviewerRole: 'reviewer' }],
      limits: {
        attempts: Number(attempts),
        minutes: Number(minutes),
        concurrency: Number(concurrency),
      },
      reserves: [],
      unknownUsage: {
        rule: 'fixed-allowance',
        allowance: { launches: 7, minutes: Number(minutes) },
      },
      effects: children.map((child) => ({
        taskId: child.taskId,
        action: 'write-scratch',
        target: project?.name,
        usesRemaining: 1,
        revoked: false,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      })),
    },
    children: children.map((child, index) => ({
      taskId: child.taskId,
      expectedRevision: childTasks[index]?.revision,
      scope: [child.path],
      writer: writerSelections[index]?.success ? writerSelections[index].data : null,
      consent: 'explicit',
      maximumMinutes: Number(child.maximumMinutes),
    })),
    checks: {
      recipeId: 'project-node-tests-v1',
      testFiles: paths(fullTests),
      replayTestFiles: [paths(firstTests), paths(secondTests)],
      interactionTestFiles: paths(interactionTests),
      maximumMinutes: 1,
      baselineConsent: 'explicit',
      replayConsents: ['explicit', 'explicit'],
    },
    reviewer: {
      profileId: reviewerId,
      creditPolicy: reviewerCredits ? 'existing-credits' : 'ordinary',
      maximumMinutes: Number(reviewerMinutes),
    },
  });
  const writersAvailable = children.every((child) => {
    const profile = writerProfile(snapshot, child.profileId);
    if (!profile?.available) return false;
    if (profile.family !== 'google') return true;
    if (
      !('configOptions' in profile) ||
      !profile.configOptions ||
      snapshot.googleAcpSetup?.state !== 'ready'
    )
      return false;
    return (
      profile.configOptions.model.supported.includes(
        child.modelId || profile.configOptions.model.currentValue,
      ) &&
      (!profile.configOptions.thoughtLevel ||
        profile.configOptions.thoughtLevel.supported.includes(
          child.thoughtLevelId || profile.configOptions.thoughtLevel.currentValue,
        ))
    );
  });
  const confirmed =
    acknowledgedScope === scopeSignature &&
    consents.writers.every(Boolean) &&
    consents.baseline &&
    consents.replays.every(Boolean);
  const canPrepare =
    !blocked &&
    task &&
    currentTask?.revision === task.revision &&
    isDraft(currentTask, excludedDrafts) &&
    actualSource &&
    childTasks.every(Boolean) &&
    writersAvailable &&
    reviewer?.available &&
    confirmed &&
    payload.success;
  const validation = !task
    ? 'Choose a parent task.'
    : !currentSelection
      ? 'The parent task changed. Refresh its current state before preparing.'
      : !currentTask || !isDraft(currentTask, excludedDrafts)
        ? 'The parent needs a draft without pending approvals, combined membership or an active or unknown owner.'
        : !actualSource
          ? 'Inspect the current project source before preparing.'
          : !childTasks.every(Boolean)
            ? 'Select two draft child tasks without pending approvals, combined membership or an active or unknown owner.'
            : !writersAvailable || !reviewer?.available
              ? 'Choose available writer and reviewer profiles.'
              : !payload.success
                ? 'Use two disjoint exact targets, finite limits and valid full, replay and interaction test collections.'
                : !confirmed
                  ? 'Confirm both writer scopes and each baseline/replay check permission.'
                  : 'Prepare rechecks committed files, task revisions, ownership and permissions.';
  function updateChild(index: 0 | 1, value: ChildDraft) {
    setChildren((current) => (index === 0 ? [value, current[1]] : [current[0], value]));
  }
  async function command(name: string, input: CombinedTaskCommand) {
    if (blocked) return;
    setRequested(name);
    setMessage(null);
    try {
      const result = await onCommand(input);
      if (applied(result.outcome))
        setMessage(`${name} requested. Inspect the current controller state.`);
      else {
        setMessage(result.next ?? result.reason ?? `${name} was not confirmed.`);
        if (result.outcome === 'outcome-unknown') setUncertain(true);
      }
    } catch {
      setMessage(`${name} could not be confirmed. Use exact retry if available.`);
      setUncertain(true);
    } finally {
      setRequested(null);
    }
  }
  function prepare(event: FormEvent) {
    event.preventDefault();
    if (canPrepare && payload.success && task)
      void command('Combined preparation', {
        command: 'PrepareCombinedRun',
        expectedRevision: task.revision,
        payload: payload.data,
      });
  }
  function start(taskId: string, runId: string, available: boolean) {
    const current = snapshot.tasks.find((value) => value.id === taskId && value.runId === runId);
    if (!current || !available || !preview) return;
    void command(taskId === preview.taskId ? 'Baseline start' : 'Writer start', {
      command: 'StartRun',
      expectedRevision: current.revision,
      payload: { taskId, runId },
    });
  }
  async function retry() {
    if (!onRetry || !connected || busy) return;
    setRequested('Exact retry');
    try {
      const result = await onRetry();
      if (result && result.outcome !== 'outcome-unknown') {
        setUncertain(false);
        setMessage(
          applied(result.outcome)
            ? 'Exact command confirmed. Inspect the current controller state.'
            : (result.next ?? result.reason ?? result.outcome),
        );
      } else if (!result && !retryAvailable) {
        setUncertain(false);
        setMessage('No exact command is pending. Inspect the current controller state.');
      } else setMessage('The exact command remains unconfirmed.');
    } catch {
      setMessage('Exact retry could not be confirmed. Reconnect and retry the same command.');
    } finally {
      setRequested(null);
    }
  }
  if (memberOf)
    return (
      <section className="card view-stack" aria-label="Combined member task">
        <h2>Combined member</h2>
        <p>This task contributes to a parent candidate. Child acceptance is unavailable.</p>
        {onSelectTask && (
          <button
            className="button secondary"
            type="button"
            onClick={() => onSelectTask(memberOf.taskId)}
          >
            Open parent task
          </button>
        )}
      </section>
    );
  return (
    <section
      className="view-stack"
      aria-labelledby={titleId}
      style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <header className="section-heading" style={{ flexShrink: 0 }}>
        <h2 id={titleId}>Combined task</h2>
        <span>{preview ? phases[preview.phase] : 'Two draft children'}</span>
      </header>
      <section
        aria-label="Combined task details"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: This bounded panel needs a keyboard scroll target beside its form controls.
        tabIndex={0}
        className="view-stack"
        style={{ overflowY: 'auto', minHeight: 0, flex: 1, padding: 2 }}
      >
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        {message && message !== error && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
        {task && !currentSelection && (
          <p className="notice" role="status">
            The parent task changed. Refresh the current controller state.
          </p>
        )}
        {(!connected || retryAvailable || uncertain) && (
          <div className="notice" role="status">
            <p>
              {!connected
                ? 'Reconnect to change combined work.'
                : 'Resolve the uncertain command before changing combined work.'}
            </p>
            {onRetry && (retryAvailable || uncertain) && (
              <button
                className="button secondary"
                type="button"
                disabled={!connected || busy}
                onClick={() => void retry()}
              >
                Retry exact command
              </button>
            )}
          </div>
        )}
        {preview ? (
          <>
            {preview.blocker && (
              <p className="notice" role="status">
                {reasons[preview.blocker]}. Retained work stays available for inspection.
              </p>
            )}
            <div className="facts-grid">
              <Fact label="Remaining attempts" value={preview.remainingBudgets.attempts} />
              <Fact label="Remaining minutes" value={preview.remainingBudgets.minutes} />
              <Fact label="Remaining concurrency" value={preview.remainingBudgets.concurrency} />
              <Fact label="Generation" value={preview.generation} />
            </div>
            <section className="card view-stack">
              <h3>Reserved dispatches</h3>
              <ol>
                {preview.dispatches.map((dispatch) => (
                  <li key={dispatch.phase}>
                    <p>
                      {dispatchLabels[dispatch.phase]} · {dispatch.state} ·{' '}
                      {dispatch.maximumMinutes} minutes maximum
                    </p>
                    {dispatch.attemptId && <small>Attempt {dispatch.attemptId}</small>}
                    {dispatch.checkArtifactId && (
                      <small> · Check artifact {dispatch.checkArtifactId}</small>
                    )}
                  </li>
                ))}
              </ol>
            </section>
            <section className="card view-stack">
              <h3>Child writers</h3>
              {preview.members.map((member, index) => {
                const child = snapshot.tasks.find((value) => value.id === member.taskId);
                return (
                  <div key={member.taskId}>
                    <h4>{child?.title ?? member.taskId}</h4>
                    <code>{member.scope[0]}</code>
                    <p className="muted small">{reasons[member.start.reason]}</p>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={blocked || !member.start.available || child?.runId !== member.runId}
                      onClick={() => start(member.taskId, member.runId, member.start.available)}
                    >
                      Start writer {index + 1}
                    </button>
                  </div>
                );
              })}
              <p className="muted small">
                Both contributions must finish. Child work cannot be accepted separately.
              </p>
            </section>
            <section className="card view-stack">
              <h3>Combined candidate</h3>
              {preview.candidate ? (
                <>
                  <code>{preview.candidate.id}</code>
                  <code>{preview.candidate.hash}</code>
                  <p className="muted small">
                    A retained candidate does not establish completed checks or review.
                  </p>
                  {snapshot.evidence
                    .filter(
                      (evidence) =>
                        evidence.candidateId === preview.candidate?.id &&
                        evidence.candidateHash === preview.candidate.hash,
                    )
                    .map((evidence) => (
                      <p key={evidence.artifactId}>
                        {evidence.review ? 'Review' : 'Checks'} ·{' '}
                        {evidence.passed ? 'Passed' : 'Failed'} · {evidence.artifactId}
                      </p>
                    ))}
                </>
              ) : (
                <p>No combined candidate is retained.</p>
              )}
              <div className="facts-grid">
                <Fact label="Final checks" value={reasons[preview.evaluate.reason]} />
                <Fact label="Independent review" value={reasons[preview.review.reason]} />
                <Fact label="Parent acceptance" value={reasons[preview.accept.reason]} />
              </div>
              {onInspect && (
                <div className="button-row">
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => onInspect('changes')}
                  >
                    Inspect retained Changes
                  </button>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => onInspect('evaluation')}
                  >
                    Open checks and review
                  </button>
                </div>
              )}
            </section>
            <details className="technical-details">
              <summary>Combined preparation identity</summary>
              <code>Run {preview.runId}</code>
              <code>Preparation {preview.preparationId}</code>
              <code>Manifest {preview.manifestHash}</code>
              <code>Group revision {preview.revision}</code>
              {onInspect && (
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => onInspect('activity')}
                >
                  Open activity
                </button>
              )}
            </details>
          </>
        ) : (
          <form
            id={formId}
            onSubmit={prepare}
            className="view-stack"
            aria-describedby={validationId}
          >
            <p className="muted small">
              Use two existing draft tasks in this project. Paths are checked on Prepare. Prior
              execution, leases, publication and exact file eligibility are rechecked by the
              controller.
            </p>
            {task && (
              <section className="card">
                <h3>{task.title}</h3>
                <p>{project?.name ?? task.projectId}</p>
                <p>{task.outcome}</p>
              </section>
            )}
            {actualSource ? (
              <SourceFacts source={actualSource} />
            ) : (
              <p className="notice">Current project base is unavailable.</p>
            )}
            {onRefreshSource && (
              <button
                className="button secondary"
                type="button"
                disabled={blocked}
                onClick={() => {
                  void Promise.resolve()
                    .then(onRefreshSource)
                    .catch(() =>
                      setMessage(
                        'Source inspection could not be confirmed. The draft remains in this panel.',
                      ),
                    );
                }}
              >
                Inspect current source
              </button>
            )}
            {children.map((child, index) => {
              const childIndex = index as 0 | 1;
              return (
                <fieldset className="card view-stack" key={childIndex} disabled={busy}>
                  <legend>Writer {index + 1}</legend>
                  <label>
                    Existing draft task
                    <select
                      value={child.taskId}
                      onChange={(event) =>
                        updateChild(childIndex, { ...child, taskId: event.target.value })
                      }
                    >
                      <option value="">Choose a child task</option>
                      {drafts.map((draft) => (
                        <option
                          key={draft.id}
                          value={draft.id}
                          disabled={children[1 - childIndex].taskId === draft.id}
                        >
                          {draft.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Exact committed target
                    <input
                      value={child.path}
                      aria-invalid={
                        child.path.length > 0 &&
                        !NativeTargetPathSchema.safeParse(child.path).success
                      }
                      aria-describedby={validationId}
                      placeholder="src/example.ts"
                      spellCheck={false}
                      onChange={(event) =>
                        updateChild(childIndex, { ...child, path: event.target.value })
                      }
                    />
                  </label>
                  <WriterFields
                    value={child}
                    snapshot={snapshot}
                    disabled={busy}
                    onChange={(value) => updateChild(childIndex, value)}
                  />
                  <label>
                    Writer minutes maximum
                    <input
                      type="number"
                      min="1"
                      max="5"
                      step="1"
                      value={child.maximumMinutes}
                      onChange={(event) =>
                        updateChild(childIndex, { ...child, maximumMinutes: event.target.value })
                      }
                    />
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={consents.writers[childIndex]}
                      onChange={(event) =>
                        setConsents((current) => ({
                          ...current,
                          writers:
                            childIndex === 0
                              ? [event.target.checked, current.writers[1]]
                              : [current.writers[0], event.target.checked],
                        }))
                      }
                    />
                    Allow this writer to receive the child task and exact committed file, and write
                    independent scratch
                  </label>
                </fieldset>
              );
            })}
            <section className="card view-stack">
              <h3>Independent reviewer</h3>
              <label>
                Reviewer profile
                <select
                  value={reviewerId}
                  disabled={busy}
                  onChange={(event) => {
                    setReviewerId(event.target.value);
                    setReviewerCredits(false);
                  }}
                >
                  <option value="">Choose a reviewer</option>
                  {snapshot.nativeProfiles
                    .filter((profile) => profile.id === 'openai-file-v1')
                    .map((profile) => (
                      <option key={profile.id} value={profile.id} disabled={!profile.available}>
                        {profile.displayName}
                        {profile.available ? '' : ' (unavailable)'}
                      </option>
                    ))}
                </select>
              </label>
              {reviewer && (
                <p className="muted small">
                  {reviewer.model} ·{' '}
                  {reviewer.qualifiedAt
                    ? `Profile qualified ${reviewer.qualifiedAt}`
                    : 'Qualification pending'}
                  . A separate attempt provides process independence.
                </p>
              )}
              <label>
                Reviewer minutes maximum
                <input
                  type="number"
                  min="1"
                  max="5"
                  step="1"
                  disabled={busy}
                  value={reviewerMinutes}
                  onChange={(event) => setReviewerMinutes(event.target.value)}
                />
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={reviewerCredits}
                  disabled={busy || !reviewer?.creditPolicies.includes('existing-credits')}
                  onChange={(event) => setReviewerCredits(event.target.checked)}
                />
                Allow existing credits for this reviewer
              </label>
              <p className="muted small">
                One Keep it simple review. Check and review grants are prepared separately after
                assembly.
              </p>
            </section>
            <section className="card view-stack">
              <h3>Shared finite budget</h3>
              <label>
                Authority
                <select
                  value={authority}
                  disabled={busy}
                  onChange={(event) =>
                    setAuthority(event.target.value === 'balanced' ? 'balanced' : 'guided')
                  }
                >
                  <option value="guided">Guided</option>
                  <option value="balanced">Balanced</option>
                </select>
              </label>
              <div className="policy-grid">
                <label>
                  Total attempts
                  <input
                    type="number"
                    min="7"
                    max="100"
                    step="1"
                    disabled={busy}
                    value={attempts}
                    onChange={(event) => setAttempts(event.target.value)}
                  />
                </label>
                <label>
                  Total minutes
                  <input
                    type="number"
                    min={
                      5 +
                      Number(children[0].maximumMinutes) +
                      Number(children[1].maximumMinutes) +
                      Number(reviewerMinutes)
                    }
                    max="1440"
                    step="1"
                    disabled={busy}
                    value={minutes}
                    onChange={(event) => setMinutes(event.target.value)}
                  />
                </label>
                <label>
                  Concurrent attempts
                  <input
                    type="number"
                    min="2"
                    max="16"
                    step="1"
                    disabled={busy}
                    value={concurrency}
                    onChange={(event) => setConcurrency(event.target.value)}
                  />
                </label>
              </div>
              <p className="muted small">
                Seven reserved dispatches cover baseline, two writers, two replays, final checks and
                review. The minute budget also includes bounded integration work.
              </p>
            </section>
            <section className="card view-stack">
              <h3>Project Node checks</h3>
              <p className="muted small">
                Exact committed test files, one path per line, up to 32 per collection. No commands
                or globs. All tests stay outside both writer scopes. Local code runs with system
                permissions; dependencies are not installed.
              </p>
              <label>
                Full baseline and final collection
                <textarea
                  rows={3}
                  value={fullTests}
                  aria-invalid={
                    fullTests.length > 0 &&
                    !ProjectNodeTestFilesSchema.safeParse(paths(fullTests)).success
                  }
                  aria-describedby={validationId}
                  disabled={busy}
                  onChange={(event) => setFullTests(event.target.value)}
                />
              </label>
              <label>
                Writer 1 replay collection
                <textarea
                  rows={2}
                  value={firstTests}
                  aria-invalid={
                    firstTests.length > 0 &&
                    !ProjectNodeTestFilesSchema.safeParse(paths(firstTests)).success
                  }
                  aria-describedby={validationId}
                  disabled={busy}
                  onChange={(event) => setFirstTests(event.target.value)}
                />
              </label>
              <label>
                Writer 2 replay collection
                <textarea
                  rows={2}
                  value={secondTests}
                  aria-invalid={
                    secondTests.length > 0 &&
                    !ProjectNodeTestFilesSchema.safeParse(paths(secondTests)).success
                  }
                  aria-describedby={validationId}
                  disabled={busy}
                  onChange={(event) => setSecondTests(event.target.value)}
                />
              </label>
              <label>
                Interaction collection
                <textarea
                  rows={2}
                  value={interactionTests}
                  aria-invalid={
                    interactionTests.length > 0 &&
                    !ProjectNodeTestFilesSchema.safeParse(paths(interactionTests)).success
                  }
                  aria-describedby={validationId}
                  disabled={busy}
                  onChange={(event) => setInteractionTests(event.target.value)}
                />
              </label>
              <p className="muted small">
                The full collection includes both replays and separate interaction tests. Replay 2
                checks both declared replay collections. The final full check remains separate.
              </p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={consents.baseline}
                  disabled={busy}
                  onChange={(event) =>
                    setConsents((current) => ({ ...current, baseline: event.target.checked }))
                  }
                />
                Allow the one-minute baseline check on this frozen collection
              </label>
              {([0, 1] as const).map((index) => (
                <label className="checkbox-label" key={index}>
                  <input
                    type="checkbox"
                    checked={consents.replays[index]}
                    disabled={busy}
                    onChange={(event) =>
                      setConsents((current) => ({
                        ...current,
                        replays:
                          index === 0
                            ? [event.target.checked, current.replays[1]]
                            : [current.replays[0], event.target.checked],
                      }))
                    }
                  />
                  Allow one minute for replay {index + 1} on its frozen integration step
                </label>
              ))}
            </section>
            <p className="notice" role="status" id={validationId}>
              {validation}
            </p>
          </form>
        )}
      </section>
      <footer className="button-row" style={{ flexShrink: 0 }}>
        {preview ? (
          <>
            <button
              className="button secondary"
              type="button"
              disabled={blocked || !preview.start.available}
              onClick={() => start(preview.taskId, preview.runId, preview.start.available)}
            >
              Run baseline
            </button>
            <span className="muted small">{reasons[preview.start.reason]}</span>
            <button
              className="button primary"
              type="button"
              disabled={blocked || !preview.assemble.available}
              onClick={() => {
                if (task && preview.assemble.available)
                  void command('Assembly', {
                    command: 'AssembleCombinedCandidate',
                    expectedRevision: task.revision,
                    payload: {
                      taskId: preview.taskId,
                      runId: preview.runId,
                      preparationId: preview.preparationId,
                    },
                  });
              }}
            >
              Assemble candidate
            </button>
            <span className="muted small">{reasons[preview.assemble.reason]}</span>
          </>
        ) : (
          <button className="button primary" type="submit" form={formId} disabled={!canPrepare}>
            Prepare combined task
          </button>
        )}
      </footer>
    </section>
  );
}
