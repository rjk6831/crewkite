import {
  type Candidate,
  formatReviewTarget,
  type Guidance,
  NativeFileProfileIdSchema,
  NativeHandoffPreparationPayloadSchema,
  type NativeHandoffTarget,
  NativeHandoffTargetsSchema,
  NativeTargetPathSchema,
  type Policy,
  PolicySchema,
  ProjectNodeTestFilesSchema,
  type ReviewMethod,
  type Role,
  type Run,
  RunSchema,
  requiredReviewMethodIds,
  type Snapshot,
  type SourceDetails,
  type Task,
} from '@crewkite/contracts';
import { createDemoFixtures } from '@crewkite/testkit';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
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
import {
  actionName,
  CurrentCheckoutChanges,
  Dialog,
  effectTarget,
  Fact,
  familyName,
  Help,
  moveTabFocus,
  RouterCard,
  SourceFacts,
  titleCase,
} from './components.tsx';
import type { Workspace } from './source.ts';
import { loadTeams, roleLabels, type SavedTeam, saveTeam } from './templates.ts';

export const googleAcpLabel =
  'Google’s published ACP agent, signed in with your own Google account. Google documents this agent for editors; CrewKite is not named.';

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
    id: 'second-opinion',
    name: 'Second opinion',
    description: 'Request one independent review against the candidate and criteria.',
    credit: 'multi',
  },
  {
    id: 'challenge-assumptions',
    name: 'Challenge assumptions',
    description: 'Test the assumptions behind the plan before accepting its claims.',
    credit: 'ADHD',
  },
  {
    id: 'round-robin',
    name: 'Round-robin review',
    description: 'Run a finite sequence of critiques with an explicit round cap.',
    credit: 'multi',
  },
];
const principles = [
  'Keep the source checkout untouched.',
  'Require review for dependency and configuration changes.',
  'Stop on failed checks.',
  'Allow only the specific action approved for this task.',
];

type LaunchProps = {
  task: Task;
  snapshot: Snapshot;
  workspace: Workspace;
  onClose: () => void;
};

const evaluationReasons = {
  available: 'Available',
  'already-started': 'This action already started. Inspect its retained evidence.',
  'checks-required': 'Start the prepared local checks first.',
  'checks-failed': 'The local checks did not pass.',
  expired: 'The prepared evaluation expired.',
  paused: 'This run is paused.',
  'ownership-unknown': 'Execution ownership is unknown. Nothing will start.',
  'not-stopped': 'Wait for the current work to stop.',
  'preparation-changed': 'The candidate, source or evaluation definition changed.',
  'consent-unavailable': 'Matching evaluation consent is unavailable.',
  'profile-unavailable': 'The saved reviewer profile is unavailable or changed.',
  'grant-unavailable': 'The exact permission is expired, revoked or already used.',
  'budget-exhausted': 'The original run has no remaining execution slot.',
};
const evaluationRecipes = {
  'node-tests-v1': 'Sample project tests',
  'project-node-tests-v1': 'Project Node tests',
  'crewkite-verify-v1': 'CrewKite verification',
};
const verificationStages = {
  policy: 'Policy',
  lint: 'Lint',
  types: 'Types',
  'node-tests': 'Node tests',
  build: 'Desktop build',
  desktop: 'Desktop journey',
};
const evaluationStages = {
  prepared: 'Prepared',
  checking: 'Running local checks',
  'check-failed': 'Local checks failed',
  'awaiting-review': 'Ready for review',
  reviewing: 'Running native review',
  reviewed: 'Review completed',
  blocked: 'Start unavailable',
};

export function NativeEvaluation({
  task,
  candidate,
  snapshot,
  workspace,
}: {
  task: Task;
  candidate?: Candidate;
  snapshot: Snapshot;
  workspace: Workspace;
}) {
  const run = snapshot.runs.find((value) => value.id === task.runId);
  const native = snapshot.nativeRuns.find((value) => value.runId === task.runId);
  const prepared = snapshot.candidateEvaluations.find((value) => value.taskId === task.id);
  const reviewerProfiles = snapshot.nativeProfiles
    .filter((value) => value.family === 'openai')
    .filter((value) => value.id === 'openai-file-v1');
  const [profileId, setProfileId] = useState(reviewerProfiles[0]?.id ?? '');
  const [nativeTrust, setNativeTrust] = useState(false);
  const [sourceConsent, setSourceConsent] = useState(false);
  const [savedConsent, setSavedConsent] = useState(false);
  const [existingCredits, setExistingCredits] = useState(false);
  const [checkPermission, setCheckPermission] = useState(false);
  const [reviewPermission, setReviewPermission] = useState(false);
  const [recipe, setRecipe] =
    useState<Snapshot['candidateEvaluations'][number]['recipe']>('node-tests-v1');
  const [testFileInput, setTestFileInput] = useState('');
  const [expiresAt, setExpiresAt] = useState(() => new Date(Date.now() + 3600000).toISOString());
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const profile = reviewerProfiles.find(
    (value) => value.id === (profileId || reviewerProfiles[0]?.id),
  );
  const methods = run?.policy.policy.methods ?? [];
  const method = methods[0];
  const supported =
    !!method &&
    methods.length === 1 &&
    method.id === 'keep-it-simple' &&
    method.cycles === 1 &&
    requiredReviewMethodIds(run?.policy.policy.quality ?? 'quick').every((id) => id === method.id);
  const connected =
    workspace.connection === 'connected' && !workspace.preview && !workspace.pending;
  const permissionExpiry = Date.parse(expiresAt);
  const expiryInput = Number.isFinite(permissionExpiry)
    ? new Date(permissionExpiry - new Date(permissionExpiry).getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 19)
    : '';
  const preparedProfile = snapshot.nativeProfiles.find(
    (value) => value.id === prepared?.reviewer.profileId,
  );
  const methodName = (id: ReviewMethod['id']) =>
    methodCatalog.find((value) => value.id === id)?.name ?? 'Unavailable method';
  const projectTests = recipe === 'project-node-tests-v1';
  const fullVerification = recipe === 'crewkite-verify-v1';
  const visibleRecipe = prepared && !editing ? prepared.recipe : recipe;
  const testFiles = ProjectNodeTestFilesSchema.safeParse(
    testFileInput.split(/\r?\n/u).filter((path) => path.length > 0),
  );
  const invalidTestFiles = projectTests && testFileInput.length > 0 && !testFiles.success;
  const testFileErrorId = `project-test-files-${task.id}`;
  function resetConsent() {
    setNativeTrust(false);
    setSourceConsent(false);
    setSavedConsent(false);
    setCheckPermission(false);
    setReviewPermission(false);
    setExistingCredits(false);
  }
  const allowed =
    connected &&
    candidate &&
    task.state === 'stopped' &&
    supported &&
    profile?.available &&
    profile.creditPolicies.some(
      (value) => value === (existingCredits ? 'existing-credits' : 'ordinary'),
    ) &&
    (savedConsent || (nativeTrust && sourceConsent)) &&
    checkPermission &&
    reviewPermission &&
    (!projectTests || testFiles.success) &&
    Number.isFinite(permissionExpiry) &&
    permissionExpiry > Date.now();
  async function prepare() {
    if (!allowed || !method || !candidate || !profile) return;
    if (projectTests && !testFiles.success) return;
    try {
      const result = await workspace.command({
        command: 'PrepareCandidateEvaluation',
        expectedRevision: task.revision,
        payload: {
          taskId: task.id,
          candidateId: candidate.id,
          ...(projectTests && testFiles.success
            ? { checkRecipeId: 'project-node-tests-v1' as const, testFiles: testFiles.data }
            : fullVerification
              ? { checkRecipeId: 'crewkite-verify-v1' as const }
              : { checkRecipeId: 'node-tests-v1' as const }),
          reviewer: { profileId: profile.id, methodId: method.id, cycles: 1 },
          creditPolicy: existingCredits ? 'existing-credits' : 'ordinary',
          consent: savedConsent ? 'saved' : 'explicit',
          grants: [
            {
              action: 'run-check' as const,
              target: fullVerification ? 'crewkite verify' : 'node --test',
            },
            {
              action: 'run-review' as const,
              target: formatReviewTarget({ methodId: method.id, cycle: 1 }),
            },
          ].map((effect) => ({
            ...effect,
            taskId: task.id,
            usesRemaining: 1,
            revoked: false,
            expiresAt: new Date(permissionExpiry).toISOString(),
          })),
        },
      });
      setMessage(
        result.outcome === 'applied' || result.outcome === 'already-applied'
          ? null
          : (result.next ??
              'Evaluation preparation was refused. Review the candidate and permissions.'),
      );
      if (result.outcome === 'applied' || result.outcome === 'already-applied') setEditing(false);
    } catch {
      setMessage('Preparation could not be confirmed. Inspect the saved task before retrying.');
    }
  }
  async function start(command: 'StartCandidateEvaluation' | 'StartCandidateReview') {
    if (!prepared || !connected) return;
    const readiness =
      command === 'StartCandidateEvaluation' ? prepared.checkStart : prepared.reviewStart;
    if (!readiness.available) return;
    try {
      const result = await workspace.command({
        command,
        expectedRevision: task.revision,
        payload: {
          taskId: task.id,
          candidateId: prepared.candidateId,
          preparationId: prepared.preparationId,
        },
      });
      setMessage(
        result.outcome === 'applied' || result.outcome === 'already-applied'
          ? null
          : (result.next ?? 'Start was refused. Refresh the retained evaluation.'),
      );
    } catch {
      setMessage('Start could not be confirmed. Inspect the saved task before retrying.');
    }
  }
  const reviews = snapshot.evidence.flatMap((value) =>
    value.candidateId === candidate?.id && value.review && !value.review.job.scripted
      ? [{ artifactId: value.artifactId, result: value.review }]
      : [],
  );
  return (
    <section className="card view-stack" aria-label="Candidate evaluation">
      <div className="section-heading">
        <h2>Candidate evaluation</h2>
        <span>{prepared ? evaluationStages[prepared.stage] : 'Separate preparation'}</span>
      </div>
      <p className="muted">
        Prepare one local check and one additional native review. Both use the remaining original
        run limits. The review uses a fresh process. It can use the same model as the writer.
      </p>
      {visibleRecipe === 'project-node-tests-v1' && (
        <p className="muted small">
          Local code runs with your system permissions. Dependencies are not installed. Imports can
          use Node built-ins and files in the check copy.
        </p>
      )}
      {visibleRecipe === 'crewkite-verify-v1' && (
        <p className="muted small">
          Local code runs with your system permissions. Installed dependencies and Electron are
          copied on macOS arm64. Local Node and Git are verified. Dependencies are not installed.
        </p>
      )}
      {fullVerification && workspace.pending && (!prepared || editing) && (
        <p className="muted small" role="status">
          Preparing verification tools...
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {prepared && !editing ? (
        <>
          <div className="facts-grid">
            {prepared.repository ? (
              <>
                <Fact label="Source files" value={prepared.repository.files} />
                <Fact label="Source bytes" value={prepared.repository.bytes} />
              </>
            ) : (
              <Fact label="Target" value={prepared.target?.path ?? 'Unavailable'} />
            )}
            <Fact label="Checks" value={evaluationRecipes[prepared.recipe]} />
            <Fact label="Reviewer" value={preparedProfile?.displayName ?? 'Unavailable profile'} />
            <Fact label="Role" value={roleLabels[prepared.reviewer.assignedRole]} />
            <Fact label="Method" value={methodName(prepared.reviewer.methodId)} />
            <Fact label="Review cycles" value={1} />
            <Fact label="Independence" value="Separate process only" />
            <Fact
              label="Usage"
              value={
                prepared.creditPolicy === 'ordinary'
                  ? 'Included usage only'
                  : 'Included usage and existing credits'
              }
            />
            <Fact label="Expires" value={new Date(prepared.expiresAt).toLocaleString()} />
            <Fact label="Remaining total attempts" value={prepared.remainingBudgets.attempts} />
            <Fact label="Remaining total minutes" value={prepared.remainingBudgets.minutes} />
          </div>
          {prepared.verification && (
            <p className="muted small">
              {prepared.verification.stages.map((stage) => verificationStages[stage]).join(', ')}.
              Maximum {prepared.verification.maximumMinutes} minutes for staging, checks and
              cleanup.
            </p>
          )}
          {prepared.testFiles.length > 0 && (
            <div>
              <p>Committed test files</p>
              <ul>
                {prepared.testFiles.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <details className="technical-details">
            <summary>Evaluation identity</summary>
            <code>Preparation {prepared.preparationId}</code>
            <code>Candidate tree {prepared.candidateHash}</code>
            {prepared.repository ? (
              <>
                <code>Source base {prepared.repository.sourceBase}</code>
                <code>Source manifest {prepared.repository.manifestHash}</code>
              </>
            ) : (
              <>
                <code>Original file {prepared.target?.baseHash}</code>
                <code>Candidate content {prepared.target?.candidateContentHash}</code>
              </>
            )}
            <code>Check definition {prepared.definitionHash}</code>
            <code>Check recipe {prepared.recipe}</code>
            {prepared.testFiles.map((file) => (
              <code key={file.path}>
                Test file {file.path}, {file.hash}, {file.bytes} bytes, {file.mode}
              </code>
            ))}
            {prepared.verification && (
              <>
                <code>Toolchain {prepared.verification.toolchainHash}</code>
                <code>Baseline {prepared.verification.baselineHash}</code>
                <code>Lockfile {prepared.verification.lockHash}</code>
                <code>
                  {prepared.verification.platform} {prepared.verification.arch}
                </code>
                {Object.entries(prepared.verification.executables).map(([name, executable]) => (
                  <code key={name}>
                    {name} {executable.version}, {executable.sha256}
                  </code>
                ))}
              </>
            )}
            <code>Reviewer profile {prepared.reviewer.profileId}</code>
            <code>Review method {prepared.reviewer.methodId}, cycle 1, process-only</code>
            {prepared.check && <code>Check artifact {prepared.check.artifactId}</code>}
            {prepared.review && <code>Review artifact {prepared.review.artifactId}</code>}
          </details>
          {(!prepared.check || !prepared.review) && (
            <div className="button-row">
              {!prepared.check && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={!connected || !prepared.checkStart.available}
                  onClick={() => void start('StartCandidateEvaluation')}
                >
                  Start local checks
                </button>
              )}
              {!prepared.review && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={!connected || !prepared.reviewStart.available}
                  onClick={() => void start('StartCandidateReview')}
                >
                  Start native review
                </button>
              )}
            </div>
          )}
          {!prepared.check && (
            <p className="muted small" role="status">
              Checks: {evaluationReasons[prepared.checkStart.reason]}
            </p>
          )}
          {!prepared.review && (
            <p className="muted small" role="status">
              Review: {evaluationReasons[prepared.reviewStart.reason]}
            </p>
          )}
          {!prepared.check &&
            !prepared.review &&
            task.state === 'stopped' &&
            prepared.checkStart.reason !== 'already-started' && (
              <button
                type="button"
                className="button secondary"
                disabled={!connected}
                onClick={() => {
                  setProfileId(prepared.reviewer.profileId);
                  setExpiresAt(prepared.expiresAt);
                  setRecipe(prepared.recipe);
                  setTestFileInput(prepared.testFiles.map((file) => file.path).join('\n'));
                  resetConsent();
                  setEditing(true);
                  setMessage(null);
                }}
              >
                Edit evaluation permissions
              </button>
            )}
          {prepared.check && <p>Local checks {prepared.check.passed ? 'passed' : 'failed'}.</p>}
          {prepared.review && <p>Native review {prepared.review.outcome}.</p>}
        </>
      ) : (
        <>
          <p>
            File <code>{native?.target?.path ?? 'Unavailable'}</code>
          </p>
          <details className="technical-details">
            <summary>File details</summary>
            <code>Candidate tree {candidate?.hash ?? 'Unavailable'}</code>
            <code>Original file {native?.target?.baseHash ?? 'Unavailable'}</code>
            <code>Source base {run?.source.base ?? 'Unavailable'}</code>
          </details>
          <p className="muted small">
            Preparation records the check definition and permissions. Checks and review start
            separately.
          </p>
          <label>
            Test setup
            <select
              value={recipe}
              onChange={(event) => {
                setRecipe(
                  event.target.value === 'project-node-tests-v1'
                    ? 'project-node-tests-v1'
                    : event.target.value === 'crewkite-verify-v1'
                      ? 'crewkite-verify-v1'
                      : 'node-tests-v1',
                );
                resetConsent();
              }}
            >
              <option value="node-tests-v1">Sample project tests</option>
              <option value="project-node-tests-v1">Project Node tests</option>
              <option value="crewkite-verify-v1">CrewKite verification</option>
            </select>
          </label>
          {projectTests ? (
            <>
              <label>
                Committed test files (one relative path per line)
                <textarea
                  rows={4}
                  value={testFileInput}
                  aria-invalid={invalidTestFiles}
                  aria-describedby={invalidTestFiles ? testFileErrorId : undefined}
                  onChange={(event) => {
                    setTestFileInput(event.target.value);
                    resetConsent();
                  }}
                />
              </label>
              {invalidTestFiles && (
                <p className="notice" id={testFileErrorId} role="alert">
                  Enter 1 to 32 distinct relative file paths. Patterns and paths outside the project
                  are unavailable.
                </p>
              )}
              <p className="muted small">
                Choose 1 to 32 distinct committed files. Globs are unavailable.
              </p>
            </>
          ) : !fullVerification ? (
            <p className="muted small">The built-in checks cover the sample net.mjs project.</p>
          ) : (
            <p className="muted small">
              Runs policy, lint, types, Node tests, the desktop build and the desktop journey.
              Staging, checks and cleanup share a five-minute limit. The original run needs six
              remaining minutes and two attempts, including the later review.
            </p>
          )}
          {!supported && (
            <p className="notice">
              This run needs review methods or repeat cycles that are unavailable. Its saved
              requirements stay unchanged.
            </p>
          )}
          <label>
            Reviewer profile
            <select
              value={profile?.id ?? ''}
              onChange={(event) => setProfileId(event.target.value)}
            >
              {reviewerProfiles.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.displayName}
                  {value.available ? '' : ' (unavailable)'}
                </option>
              ))}
            </select>
          </label>
          {profile && (
            <details className="technical-details">
              <summary>Reviewer details</summary>
              <code>Client {profile.clientVersion}</code>
              <code>Model {profile.model}</code>
              <code>
                {titleCase(profile.effort)} effort, {titleCase(profile.serviceTier)} service tier
              </code>
            </details>
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={savedConsent}
              onChange={(event) => setSavedConsent(event.target.checked)}
            />
            Use saved consent for this exact evaluation
          </label>
          {!savedConsent && (
            <>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={nativeTrust}
                  onChange={(event) => setNativeTrust(event.target.checked)}
                />
                Trust the existing native client and login for the review
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={sourceConsent}
                  onChange={(event) => setSourceConsent(event.target.checked)}
                />
                {native?.repository
                  ? 'Share the committed source, candidate changes and task text with the reviewer'
                  : 'Share the original file, proposed change and task text with the reviewer'}
              </label>
            </>
          )}
          <p className="muted small">
            Native guidance may apply. Tool containment and a provider hard spending cap remain
            unqualified.{' '}
            {projectTests || fullVerification
              ? 'Checks use an independent candidate copy.'
              : 'The original source checkout stays unchanged.'}
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={existingCredits}
              disabled={!profile?.creditPolicies.some((value) => value === 'existing-credits')}
              onChange={(event) => setExistingCredits(event.target.checked)}
            />
            Allow existing credits for this review after included usage
          </label>
          <p className="muted small">
            This separate choice defaults off. No reset, purchase or top-up is requested.
          </p>
          <label>
            Permission expiry (local time)
            <input
              type="datetime-local"
              step="1"
              value={expiryInput}
              onChange={(event) =>
                setExpiresAt(event.target.value ? new Date(event.target.value).toISOString() : '')
              }
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={checkPermission}
              onChange={(event) => setCheckPermission(event.target.checked)}
            />
            {fullVerification
              ? 'Allow one full local verification run'
              : projectTests
                ? 'Allow one local run of the selected project tests'
                : 'Allow one local test run'}
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={reviewPermission}
              onChange={(event) => setReviewPermission(event.target.checked)}
            />
            Allow one {method ? methodName(method.id) : ''} review
          </label>
          <button
            type="button"
            className="button primary"
            disabled={!allowed}
            onClick={() => void prepare()}
          >
            Prepare candidate evaluation
          </button>
          {editing && (
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setEditing(false);
                setMessage(null);
              }}
            >
              Cancel permission edit
            </button>
          )}
        </>
      )}
      {reviews.map(({ artifactId, result }) => (
        <article key={artifactId}>
          <h3>
            Native {methodName(result.job.methodId)}: {titleCase(result.outcome)}
          </h3>
          <p className="muted small">
            {!result.job.scripted && roleLabels[result.job.assignedRole]} · {result.job.cycle}{' '}
            review cycle · separate process only
          </p>
          <p>{result.summary}</p>
          <ul>
            {result.findings.map((finding) => (
              <li key={`${finding.severity}-${finding.message}`}>
                {finding.severity === 'info' ? 'Note' : titleCase(finding.severity)}:{' '}
                {finding.message}
              </li>
            ))}
          </ul>
        </article>
      ))}
      <p className={task.state === 'accepted' ? 'muted small' : 'notice'}>
        {task.state === 'accepted'
          ? 'Review the saved checks and review. Patch export remains available.'
          : 'Inspect Changes and retained evidence before local branch acceptance. Export remains available.'}
      </p>
    </section>
  );
}

export function Launch(props: LaunchProps) {
  const [native, setNative] = useState<'file' | 'repository' | null>(() => {
    const current = props.snapshot.nativeRuns.find((run) => run.runId === props.task.runId);
    return current ? (current.profileId === 'openai-repository-v1' ? 'repository' : 'file') : null;
  });
  return native ? (
    <NativeLaunch {...props} scope={native} onBack={() => setNative(null)} />
  ) : (
    <ScriptedLaunch {...props} onNative={setNative} />
  );
}

const permissionModeLabels = {
  'request-review': 'Request permission',
  strict: 'Strict',
  'always-proceed': 'Always proceed',
  'proceed-in-sandbox': 'Proceed in sandbox',
};

function NativeLaunch({
  task,
  snapshot,
  workspace,
  onClose,
  onBack,
  scope,
}: LaunchProps & { onBack: () => void; scope: 'file' | 'repository' }) {
  const project = snapshot.projects.find((value) => value.id === task.projectId);
  const repository = scope === 'repository';
  const profiles = snapshot.nativeProfiles
    .filter((value) => value.family !== 'local')
    .filter((value) => (value.id === 'openai-repository-v1') === repository);
  const current = snapshot.nativeRuns.find(
    (value) =>
      value.runId === task.runId && (value.profileId === 'openai-repository-v1') === repository,
  );
  const saved = current ? snapshot.runs.find((value) => value.id === task.runId) : undefined;
  const [profileId, setProfileId] = useState(
    current?.profileId ??
      profiles.find((value) => value.id === 'openai-file-v1')?.id ??
      profiles[0]?.id ??
      '',
  );
  const profile = profiles.find((value) => value.id === profileId);
  const google = profile?.family === 'google';
  const acpProfile = profile?.family === 'google' && 'configOptions' in profile ? profile : null;
  const [modelId, setModelId] = useState(current?.acp?.modelId ?? '');
  const [thoughtLevelId, setThoughtLevelId] = useState(current?.acp?.thoughtLevelId ?? '');
  const [quotaAccount, setQuotaAccount] = useState(false);
  const configuration = acpProfile?.configOptions;
  const selectedModel = modelId || configuration?.model.currentValue || '';
  const selectedThought = configuration?.thoughtLevel
    ? thoughtLevelId || configuration.thoughtLevel.currentValue
    : null;
  const attestedBilling = profile?.family === 'anthropic' || google;
  const [permissionMode, setPermissionMode] = useState<
    NonNullable<Snapshot['nativeRuns'][number]['permissionMode']> | ''
  >(current?.permissionMode ?? '');
  const [subscriptionLogin, setSubscriptionLogin] = useState(false);
  const [extraUsageDisabled, setExtraUsageDisabled] = useState(false);
  const [prepared, setPrepared] = useState<Run | null>(saved ?? null);
  const [targetPath, setTargetPath] = useState(current?.target?.path ?? '');
  const [nativeTrust, setNativeTrust] = useState(false);
  const [sourceConsent, setSourceConsent] = useState(false);
  const [nativeTools, setNativeTools] = useState(false);
  const [savedConsent, setSavedConsent] = useState(false);
  const [existingCredits, setExistingCredits] = useState(
    !!saved &&
      snapshot.routes.find((route) => route.id === saved.roles[0]?.routeId)?.billing === 'credits',
  );
  const [handoffEnabled, setHandoffEnabled] = useState(!!current?.handoff);
  const [handoffTargets, setHandoffTargets] = useState<NativeHandoffTarget[]>(
    current?.handoff?.targets ?? [],
  );
  const [message, setMessage] = useState<string | null>(null);
  const [policy, setPolicy] = useState<Policy>(
    () =>
      saved?.policy.policy ?? {
        authority: 'guided',
        quality: 'quick',
        methods: [{ id: 'keep-it-simple', cycles: 1, reviewerRole: 'reviewer' }],
        limits: { attempts: 3, minutes: 5, concurrency: 1 },
        reserves: [],
        unknownUsage: { rule: 'fixed-allowance', allowance: { launches: 1, minutes: 5 } },
        effects: [
          {
            taskId: task.id,
            action: 'write-scratch',
            target: project?.name ?? task.projectId,
            usesRemaining: 1,
            revoked: false,
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
          {
            taskId: task.id,
            action: 'export-patch',
            target: task.id,
            usesRemaining: 1,
            revoked: false,
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
        ],
      },
  );
  const minimumHandoffAttempts =
    3 +
    Math.max(
      1,
      (policy.methods ?? []).reduce((sum, method) => sum + method.cycles, 0),
    );
  const validHandoff =
    !handoffEnabled ||
    (!repository &&
      PolicySchema.safeParse(policy).success &&
      NativeHandoffTargetsSchema.safeParse(handoffTargets).success &&
      handoffTargets.some((recipient) => recipient.profileId !== profileId) &&
      policy.limits.attempts >= minimumHandoffAttempts &&
      policy.limits.minutes >= 5 &&
      policy.unknownUsage.rule === 'fixed-allowance' &&
      policy.unknownUsage.allowance.launches >= 2 &&
      policy.unknownUsage.allowance.minutes >= policy.limits.minutes);
  const capability = snapshot.nativeRuns.find((value) => value.runId === prepared?.id);
  const connected = workspace.connection === 'connected' && !workspace.preview;
  const allowed = connected && profile?.available && !workspace.pending;
  const validConsent = savedConsent || (nativeTrust && sourceConsent);
  const validTools = !repository || savedConsent || nativeTools;
  const billingAttestation = attestedBilling
    ? savedConsent
      ? current?.profileId === profile.id
        ? current.billingAttestation
        : undefined
      : subscriptionLogin && extraUsageDisabled && (!acpProfile || quotaAccount)
        ? {
            source: 'user-attested' as const,
            subscriptionLoginConfirmed: true as const,
            paidExtraUsageDisabled: true as const,
            ...(acpProfile ? { quotaAccountConfirmed: true as const } : {}),
          }
        : undefined
    : undefined;
  const validBilling = !attestedBilling || !!billingAttestation;
  const selectedPermissionMode = acpProfile
    ? 'request-review'
    : google
      ? savedConsent
        ? current?.profileId === profile.id
          ? current.permissionMode
          : undefined
        : permissionMode || undefined
      : undefined;
  const validPermissionMode =
    !google || profile.permissionModes.some((mode) => mode === selectedPermissionMode);
  const validAcp =
    !acpProfile ||
    (snapshot.googleAcpSetup?.state === 'ready' &&
      !!snapshot.googleAcpSetup.proofId &&
      !!configuration?.model.supported.includes(selectedModel) &&
      (configuration.thoughtLevel
        ? !!selectedThought && configuration.thoughtLevel.supported.includes(selectedThought)
        : selectedThought === null) &&
      policy.authority !== 'autopilot' &&
      !handoffEnabled &&
      !existingCredits &&
      !!billingAttestation &&
      'quotaAccountConfirmed' in billingAttestation &&
      (!savedConsent ||
        (current?.acp?.proofId === snapshot.googleAcpSetup.proofId &&
          current.acp.modelId === selectedModel &&
          current.acp.thoughtLevelId === selectedThought)));
  function resetConsent() {
    setNativeTrust(false);
    setSourceConsent(false);
    setSavedConsent(false);
    setExistingCredits(false);
  }
  function resetScope() {
    resetConsent();
    setSubscriptionLogin(false);
    setExtraUsageDisabled(false);
    setPermissionMode('');
    setModelId('');
    setThoughtLevelId('');
    setQuotaAccount(false);
    setNativeTools(false);
    setHandoffTargets((targets) =>
      targets.map((target) => ({ ...target, creditPolicy: 'ordinary' })),
    );
  }
  const startable =
    allowed &&
    prepared &&
    task.runId === prepared.id &&
    capability?.stage === 'prepared' &&
    (!attestedBilling || !!capability.billingAttestation) &&
    (!google || !!capability.permissionMode) &&
    !!capability.expiresAt &&
    Date.parse(capability.expiresAt) > Date.now();
  const unavailable = profile
    ? ((
        {
          'not-configured': 'The controller has no supported native profile.',
          'unsupported-platform': 'This profile requires macOS on Apple silicon.',
          'native-home-unavailable':
            'The existing native home is unavailable. Restart from the signed-in desktop session.',
          'configuration-location-unsupported':
            'This native configuration location has not been qualified.',
          'client-unavailable':
            'Install the supported official client before preparing this proposal.',
          'client-build-mismatch': 'The installed client build does not match this profile.',
          'qualification-pending': 'Qualification pending.',
          'acp-capability-missing':
            'The discovered client has no verified review mapping. Launch remains unavailable.',
          'auth-method-mismatch':
            'The client does not advertise the required personal authentication method.',
          'authentication-required':
            'Complete explicit personal sign-in in Usage and capacity first.',
          'provider-policy-restricted':
            'Google consumer CLI access is unavailable in CrewKite under the provider integration policy. Choose another profile or use the native app directly.',
          available: '',
        } as Partial<Record<Snapshot['nativeProfiles'][number]['reason'], string>>
      )[profile.reason] ?? 'The controller has no supported native profile.')
    : 'The controller has no supported native profile.';
  async function prepareNative() {
    if (
      !allowed ||
      !validConsent ||
      !validTools ||
      !validBilling ||
      !validPermissionMode ||
      !validHandoff ||
      !validAcp ||
      (!repository && !NativeTargetPathSchema.safeParse(targetPath).success) ||
      !profile
    )
      return;
    try {
      const expiresAt = new Date(Date.now() + 86400000).toISOString();
      const writeIndex = policy.effects.findIndex(
        (grant) =>
          grant.taskId === task.id &&
          grant.action === 'write-scratch' &&
          grant.target === project?.name,
      );
      const toolsIndex = policy.effects.findIndex(
        (grant) =>
          grant.taskId === task.id &&
          grant.action === 'run-native-tools' &&
          grant.target === project?.name,
      );
      const submittedPolicy = savedConsent
        ? policy
        : {
            ...policy,
            effects: policy.effects.map((grant, index) =>
              index === writeIndex || (repository && nativeTools && index === toolsIndex)
                ? {
                    ...grant,
                    expiresAt,
                    revoked: false,
                    usesRemaining: 1 as const,
                  }
                : grant,
            ),
          };
      if (!savedConsent && repository && nativeTools && toolsIndex < 0)
        submittedPolicy.effects.push({
          taskId: task.id,
          action: 'run-native-tools',
          target: project?.name ?? task.projectId,
          expiresAt,
          revoked: false,
          usesRemaining: 1,
        });
      const result = await workspace.command({
        command: 'PrepareNativeRun',
        expectedRevision: task.revision,
        payload: repository
          ? {
              taskId: task.id,
              profileId: 'openai-repository-v1',
              policy: submittedPolicy,
              creditPolicy: existingCredits ? 'existing-credits' : 'ordinary',
              consent: savedConsent ? 'saved' : 'explicit',
            }
          : acpProfile
            ? {
                taskId: task.id,
                profileId: 'google-acp-v1',
                targetPath,
                policy: submittedPolicy,
                creditPolicy: 'ordinary',
                consent: savedConsent ? 'saved' : 'explicit',
                proofId: snapshot.googleAcpSetup?.proofId as string,
                modelId: selectedModel,
                thoughtLevelId: selectedThought,
                billingAttestation: billingAttestation as {
                  source: 'user-attested';
                  subscriptionLoginConfirmed: true;
                  paidExtraUsageDisabled: true;
                  quotaAccountConfirmed: true;
                },
                permissionMode: 'request-review',
              }
            : {
                taskId: task.id,
                profileId: profile.id,
                targetPath,
                policy: submittedPolicy,
                creditPolicy: existingCredits ? 'existing-credits' : 'ordinary',
                consent: savedConsent ? 'saved' : 'explicit',
                ...(handoffEnabled ? { handoffTargets } : {}),
                ...(billingAttestation ? { billingAttestation } : {}),
                ...(selectedPermissionMode ? { permissionMode: selectedPermissionMode } : {}),
              },
      });
      const run = RunSchema.safeParse(result.entity);
      if (result.outcome === 'applied' && run.success) {
        setPrepared(run.data);
        setPolicy(run.data.policy.policy);
        setMessage(null);
      } else
        setMessage(
          result.next ??
            'The target, native consent or saved policy is unavailable. Review the proposal again.',
        );
    } catch {
      setMessage(
        'Preparation could not be confirmed. Check the connection and retained task before retrying.',
      );
    }
  }
  return (
    <Dialog
      title={
        prepared
          ? 'Review the native proposal'
          : repository
            ? 'Repository work'
            : 'Native file proposal'
      }
      eyebrow={repository ? 'COMMITTED REPOSITORY' : 'ONE EXISTING COMMITTED FILE'}
      onClose={onClose}
      wide
    >
      <div className="launch-content view-stack">
        {message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
        <section className="card">
          <div className="section-heading">
            <h2>{profile?.displayName ?? 'Native proposal'}</h2>
            <span>{attestedBilling ? 'Subscription confirmation required' : 'Requires Pro'}</span>
          </div>
          {!prepared && !repository && (
            <label>
              Writer profile
              <select
                value={profileId}
                onChange={(event) => {
                  setProfileId(event.target.value);
                  setHandoffEnabled(false);
                  resetScope();
                }}
              >
                {profiles.map((value) => (
                  <option key={value.id} value={value.id}>
                    {value.displayName}
                    {value.available ? '' : ' (unavailable)'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {acpProfile && <p className="muted small">{googleAcpLabel}</p>}
          {profile && (
            <div className="facts-grid">
              <span>Client {profile.clientVersion}</span>
              <span>{profile.model}</span>
              <span>
                {profile.effort}
                {attestedBilling ? ' requested effort' : ' effort'}
              </span>
              {attestedBilling && <span>Effective effort unknown</span>}
              {attestedBilling && <span>Account class unknown</span>}
              <span>
                {attestedBilling ? 'Service tier unknown' : `${profile.serviceTier} tier`}
              </span>
              {(attestedBilling || repository) && (
                <span>
                  {profile.qualifiedAt
                    ? `Qualified ${profile.qualifiedAt.slice(0, 10)}`
                    : 'Qualification pending'}
                </span>
              )}
            </div>
          )}
          <p className="muted small">
            Required native client metadata is checked when the run starts. A provider hard spending
            cap remains unverified.
          </p>
          {!profile?.available && (
            <p className="notice" role="status">
              {unavailable}
            </p>
          )}
        </section>
        {prepared ? (
          <>
            <SourceFacts source={prepared.source} />
            <section className="card" aria-label="Prepared native target">
              <h2>{repository ? 'Saved repository' : 'Saved target'}</h2>
              {repository ? (
                <>
                  <p>
                    {capability?.repository?.files ?? 'Unknown'} files ·{' '}
                    {capability?.repository?.bytes ?? 'Unknown'} bytes
                  </p>
                  <p>Local workspace writes · Native approval requests refused · Network off</p>
                  <details className="technical-details">
                    <summary>Repository identity and native settings</summary>
                    <code>Committed base {capability?.repository?.sourceBase ?? 'Unknown'}</code>
                    <code>Manifest {capability?.repository?.manifestHash ?? 'Unknown'}</code>
                    <code>Sandbox {capability?.execution?.sandbox ?? 'Unknown'}</code>
                    <code>Approval {capability?.execution?.approvalPolicy ?? 'Unknown'}</code>
                    <code>
                      Network access{' '}
                      {capability?.execution?.networkAccess === false ? 'false' : 'Unknown'}
                    </code>
                  </details>
                  <p>
                    Local-command permission: consumed at launch for{' '}
                    {project?.name ?? 'this project'}.
                  </p>
                </>
              ) : (
                <>
                  <code>{capability?.target?.path ?? targetPath}</code>
                  <p className="muted small">
                    Original hash{' '}
                    <code>{capability?.target?.baseHash ?? 'Waiting for saved target facts'}</code>
                  </p>
                  <p>{capability?.target?.bytes ?? 'Unknown'} bytes</p>
                </>
              )}
              {capability?.acp && (
                <p className="muted small">
                  Saved model {capability.acp.modelId}. Thought level{' '}
                  {capability.acp.thoughtLevelId ?? 'unknown'}. Setup proof {capability.acp.proofId}
                  . Same-account confirmation is user-attested.
                </p>
              )}
              {capability?.handoff && (
                <>
                  <p>
                    Allowed manual writers:{' '}
                    {capability.handoff.targets
                      .map(
                        (target) =>
                          snapshot.nativeProfiles.find((profile) => profile.id === target.profileId)
                            ?.displayName ?? target.profileId,
                      )
                      .join(', ')}
                  </p>
                  <p>
                    {prepared.policy.policy.limits.attempts} overall attempts ·{' '}
                    {prepared.policy.policy.limits.minutes} original minutes ·{' '}
                    {prepared.policy.policy.unknownUsage.rule === 'fixed-allowance'
                      ? prepared.policy.policy.unknownUsage.allowance.launches
                      : 'Unknown'}{' '}
                    launches per route
                  </p>
                  <p className="muted small">
                    Transfers require confirmed Stop and fresh consent. No writer starts
                    automatically.
                  </p>
                </>
              )}
              <p>
                Consent expires{' '}
                {capability?.expiresAt
                  ? new Date(capability.expiresAt).toLocaleString()
                  : 'Unknown'}
              </p>
              {google && (
                <p>
                  Expected native permission mode:{' '}
                  {capability?.permissionMode
                    ? permissionModeLabels[capability.permissionMode]
                    : 'Unknown'}
                </p>
              )}
              <p>
                {attestedBilling
                  ? 'Subscription login and disabled paid extra usage are user-attested.'
                  : snapshot.routes.find((route) => route.id === prepared.roles[0]?.routeId)
                        ?.billing === 'credits'
                    ? 'Existing credits explicitly allowed after included usage.'
                    : 'Ordinary usage must be available. Existing credits were not opted in.'}
              </p>
            </section>
          </>
        ) : (
          <section className="card">
            {repository ? (
              <>
                <h2>Committed repository</h2>
                <p>
                  The controller freezes the committed base and repository manifest before Start.
                </p>
                <p className="muted small">
                  The native client can edit independent scratch and run local commands. Network
                  access is disabled by this native profile. Requests needing native approval are
                  refused.
                </p>
              </>
            ) : (
              <>
                <label>
                  Committed file path
                  <input
                    autoFocus
                    value={targetPath}
                    maxLength={4096}
                    spellCheck={false}
                    placeholder="docs/providers.md"
                    onChange={(event) => {
                      setTargetPath(event.target.value);
                      resetScope();
                    }}
                  />
                </label>
                <p className="muted small">
                  Choose one existing text file in {project?.name ?? 'this project'}. The controller
                  freezes its committed base, hash and size before Start.
                </p>
              </>
            )}
            {!repository && !acpProfile && (
              <>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={handoffEnabled}
                    onChange={(event) => {
                      resetScope();
                      setHandoffEnabled(event.target.checked);
                      setHandoffTargets([]);
                    }}
                  />
                  Allow manual writer transfers
                </label>
                {handoffEnabled && (
                  <section className="view-stack" aria-label="Manual writer transfer limits">
                    <p className="muted small">
                      Choose allowed future writers. Each transfer waits for confirmed Stop and
                      fresh recipient consent. These choices do not enable automatic routing.
                    </p>
                    {profiles
                      .filter(
                        (recipient) => NativeFileProfileIdSchema.safeParse(recipient.id).success,
                      )
                      .map((recipient) => {
                        const selected = handoffTargets.find(
                          (target) => target.profileId === recipient.id,
                        );
                        return (
                          <div key={recipient.id}>
                            <label className="checkbox-label">
                              <input
                                type="checkbox"
                                checked={!!selected}
                                disabled={!recipient.available}
                                onChange={(event) => {
                                  resetScope();
                                  setHandoffTargets((targets) =>
                                    event.target.checked
                                      ? [
                                          ...targets,
                                          {
                                            profileId:
                                              recipient.id as NativeHandoffTarget['profileId'],
                                            creditPolicy: 'ordinary',
                                          },
                                        ]
                                      : targets.filter(
                                          (target) => target.profileId !== recipient.id,
                                        ),
                                  );
                                }}
                              />
                              {recipient.displayName}
                              {recipient.available ? '' : ' (unavailable)'}
                            </label>
                            {selected && recipient.id === 'openai-file-v1' && (
                              <label className="checkbox-label">
                                <input
                                  type="checkbox"
                                  checked={selected.creditPolicy === 'existing-credits'}
                                  onChange={(event) => {
                                    resetScope();
                                    setHandoffTargets((targets) =>
                                      targets.map((target) =>
                                        target.profileId === recipient.id
                                          ? {
                                              ...target,
                                              creditPolicy: event.target.checked
                                                ? 'existing-credits'
                                                : 'ordinary',
                                            }
                                          : target,
                                      ),
                                    );
                                  }}
                                />
                                Allow existing credits for this recipient
                              </label>
                            )}
                          </div>
                        );
                      })}
                    <div className="facts-grid">
                      <label>
                        Overall attempts
                        <input
                          type="number"
                          min={minimumHandoffAttempts}
                          max={100}
                          value={policy.limits.attempts}
                          onChange={(event) => {
                            resetScope();
                            setPolicy({
                              ...policy,
                              limits: { ...policy.limits, attempts: Number(event.target.value) },
                            });
                          }}
                        />
                      </label>
                      <label>
                        Overall minutes
                        <input
                          type="number"
                          min={5}
                          max={1440}
                          value={policy.limits.minutes}
                          onChange={(event) => {
                            resetScope();
                            const minutes = Number(event.target.value);
                            setPolicy({
                              ...policy,
                              limits: { ...policy.limits, minutes },
                              unknownUsage: {
                                rule: 'fixed-allowance',
                                allowance: {
                                  launches:
                                    policy.unknownUsage.rule === 'fixed-allowance'
                                      ? policy.unknownUsage.allowance.launches
                                      : 1,
                                  minutes,
                                },
                              },
                            });
                          }}
                        />
                      </label>
                      <label>
                        Launches per route
                        <input
                          type="number"
                          min={2}
                          max={100}
                          value={
                            policy.unknownUsage.rule === 'fixed-allowance'
                              ? policy.unknownUsage.allowance.launches
                              : 0
                          }
                          onChange={(event) => {
                            resetScope();
                            setPolicy({
                              ...policy,
                              unknownUsage: {
                                rule: 'fixed-allowance',
                                allowance: {
                                  launches: Number(event.target.value),
                                  minutes: policy.limits.minutes,
                                },
                              },
                            });
                          }}
                        />
                      </label>
                    </div>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => {
                        resetScope();
                        setPolicy({
                          ...policy,
                          limits: { ...policy.limits, attempts: 4, minutes: 12 },
                          unknownUsage: {
                            rule: 'fixed-allowance',
                            allowance: { launches: 2, minutes: 12 },
                          },
                        });
                      }}
                    >
                      Use two-writer limits: 4 attempts, 12 minutes, 2 launches per route
                    </button>
                    <p className="muted small">
                      Every writer spends the same original run budget. The overall attempt cap is
                      separate from each route's launch allowance. Two reserved minutes cover a
                      standard check and review; full verification needs six remaining minutes.
                    </p>
                    {!validHandoff && (
                      <p className="notice" role="status">
                        Choose at least one different writer, {minimumHandoffAttempts} overall
                        attempts and two launches per route. Review the original time limit before
                        preparing.
                      </p>
                    )}
                  </section>
                )}
              </>
            )}
            {acpProfile && (
              <>
                <p className="muted small">
                  Every native approval needs a human decision. Start reapplies and verifies these
                  exact choices before its prompt. Client filesystem and terminal capabilities are
                  disabled; this does not establish operating-system containment.
                </p>
                <label>
                  Google model
                  <select
                    value={selectedModel}
                    onChange={(event) => {
                      setModelId(event.target.value);
                      setThoughtLevelId('');
                      resetConsent();
                    }}
                  >
                    {configuration?.model.supported.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </label>
                {configuration?.thoughtLevel ? (
                  <label>
                    Google thought level
                    <select
                      value={selectedThought ?? ''}
                      onChange={(event) => {
                        setThoughtLevelId(event.target.value);
                        resetConsent();
                      }}
                    >
                      {configuration.thoughtLevel.supported.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="muted small">
                    Thought level unknown. The client advertised no thought selector.
                  </p>
                )}
                <label>
                  Google authority
                  <select
                    value={policy.authority}
                    onChange={(event) => {
                      setPolicy({
                        ...policy,
                        authority: event.target.value === 'balanced' ? 'balanced' : 'guided',
                      });
                      resetConsent();
                    }}
                  >
                    <option value="guided">Guided</option>
                    <option value="balanced">Balanced</option>
                  </select>
                </label>
                <p className="muted small">
                  All returned quota pools must be fresh and above reserve. The quota reader and ACP
                  login are separate sessions.
                </p>
                {!savedConsent && (
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={quotaAccount}
                      onChange={(event) => {
                        setQuotaAccount(event.target.checked);
                        resetConsent();
                      }}
                    />
                    I confirm quota reads and ACP sign-in use the same Google account
                  </label>
                )}
              </>
            )}
            {google && !acpProfile && (
              <>
                <label>
                  Expected native permission mode
                  <select
                    value={selectedPermissionMode ?? ''}
                    onChange={(event) => {
                      const mode = profile.permissionModes.find(
                        (value) => value === event.target.value,
                      );
                      resetScope();
                      setPermissionMode(mode ?? '');
                    }}
                  >
                    <option value="">Choose the current client setting</option>
                    {profile.permissionModes.map((mode) => (
                      <option key={mode} value={mode}>
                        {permissionModeLabels[mode]}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="muted small">
                  {selectedPermissionMode
                    ? {
                        'request-review': 'The client can ask permission for native actions.',
                        strict: 'The client uses its strict permission setting.',
                        'always-proceed': 'The client can proceed without interactive approval.',
                        'proceed-in-sandbox':
                          'The client uses its native sandbox permission setting.',
                      }[selectedPermissionMode]
                    : 'Choose the expected native permission mode.'}{' '}
                  This must match the existing client setting. CrewKite does not change it.
                  Interactive approval and tool containment remain unqualified.
                </p>
              </>
            )}
            {attestedBilling && (
              <>
                <p className="muted small">
                  These confirmations describe your existing login and settings. They are supplied
                  by you and do not change the account.
                </p>
                {savedConsent ? (
                  <p className="muted small" role="status">
                    {billingAttestation
                      ? 'Using the saved subscription login and disabled paid extra usage confirmations.'
                      : 'No matching saved billing confirmations. Use explicit consent and confirm both settings.'}
                  </p>
                ) : (
                  <>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={subscriptionLogin}
                        onChange={(event) => {
                          setSubscriptionLogin(event.target.checked);
                          resetConsent();
                        }}
                      />
                      I confirm this native login uses my existing subscription
                    </label>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={extraUsageDisabled}
                        onChange={(event) => {
                          setExtraUsageDisabled(event.target.checked);
                          resetConsent();
                        }}
                      />
                      I confirm paid extra usage is disabled for this login
                    </label>
                  </>
                )}
              </>
            )}
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={savedConsent}
                onChange={(event) => setSavedConsent(event.target.checked)}
              />
              Use saved consent for this exact {repository ? 'repository' : 'file'} and policy
            </label>
            {repository && !savedConsent && (
              <>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={nativeTools}
                    onChange={(event) => {
                      setNativeTools(event.target.checked);
                      resetConsent();
                    }}
                  />
                  Allow local commands for this run
                </label>
                <p className="muted small">
                  The native client may run multiple local commands during this bounded task. This
                  permission is consumed once when the run starts.
                </p>
              </>
            )}
            {repository && savedConsent && (
              <p className="muted small">
                Saved consent must include the exact local-command permission for this project.
              </p>
            )}
            {!savedConsent && (
              <>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={nativeTrust}
                    onChange={(event) => setNativeTrust(event.target.checked)}
                  />
                  Trust the existing native client and login
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={sourceConsent}
                    onChange={(event) => setSourceConsent(event.target.checked)}
                  />
                  {repository
                    ? 'Send this committed repository and task text; allow edits in independent scratch'
                    : 'Send this committed file and task text; allow its replacement in independent scratch'}
                </label>
              </>
            )}
            <p className="muted small">
              Native global and project guidance may apply. Tool containment remains unqualified.
              Saved consent must match the controller's exact recorded scope.
            </p>
            {!attestedBilling && (
              <>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={existingCredits}
                    disabled={
                      !profile?.creditPolicies.some((value) => value === 'existing-credits')
                    }
                    onChange={(event) => setExistingCredits(event.target.checked)}
                  />
                  Allow existing credits after included usage
                </label>
                <p className="muted small">
                  This choice does not establish a provider hard spending cap. No reset, purchase or
                  top-up is requested.
                </p>
              </>
            )}
          </section>
        )}
        <p className="notice">
          {repository
            ? 'Repository changes are retained for inspection and patch export. Native command results do not establish check evidence.'
            : 'One proposal is retained for inspection and patch export.'}{' '}
          A supported candidate can prepare separate checks and review after the writer stops, then
          request local branch acceptance with its own permission.{' '}
          {handoffEnabled && !repository
            ? 'Manual transfers require confirmed Stop and fresh recipient consent.'
            : 'Handoff remains unavailable.'}{' '}
          The original checkout stays unchanged.
        </p>
        {prepared && capability?.stage !== 'prepared' && (
          <p className="notice" role="status">
            This run cannot start again. Inspect Changes or export its retained patch.
          </p>
        )}
        {prepared && capability?.expiresAt && Date.parse(capability.expiresAt) <= Date.now() && (
          <p className="notice" role="status">
            The saved consent expired. Edit the proposal and review its permissions.
          </p>
        )}
      </div>
      <div className="dialog-footer">
        <button type="button" className="button secondary" onClick={onClose}>
          Cancel
        </button>
        {!prepared && (
          <button type="button" className="button secondary" onClick={onBack}>
            Scripted run
          </button>
        )}
        <span className="muted small">
          {profile?.maximumSubmissions ?? 1} submission per{' '}
          {handoffEnabled && !repository ? 'writer' : 'run'} ·{' '}
          {(profile?.maximumTaskMs ?? 300000) / 60000} minutes maximum ·{' '}
          {profile && 'maximumSourceFiles' in profile
            ? `${profile.maximumSourceFiles} files / ${profile.maximumSourceBytes / 1024 / 1024} MiB maximum`
            : `${(profile?.maximumFileBytes ?? 65536) / 1024} KiB maximum`}
        </span>
        {prepared ? (
          <>
            {capability?.stage === 'prepared' && (
              <button
                type="button"
                className="button secondary"
                disabled={workspace.pending}
                onClick={() => {
                  setPrepared(null);
                  resetScope();
                  setMessage(null);
                }}
              >
                Edit proposal
              </button>
            )}
            <button
              type="button"
              className="button primary"
              disabled={!startable}
              onClick={() =>
                void workspace
                  .command({
                    command: 'StartRun',
                    expectedRevision: task.revision,
                    payload: { taskId: task.id, runId: prepared.id },
                  })
                  .then((result) => {
                    if (result.outcome === 'applied') onClose();
                    else setMessage(result.next ?? 'Start was refused. Review the saved proposal.');
                  })
                  .catch(() =>
                    setMessage('Start could not be confirmed. Inspect the task before retrying.'),
                  )
              }
            >
              Start native proposal
              <ArrowRight size={14} />
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button primary"
            disabled={
              !allowed ||
              !validConsent ||
              !validTools ||
              !validBilling ||
              !validPermissionMode ||
              !validHandoff ||
              !validAcp ||
              (!repository && !NativeTargetPathSchema.safeParse(targetPath).success)
            }
            onClick={() => void prepareNative()}
          >
            Prepare native proposal
            <ArrowRight size={14} />
          </button>
        )}
      </div>
    </Dialog>
  );
}

const handoffReasons = {
  available: 'Ready for an explicit manual transfer.',
  'writer-active': 'Stop the current writer and wait for confirmed cleanup.',
  'ownership-unknown': 'Writer ownership is uncertain. No transfer can start.',
  'source-changed': 'The original source changed. Inspect it before continuing.',
  'retained-work-unavailable': 'Stopped file work is not available for transfer.',
  'recipient-unavailable': 'The saved recipient is unavailable.',
  'authority-unavailable': 'The required authority or consent is unavailable.',
  'budget-exhausted': 'The original run has insufficient remaining allowance.',
  'admissions-paused': 'Admissions are paused for this run.',
  'already-started': 'This transfer has already started.',
};

export function NativeHandoff({ task, snapshot, workspace, onClose }: LaunchProps) {
  const native = snapshot.nativeRuns.find((value) => value.runId === task.runId);
  const run = snapshot.runs.find((value) => value.id === task.runId);
  const handoff = native?.handoff;
  const [recipientId, setRecipientId] = useState('');
  const [nativeTrust, setNativeTrust] = useState(false);
  const [sourceConsent, setSourceConsent] = useState(false);
  const [existingCredits, setExistingCredits] = useState(false);
  const [subscriptionLogin, setSubscriptionLogin] = useState(false);
  const [extraUsageDisabled, setExtraUsageDisabled] = useState(false);
  const [permissionMode, setPermissionMode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  if (!native || !run || !handoff) return null;
  const recipient = handoff.targets.find((value) => value.profileId === recipientId);
  const profile = snapshot.nativeProfiles
    .filter((value) => value.family !== 'local')
    .find((value) => value.id === recipient?.profileId);
  const google = profile?.family === 'google';
  const attested = profile?.family === 'anthropic' || google;
  const pending = handoff.pending;
  const connected =
    workspace.connection === 'connected' && !workspace.preview && !workspace.pending;
  const permitted =
    connected &&
    handoff.prepare.available &&
    profile?.available &&
    nativeTrust &&
    sourceConsent &&
    !!recipient &&
    (recipient.creditPolicy !== 'existing-credits' || existingCredits) &&
    (!attested || (subscriptionLogin && extraUsageDisabled)) &&
    (!google || profile.permissionModes.some((value) => value === permissionMode));
  function resetConsent() {
    setNativeTrust(false);
    setSourceConsent(false);
    setExistingCredits(false);
    setSubscriptionLogin(false);
    setExtraUsageDisabled(false);
    setPermissionMode('');
    setMessage(null);
  }
  async function prepare() {
    if (!permitted || !recipient || !profile || !task.runId || !handoff) return;
    const result = await workspace.command({
      command: 'PrepareNativeHandoff',
      expectedRevision: task.revision,
      payload: NativeHandoffPreparationPayloadSchema.parse({
        taskId: task.id,
        runId: task.runId,
        fromAttemptId: handoff.currentAttemptId,
        ...recipient,
        consent: 'explicit',
        ...(attested
          ? {
              billingAttestation: {
                source: 'user-attested',
                subscriptionLoginConfirmed: true,
                paidExtraUsageDisabled: true,
              },
            }
          : {}),
        ...(google ? { permissionMode } : {}),
      }),
    });
    setMessage(
      result.outcome === 'applied' || result.outcome === 'already-applied'
        ? 'Transfer prepared. Review the saved recipient before Start.'
        : (result.next ?? 'Preparation was refused. Inspect the current task.'),
    );
  }
  return (
    <Dialog
      title="Continue with another writer"
      eyebrow="MANUAL FILE TRANSFER"
      onClose={onClose}
      wide
    >
      <div className="launch-content view-stack">
        {message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
        <section className="card">
          <h2>Retained unverified work</h2>
          <code>{native.target?.path ?? 'Unavailable target'}</code>
          <p>
            Inspect Changes before sending this retained file and task packet to another writer. A
            transfer starts a fresh native task after the previous writer is proven stopped.
          </p>
          <p className="muted small">
            Original limits: {run.policy.policy.limits.attempts} overall attempts and{' '}
            {run.policy.policy.limits.minutes} minutes. Every writer spends this same budget. This
            view cannot replenish it. The controller rechecks the remaining allowance; full
            verification needs six remaining minutes.
          </p>
          <p className="notice" role="status">
            {handoffReasons[pending?.start.reason ?? handoff.prepare.reason]}
          </p>
          <details className="technical-details">
            <summary>Writer and packet identity</summary>
            <code>Current attempt {handoff.currentAttemptId}</code>
            <code>Generation {handoff.generation}</code>
            {pending && (
              <>
                <code>Packet {pending.packetId}</code>
                <code>Preparation {pending.preparationId}</code>
                <code>Retained base {pending.baseHash}</code>
              </>
            )}
          </details>
        </section>
        {pending ? (
          <section className="card" aria-label="Prepared writer transfer">
            <h2>Prepared recipient</h2>
            <p>
              {snapshot.nativeProfiles.find((value) => value.id === pending.recipient.profileId)
                ?.displayName ?? pending.recipient.profileId}
            </p>
            <p>
              {pending.bytes} retained unverified bytes · generation {pending.generation}
            </p>
            <p>
              {pending.recipient.creditPolicy === 'existing-credits'
                ? 'Existing credits explicitly allowed for this recipient.'
                : 'Ordinary usage only. Existing credits are not allowed.'}
            </p>
            <p>Consent expires {new Date(pending.expiresAt).toLocaleString()}</p>
            <p className="muted small">
              Reopening does not submit work. Start consumes this exact saved preparation once. Stop
              cancels the pending transfer.
            </p>
          </section>
        ) : (
          <section className="card">
            <label>
              Previously allowed recipient
              <select
                value={recipientId}
                onChange={(event) => {
                  resetConsent();
                  setRecipientId(event.target.value);
                }}
              >
                <option value="">Choose a recipient</option>
                {handoff.targets
                  .filter((value) => value.profileId !== native.profileId)
                  .map((value) => {
                    const option = snapshot.nativeProfiles.find(
                      (profile) => profile.id === value.profileId,
                    );
                    return (
                      <option
                        key={value.profileId}
                        value={value.profileId}
                        disabled={!option?.available}
                      >
                        {option?.displayName ?? value.profileId}
                        {option?.available ? '' : ' (unavailable)'}
                      </option>
                    );
                  })}
              </select>
            </label>
            {profile && (
              <p className="muted small">
                {profile.model} · {profile.effort} requested effort ·{' '}
                {profile.family === 'openai' ? profile.serviceTier : 'unknown'} service tier.
                Required metadata is checked at Start. A provider hard spending cap remains
                unverified.
              </p>
            )}
            {google && (
              <label>
                Expected native permission mode
                <select
                  value={permissionMode}
                  onChange={(event) => {
                    resetConsent();
                    setPermissionMode(event.target.value);
                  }}
                >
                  <option value="">Choose the current client setting</option>
                  {profile.permissionModes.map((value) => (
                    <option key={value} value={value}>
                      {permissionModeLabels[value]}
                    </option>
                  ))}
                </select>
                <span className="muted small">
                  This must match the existing native setting. CrewKite changes no account or global
                  setting.
                </span>
              </label>
            )}
            {attested && (
              <>
                <p className="muted small">
                  These are fresh recipient confirmations supplied by you. Account entitlement and
                  request billing remain unknown.
                </p>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={subscriptionLogin}
                    onChange={(event) => {
                      setSubscriptionLogin(event.target.checked);
                      setNativeTrust(false);
                      setSourceConsent(false);
                      setExistingCredits(false);
                    }}
                  />
                  I confirm this native login uses my existing subscription
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={extraUsageDisabled}
                    onChange={(event) => {
                      setExtraUsageDisabled(event.target.checked);
                      setNativeTrust(false);
                      setSourceConsent(false);
                      setExistingCredits(false);
                    }}
                  />
                  I confirm paid extra usage is disabled for this login
                </label>
              </>
            )}
            {recipient?.creditPolicy === 'existing-credits' && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={existingCredits}
                  onChange={(event) => {
                    setExistingCredits(event.target.checked);
                    setNativeTrust(false);
                    setSourceConsent(false);
                  }}
                />
                Allow the saved existing-credit policy for this recipient
              </label>
            )}
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={nativeTrust}
                onChange={(event) => setNativeTrust(event.target.checked)}
              />
              Trust this recipient's existing native client and login
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={sourceConsent}
                onChange={(event) => setSourceConsent(event.target.checked)}
              />
              Send the retained unverified file and task packet to this recipient; allow its
              replacement in independent scratch
            </label>
            <p className="muted small">
              Preparation records your chosen successor writer. It adds no automatic fallback,
              review or acceptance authority.
            </p>
          </section>
        )}
      </div>
      <div className="dialog-footer">
        <button type="button" className="button secondary" onClick={onClose}>
          Close
        </button>
        {pending ? (
          <>
            <button
              type="button"
              className="button secondary"
              disabled={!connected}
              onClick={() =>
                void workspace
                  .command({
                    command: 'StopRun',
                    expectedRevision: task.revision,
                    payload: { taskId: task.id, runId: run.id },
                  })
                  .then((result) => {
                    if (result.outcome === 'applied' || result.outcome === 'already-applied')
                      onClose();
                    else
                      setMessage(result.next ?? 'Stop was refused. Inspect the pending transfer.');
                  })
                  .catch(() =>
                    setMessage('Stop could not be confirmed. Inspect the task before retrying.'),
                  )
              }
            >
              Cancel transfer
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!connected || !pending.start.available}
              onClick={() =>
                void workspace
                  .command({
                    command: 'StartNativeHandoff',
                    expectedRevision: task.revision,
                    payload: {
                      taskId: task.id,
                      runId: run.id,
                      preparationId: pending.preparationId,
                    },
                  })
                  .then((result) => {
                    if (result.outcome === 'applied' || result.outcome === 'already-applied')
                      onClose();
                    else
                      setMessage(result.next ?? 'Start was refused. Inspect the saved transfer.');
                  })
                  .catch(() =>
                    setMessage('Start could not be confirmed. Inspect the task before retrying.'),
                  )
              }
            >
              Start writer transfer
              <ArrowRight size={14} />
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button primary"
            disabled={!permitted}
            onClick={() =>
              void prepare().catch(() =>
                setMessage('Preparation could not be confirmed. Inspect the task before retrying.'),
              )
            }
          >
            Prepare writer transfer
            <ArrowRight size={14} />
          </button>
        )}
      </div>
    </Dialog>
  );
}

function ScriptedLaunch({
  task,
  snapshot,
  workspace,
  onClose,
  onNative,
}: {
  onNative: (scope: 'file' | 'repository') => void;
  task: Task;
  snapshot: Snapshot;
  workspace: Workspace;
  onClose: () => void;
}) {
  const fixtures = createDemoFixtures();
  const project = snapshot.projects.find(({ id }) => id === task.projectId);
  const qualified = snapshot.routes.filter(({ qualified }) => qualified);
  const find = (family: string) => qualified.find((route) => route.family === family)?.id;
  const executable = qualified.filter(({ fake }) => fake);
  const builder = executable.find(({ family }) => family === 'anthropic')?.id ?? executable[0]?.id;
  const reviewer =
    executable.find(({ id }) => id !== builder)?.id ??
    executable.find(({ id }) => id === builder)?.id;
  const [team, setTeam] = useState<string>('Formation');
  const [section, setSection] = useState<'Team' | 'Policy' | 'Methods'>('Team');
  const [roles, setRoles] = useState<Role[]>(
    builder
      ? [
          {
            role: 'coder',
            selection: 'ordered',
            routeId: builder,
            pinned: false,
            approvedFallbacks: reviewer && reviewer !== builder ? [reviewer] : [],
          },
          ...(reviewer
            ? [
                {
                  role: 'reviewer' as const,
                  selection: 'ordered' as const,
                  routeId: reviewer,
                  pinned: true,
                  approvedFallbacks: [],
                },
              ]
            : []),
        ]
      : [],
  );
  const [policy, setPolicy] = useState<Policy>(() => ({
    ...fixtures.policy,
    authority: 'guided',
    quality: 'standard',
    limits: { ...fixtures.policy.limits, attempts: 6, concurrency: 1 },
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
  const [methods, setMethods] = useState<Method[]>(
    requiredReviewMethodIds('standard').map((id) => ({ id, cycles: 1, reviewerRole: 'reviewer' })),
  );
  const [customMethods, setCustomMethods] = useState(false);
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
  const [inspection, setInspection] = useState<{
    source: Run['source'];
    details: SourceDetails;
    receivedAt: string;
  } | null>(null);
  const [prepared, setPrepared] = useState<Run | null>(
    snapshot.nativeRuns.some((run) => run.runId === task.runId)
      ? null
      : (snapshot.runs.find(({ id }) => id === task.runId) ?? null),
  );
  const requiredMethods = requiredReviewMethodIds(policy.quality);
  const resolvedMethods = [...methods];
  for (const id of requiredMethods) {
    if (!resolvedMethods.some((method) => method.id === id))
      resolvedMethods.push({
        id,
        cycles: 1,
        reviewerRole:
          id === 'second-opinion' || roles.some(({ role }) => role === 'reviewer')
            ? 'reviewer'
            : 'advisor',
      });
  }
  const methodOrder = requiredReviewMethodIds('thorough');
  resolvedMethods.sort((a, b) => methodOrder.indexOf(a.id) - methodOrder.indexOf(b.id));
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
        if (active && result.data?.kind === 'source') {
          setSource(result.data.source);
          if (result.data.details)
            setInspection({
              source: result.data.source,
              details: result.data.details,
              receivedAt: new Date().toISOString(),
            });
        }
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
  const unsupportedPanel = resolvedMethods.some(({ id }) => id === 'round-robin');
  const ineligibleReview = resolvedMethods.some(
    ({ id, reviewerRole }) => id === 'second-opinion' && reviewerRole !== 'reviewer',
  );
  const fixedAllowanceMismatch =
    policy.unknownUsage.rule === 'fixed-allowance' &&
    policy.unknownUsage.allowance.minutes < policy.limits.minutes;
  const canPrepare =
    source &&
    !fixedAllowanceMismatch &&
    !unsupportedPanel &&
    !ineligibleReview &&
    roles.some(({ role }) => role === 'coder') &&
    unavailable.length === 0 &&
    !unmappedReserves &&
    !missingReviewer &&
    policy.limits.attempts >= minimumAttempts &&
    (!resolvedMethods.length || reviewExecutionReady);

  function applyBuiltin(name: TeamName) {
    setTeam(name);
    setCustomMethods(false);
    setCustomGates(false);
    setReviewGates({});
    setPrepared(null);
    setMessage(null);
    const selected: Role[] =
      builder && name !== 'Custom'
        ? [
            {
              role: 'coder',
              selection: 'ordered',
              routeId: builder,
              pinned: false,
              approvedFallbacks: reviewer && reviewer !== builder ? [reviewer] : [],
            },
          ]
        : [];
    if (reviewer && name !== 'Custom')
      selected.push({
        role: 'reviewer',
        selection: 'ordered',
        routeId: reviewer,
        pinned: true,
        approvedFallbacks: [],
      });
    const architect = find('google');
    if (architect && name === 'Expedition')
      selected.push({
        role: 'lead',
        selection: 'ordered',
        routeId: architect,
        pinned: false,
        approvedFallbacks: [],
      });
    setRoles(selected);
    setPolicy((value) => ({
      ...value,
      effects: value.effects.map((grant) => ({ ...grant, usesRemaining: 0 })),
    }));
    setMethods(
      requiredReviewMethodIds(
        name === 'Glide' ? 'quick' : name === 'Expedition' ? 'thorough' : 'standard',
      ).map((id) => ({ id, cycles: 1, reviewerRole: 'reviewer' })),
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
                selection: existing ? (existing.selection ?? 'reset-aware') : 'ordered',
                routeId,
                pinned: existing?.pinned ?? false,
                approvedFallbacks: existing?.approvedFallbacks.filter((id) => id !== routeId) ?? [],
              },
            ]
          : []),
      ];
    });
  }
  function moveFallback(role: Role['role'], id: string, direction: -1 | 1) {
    setRoles((current) =>
      current.map((entry) => {
        if (entry.role !== role) return entry;
        const order = [...entry.approvedFallbacks];
        const index = order.indexOf(id);
        const next = index + direction;
        if (index < 0 || next < 0 || next >= order.length) return entry;
        [order[index], order[next]] = [order[next], order[index]];
        return { ...entry, approvedFallbacks: order };
      }),
    );
  }
  function applySaved(value: SavedTeam) {
    setTeam(value.name);
    setCustomMethods(true);
    setPrepared(null);
    setMessage(null);
    setRoles(structuredClone(value.roles));
    const plan = value.preferences;
    setCustomGates(true);
    setReviewGates(
      Object.fromEntries(
        value.gates.flatMap((gate) =>
          gate.methodId !== undefined && gate.cycle !== undefined
            ? [[formatReviewTarget({ methodId: gate.methodId, cycle: gate.cycle }), gate.mode]]
            : [],
        ),
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
          const target = formatReviewTarget({ methodId: method.id, cycle: index + 1 });
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
            formatReviewTarget({ methodId: method.id, cycle: index + 1 }),
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
  const canEditPrepared =
    prepared &&
    task.runId === prepared.id &&
    task.state === 'draft' &&
    !snapshot.attempts.some(({ runId }) => runId === prepared.id) &&
    !snapshot.approvals.some(
      (approval) => approval.taskId === task.id && approval.status === 'pending',
    );
  function editPrepared() {
    if (!canEditPrepared) return;
    const savedPolicy = structuredClone(prepared.policy.policy);
    setRoles(structuredClone(prepared.roles));
    setPolicy({
      ...savedPolicy,
      effects: savedPolicy.effects.map((grant) => ({ ...grant, usesRemaining: 0, revoked: false })),
    });
    setMethods(savedPolicy.methods ?? []);
    setGuidance(savedPolicy.guidance ?? { goal: task.outcome, principles: [...principles] });
    setReviewGates({});
    setCustomGates(true);
    setCustomMethods(true);
    setTeam('Custom');
    setPrepared(null);
    setSection('Policy');
    setMessage(
      'Saved settings are ready to edit. Review the configuration again before starting. Previous automatic permissions are not reused.',
    );
  }
  function launchFailure(reason: string | undefined) {
    return (
      {
        'draft-has-pending-work':
          'This draft has pending work or approval. Stop or resolve it before editing.',
        'prepared-run-started':
          'This run has already started. Its saved settings cannot be edited.',
        'run-not-current': 'The task changed. Close this window and reopen its current run.',
      }[reason ?? ''] ??
      reason ??
      'The controller could not complete this action.'
    );
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
      if (result.outcome === 'applied' && run.success) {
        setPrepared(run.data);
        setMessage(null);
      } else setMessage(launchFailure(result.reason));
    } catch {
      setMessage(
        'The controller could not confirm preparation. Check the connection before trying again.',
      );
    }
  }
  return (
    <Dialog
      title={prepared ? 'Review the prepared run' : 'Configure this run'}
      eyebrow={prepared ? 'REVIEW BEFORE START' : 'TEAM, PERMISSIONS AND REVIEW'}
      onClose={onClose}
      wide
    >
      {!prepared && (
        <div className="button-row">
          <button type="button" className="button secondary" onClick={() => onNative('file')}>
            Native file proposal
            <ArrowRight size={14} />
          </button>
          <button type="button" className="button secondary" onClick={() => onNative('repository')}>
            Repository work
            <ArrowRight size={14} />
          </button>
        </div>
      )}
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
        {snapshot.usage.some(
          ({ state, observation }) => state === 'stale' && observation.source === 'fixture',
        ) && (
          <p className="notice">
            <Info size={14} />
            Scripted usage expires after five minutes and does not refresh automatically.{' '}
            {prepared
              ? 'This prepared run keeps its saved usage policy.'
              : 'Review Policy > Unknown usage before resolving. Waiting requires fresh observations; a finite fallback permits only the displayed allowance.'}
          </p>
        )}
        {inspection && (
          <CurrentCheckoutChanges
            source={inspection.source}
            details={inspection.details}
            receivedAt={inspection.receivedAt}
          />
        )}
        {prepared ? (
          <>
            {task.runId !== prepared.id && (
              <p className="notice">
                <Info size={14} />
                The task configuration changed. Close this window and reopen its current run.
              </p>
            )}
            <SourceFacts source={prepared.source} />
            <RouterCard run={prepared} routes={snapshot.routes} usage={snapshot.usage} />
            {!prepared.decision.chosen && canEditPrepared && (
              <p className="notice">
                <Info size={14} />
                No route can start under these saved settings. Edit configuration to review the
                usage fallback and limits. Scripted observations do not refresh automatically.
              </p>
            )}
            <section className="card">
              <div className="section-heading">
                <h2>Permissions</h2>
                <span>Saved for this run</span>
              </div>
              <EffectSummary
                policy={prepared.policy.policy}
                task={task}
                projectName={project?.name}
              />
              {prepared.policy.policy.effects.length > 0 && (
                <p className="muted small">
                  Permissions expire{' '}
                  {new Date(
                    Math.min(
                      ...prepared.policy.policy.effects.map((grant) => Date.parse(grant.expiresAt)),
                    ),
                  ).toLocaleString()}
                  .{' '}
                  <Help label="permission expiry">
                    This shows the earliest permission expiry. Each permission keeps its own saved
                    expiry. Editing the configuration requires another review and new permissions
                    before starting.
                  </Help>
                </p>
              )}
              <div className="resolved-limits">
                <span>{prepared.policy.policy.limits.attempts} total attempts</span>
                <span>{prepared.policy.policy.limits.minutes} minutes across attempts</span>
                <span>{prepared.policy.policy.limits.concurrency} simultaneous worker maximum</span>
              </div>
            </section>
            <div className="launch-warning">
              <ShieldCheck size={17} />
              <p>
                Start uses these saved settings. Team preference changes apply to another run. Used
                or withdrawn permissions stay unavailable.
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
                    const efforts = candidates.filter(
                      (value) =>
                        value.model === route?.model &&
                        value.billing === route?.billing &&
                        value.speed?.requested === route?.speed?.requested,
                    );
                    const speedVariant = (speed: 'normal' | 'fast') =>
                      candidates.find(
                        (value) =>
                          value.model === route?.model &&
                          value.billing === route?.billing &&
                          value.effort.requested === route?.effort.requested &&
                          value.effort.effective === route?.effort.effective &&
                          value.speed?.requested === speed &&
                          value.speed.effective === speed &&
                          value.speed.supported.includes(speed),
                      );
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
                              <fieldset className="speed-options">
                                <legend>
                                  Speed{' '}
                                  <Help label="model speed">
                                    Speed is separate from reasoning effort. A choice is enabled
                                    only when this model and effort have an exact qualified route
                                    for that speed. Missing metadata leaves speed unavailable.
                                  </Help>
                                </legend>
                                {route?.speed ? (
                                  <div>
                                    {(['normal', 'fast'] as const).map((speed) => {
                                      const variant = speedVariant(speed);
                                      return (
                                        <label key={speed} className="speed-choice">
                                          <input
                                            type="radio"
                                            name={`speed-${role}`}
                                            aria-label={`${roleLabels[role]} ${speed} speed`}
                                            checked={route?.speed?.requested === speed}
                                            disabled={!variant}
                                            onChange={() => {
                                              if (variant) changeRole(role, variant.id);
                                            }}
                                          />
                                          {speed === 'normal' ? 'Normal' : 'Fast'}
                                        </label>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <small>Speed not reported</small>
                                )}
                                {route?.speed && !speedVariant('fast') && (
                                  <small>No qualified Fast route for this model and effort.</small>
                                )}
                              </fieldset>
                            </div>
                            <div className="assignment-options">
                              <div className="pin-control">
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
                                <Help label={`${roleLabels[role]} route pin`}>
                                  Keep this primary route while it is eligible. Only saved fallbacks
                                  may replace it when allowance, capacity or another gate blocks it.
                                  A pin cannot bypass limits or approvals.
                                </Help>
                              </div>
                              <span>1 worker at a time</span>
                            </div>
                            <label className="route-selection">
                              Route selection
                              <select
                                aria-label={`${roleLabels[role]} route selection`}
                                value={assignment.selection ?? 'reset-aware'}
                                onChange={(event) =>
                                  setRoles((current) =>
                                    current.map((entry) =>
                                      entry.role === role
                                        ? {
                                            ...entry,
                                            selection: event.target.value as
                                              | 'ordered'
                                              | 'reset-aware',
                                          }
                                        : entry,
                                    ),
                                  )
                                }
                              >
                                <option value="ordered">Saved order</option>
                                <option value="reset-aware">Allowance reset timing</option>
                              </select>
                            </label>
                            <details className="fallback-details">
                              <summary>
                                {assignment.approvedFallbacks.length} approved fallback(s)
                                <ChevronRight size={12} />
                              </summary>
                              <div>
                                <p className="fallback-help">
                                  {assignment.selection === 'ordered'
                                    ? 'Eligible routes follow the primary and numbered fallback order. Limits and pins still apply.'
                                    : 'Reset timing and eligibility determine selection. Saved order breaks ties.'}
                                </p>
                                <ol className="fallback-order">
                                  {assignment.approvedFallbacks.map((id, index) => {
                                    const value = qualified.find((route) => route.id === id);
                                    const name = value
                                      ? `${familyName(value.family)} · ${value.model} · ${value.effort.effective}`
                                      : 'Unavailable route';
                                    return (
                                      <li key={id}>
                                        <span className="fallback-number" aria-hidden="true">
                                          {index + 1}
                                        </span>
                                        <label className="checkbox-label">
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
                                                            (routeId) => routeId !== id,
                                                          ),
                                                      }
                                                    : entry,
                                                ),
                                              )
                                            }
                                          />
                                          {name}
                                        </label>
                                        <div className="fallback-move">
                                          <button
                                            type="button"
                                            className="icon-button"
                                            disabled={index === 0}
                                            aria-label={`Move ${name} fallback earlier`}
                                            onClick={() => moveFallback(role, id, -1)}
                                          >
                                            <ArrowUp size={12} />
                                          </button>
                                          <button
                                            type="button"
                                            className="icon-button"
                                            disabled={
                                              index === assignment.approvedFallbacks.length - 1
                                            }
                                            aria-label={`Move ${name} fallback later`}
                                            onClick={() => moveFallback(role, id, 1)}
                                          >
                                            <ArrowDown size={12} />
                                          </button>
                                        </div>
                                      </li>
                                    );
                                  })}
                                </ol>
                                {qualified
                                  .filter(
                                    ({ id }) =>
                                      id !== assignment.routeId &&
                                      !assignment.approvedFallbacks.includes(id),
                                  )
                                  .map((value) => (
                                    <label className="checkbox-label" key={value.id}>
                                      <input
                                        type="checkbox"
                                        checked={false}
                                        onChange={() =>
                                          setRoles((current) =>
                                            current.map((entry) =>
                                              entry.role === role
                                                ? {
                                                    ...entry,
                                                    approvedFallbacks: [
                                                      ...entry.approvedFallbacks,
                                                      value.id,
                                                    ],
                                                  }
                                                : entry,
                                            ),
                                          )
                                        }
                                      />
                                      Add {familyName(value.family)} · {value.model} ·{' '}
                                      {value.effort.effective}
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
                  D0 uses a finite fake catalog and one writer per task. Checks and review jobs
                  share the run's limits. Assigning a role does not start another worker.
                </p>
              </>
            )}
            {section === 'Policy' && (
              <>
                <section className="card">
                  <div className="section-heading">
                    <h2>
                      <ShieldCheck size={15} />
                      Action approvals
                      <Help label="automatic approval">
                        Automatic permits one named action for this task and exact target until its
                        expiry. Used or revoked permission cannot be reused. A saved team stores
                        preferences; it grants no permission to a new run.
                      </Help>
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
                        onChange={(event) => {
                          const quality = event.target.value as Policy['quality'];
                          setPolicy({ ...policy, quality });
                          setMethods(
                            requiredReviewMethodIds(quality).map((id) => ({
                              id,
                              cycles: 1,
                              reviewerRole:
                                id === 'second-opinion' ||
                                roles.some(({ role }) => role === 'reviewer')
                                  ? 'reviewer'
                                  : 'advisor',
                            })),
                          );
                          setCustomMethods(false);
                        }}
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
                          <strong>{actionName(grant.action)}</strong>
                          <span className="effect-target">
                            {effectTarget(grant, task, project?.name)}
                          </span>
                          <details className="technical-details">
                            <summary>Details</summary>
                            <code>
                              {grant.action} · {grant.target}
                            </code>
                          </details>
                        </div>
                        <select
                          aria-label={`${actionName(grant.action)}: ${effectTarget(grant, task, project?.name)} approval gate`}
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
                          <option value="once">Automatic</option>
                        </select>
                      </div>
                    ))}
                  </div>
                  <p className="muted small">
                    Automatic permissions expire and stay limited to the named action. Editing an
                    approval setting creates custom settings.
                  </p>
                </section>
                <section className="card">
                  <div className="section-heading">
                    <h2>
                      Allowance reserves{' '}
                      <Help label="allowance windows and reserves">
                        Each allowance window belongs to its reported provider and account. A
                        reserve keeps part of that allowance unused. For a percentage window, a 5%
                        reserve stops new work before it would spend below 5%. Different windows and
                        providers keep their own units. A reset needs a fresh report before
                        allowance can be used again.
                      </Help>
                    </h2>
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
                            Allowance window
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
                    <h2>
                      Hard limits{' '}
                      <Help label="run limits">
                        Attempts count writer launches, checks and review jobs. Minutes combine
                        their elapsed time from when each is allowed to start. Each attempt rounds
                        up to a whole minute. Resuming uses only remaining minutes. D0 permits one
                        simultaneous writer.
                      </Help>
                    </h2>
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
                      Simultaneous writers
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
                        <option value="fixed-allowance">
                          Limit unknown usage to 1 launch and 5 min
                        </option>
                        <option value="manual">Allow selected routes within run limits</option>
                      </select>
                    </label>
                  </div>
                  {policy.unknownUsage.rule === 'fixed-allowance' && (
                    <p className="notice">
                      <Info size={14} />
                      <span>
                        This choice permits {policy.unknownUsage.allowance.launches} launch(s) per
                        unknown route, including checks and reviews.{' '}
                        {fixedAllowanceMismatch
                          ? `Lower Minutes to ${policy.unknownUsage.allowance.minutes} or less, or choose Allow selected routes within run limits. The current ${policy.limits.minutes}-minute plan cannot start with this allowance.`
                          : 'It can stop work before all selected reviews finish.'}
                      </span>
                    </p>
                  )}
                  <p className="muted small">
                    Source preservation and failed-check blocking are controller-enforced
                    boundaries.{' '}
                    <Help label="unknown usage">
                      Wait blocks new work until observations are fresh. The finite choice limits
                      each unknown route to one launch and five minutes, including checks and
                      reviews. Allow selected routes permits saved team routes despite missing or
                      stale reports, within the run's remaining limits. Reserves and pins still
                      apply.
                    </Help>
                  </p>
                </section>
                <section className="card guidance-card">
                  <div className="section-heading">
                    <h2>
                      Goal and working principles{' '}
                      <Help label="working principles">
                        These preferences guide the plan and reviews. They grant no permission.
                        Source preservation and failed-check blocking remain enforced even when
                        their guidance boxes are unchecked. Dependency and configuration review is
                        advisory in D0.
                      </Help>
                    </h2>
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
                  <h3>Choose the review this task needs</h3>
                  <span className="fake-tag">
                    {customMethods
                      ? 'Custom review settings'
                      : `${policy.quality[0].toUpperCase()}${policy.quality.slice(1)} review preset`}
                  </span>
                  <p>
                    Each enabled method names a review role and a finite round cap. Its jobs share
                    the run's limits and inspect a read-only candidate copy.
                  </p>
                  <p className="method-role-help">
                    Reviewer supplies the independent review that Standard and Thorough require.
                    Advisor can run a simplicity or assumptions lens. Both stay within the same
                    read-only review permissions. Assign the role to a qualified scripted route in
                    Team.
                  </p>
                </div>
                <div className="method-grid">
                  {methodCatalog.map((method) => {
                    const selected = resolvedMethods.find(({ id }) => id === method.id);
                    const required = requiredMethods.includes(method.id);
                    const eligibleRoles = (['reviewer', 'advisor'] as const).filter(
                      (role) =>
                        (method.id !== 'second-opinion' || role === 'reviewer') &&
                        roles.some(
                          (assignment) =>
                            assignment.role === role &&
                            qualified.some(
                              (route) => route.id === assignment.routeId && route.fake,
                            ),
                        ),
                    );
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
                            disabled={required || (method.id === 'round-robin' && !selected)}
                            onChange={(event) => {
                              setCustomMethods(true);
                              setMethods((current) =>
                                event.target.checked
                                  ? [
                                      ...current,
                                      { id: method.id, cycles: 1, reviewerRole: 'reviewer' },
                                    ]
                                  : current.filter(({ id }) => id !== method.id),
                              );
                            }}
                          />
                          <strong>{method.name}</strong>
                          {required && <span className="fake-tag">Required by quality</span>}
                        </label>
                        <p>
                          {method.id === 'round-robin'
                            ? 'Needs an ordered review panel. Not available in this build.'
                            : method.description}
                        </p>
                        {method.id === 'round-robin' && selected && (
                          <p className="method-blocker">
                            Remove this method before preparing another run. The saved selection has
                            been retained.
                          </p>
                        )}
                        <span className="method-credit">Method influence: {method.credit}</span>
                        {selected && (
                          <>
                            <div className="method-controls">
                              <label>
                                Round cap
                                <select
                                  value={selected.cycles}
                                  onChange={(event) => {
                                    setCustomMethods(true);
                                    setMethods(
                                      resolvedMethods.map((value) =>
                                        value.id === method.id
                                          ? { ...value, cycles: Number(event.target.value) }
                                          : value,
                                      ),
                                    );
                                  }}
                                >
                                  {[1, 2, 3].map((count) => (
                                    <option key={count} value={count}>
                                      {count} round{count === 1 ? '' : 's'}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                Role
                                <select
                                  value={selected.reviewerRole}
                                  onChange={(event) => {
                                    setCustomMethods(true);
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
                                    );
                                  }}
                                >
                                  {!eligibleRoles.includes(selected.reviewerRole) && (
                                    <option value={selected.reviewerRole} disabled>
                                      {selected.reviewerRole === 'reviewer'
                                        ? 'Reviewer'
                                        : 'Advisor'}{' '}
                                      unavailable for this method
                                    </option>
                                  )}
                                  {eligibleRoles.map((role) => (
                                    <option key={role} value={role}>
                                      {role === 'reviewer' ? 'Reviewer' : 'Advisor'}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </div>
                            <p className={route ? 'method-route' : 'method-blocker'}>
                              {route
                                ? `${familyName(route.family)} · ${route.model} · ${route.effort.effective} effort`
                                : 'Assign this role in Team before resolving.'}
                            </p>
                            {route && (
                              <p className="muted small">
                                {route.id === roles.find(({ role }) => role === 'coder')?.routeId
                                  ? 'This role uses the Builder route in a separate review invocation.'
                                  : 'This role uses a separate route. Model diversity is not established.'}
                              </p>
                            )}
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
            {minimumAttempts - 2} scripted review round(s). A handoff needs another writer attempt.
          </p>
        )}
        {!prepared &&
          policy.limits.attempts >= minimumAttempts &&
          policy.limits.attempts < recoveryAttempts && (
            <p className="notice">
              <Info size={14} />
              The scripted handoff and restart walkthrough needs {recoveryAttempts} attempts,
              including all selected review rounds. Raise the visible limit before preparing that
              walkthrough.
            </p>
          )}
        {!prepared && ineligibleReview && (
          <p className="notice">
            <Info size={14} />
            Second opinion needs the Reviewer role. Choose an eligible Reviewer in Methods.
          </p>
        )}
        {!prepared && unsupportedPanel && (
          <p className="notice">
            <Info size={14} />
            Remove Round-robin before preparing a new run. This build has no ordered review panel.
          </p>
        )}
        {!prepared && missingReviewer && (
          <p className="notice">
            <Info size={14} />
            An enabled method needs its selected Reviewer or Advisor assigned in Team.
          </p>
        )}
      </div>
      <div className="dialog-footer">
        <button type="button" className="button secondary" onClick={onClose}>
          Cancel
        </button>
        {prepared ? (
          <>
            {canEditPrepared && (
              <button
                type="button"
                className="button secondary"
                disabled={workspace.pending}
                onClick={editPrepared}
              >
                Edit configuration
              </button>
            )}
            <button
              type="button"
              className="button primary"
              disabled={
                workspace.pending || task.runId !== prepared.id || !prepared.decision.chosen
              }
              onClick={() =>
                void workspace
                  .command({
                    command: 'StartRun',
                    expectedRevision: task.revision,
                    payload: { taskId: task.id, runId: prepared.id },
                  })
                  .then((result) => {
                    if (result.outcome === 'applied') onClose();
                    else setMessage(launchFailure(result.reason));
                  })
                  .catch(() =>
                    setMessage(
                      'The controller could not confirm start. Check the task state before trying again.',
                    ),
                  )
              }
            >
              Start run
              <ArrowRight size={14} />
            </button>
          </>
        ) : (
          <>
            <span className="muted small">
              Minimum {minimumAttempts} attempts · Configured {policy.limits.attempts}.
              <br />
              Review rounds share this limit.
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

function EffectSummary({
  policy,
  task,
  projectName,
}: {
  policy: Policy;
  task: Task;
  projectName?: string;
}) {
  return (
    <div className="effect-summary">
      {policy.effects.map((grant) => (
        <div key={`${grant.action}-${grant.target}`}>
          <span>
            {grant.usesRemaining === 1 ? <Check size={13} /> : <ShieldCheck size={13} />}
            {actionName(grant.action)}
          </span>
          <div>
            <span>{effectTarget(grant, task, projectName)}</span>
            <details className="technical-details">
              <summary>Details</summary>
              <code>
                {grant.action} · {grant.target}
              </code>
            </details>
          </div>
          <strong>{grant.usesRemaining === 1 ? 'Automatic' : 'Manual approval'}</strong>
        </div>
      ))}
    </div>
  );
}
