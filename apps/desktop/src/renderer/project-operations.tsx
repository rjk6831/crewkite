import type { Artifact } from '@crewkite/contracts';
import { GitPullRequest, Play, RefreshCw, ShieldCheck, Square, Terminal } from 'lucide-react';
import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import { Fact } from './components.tsx';

export type ProjectOperationState =
  | 'prepared'
  | 'running'
  | 'stopping'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export type ProjectCommandDefinitionView = Readonly<{
  hash: string;
  recipe: 'lint' | 'test' | 'build';
  sourceHead: string;
  executable: string;
  executableSha256: string;
  argv: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  deadlineMs: number;
  nativeTrust: 'required';
}>;

export type ProjectOperationSummary = Readonly<{
  id: string;
  taskId: string;
  kind: 'github-read' | 'project-command';
  state: ProjectOperationState;
  reason: string | null;
  next: string | null;
  observedAt: string;
  definition?: ProjectCommandDefinitionView;
  artifacts?: readonly Artifact[];
}>;

export type PrepareProjectCommandInput = Readonly<{
  recipe: ProjectCommandDefinitionView['recipe'];
  executable: string;
  argv: string[];
  cwdRelative: string;
  deadlineMs: number;
}>;

export type ReadGitHubInput = Readonly<{
  kind: 'pull-request' | 'workflow-run' | 'job-log';
  host: string;
  owner: string;
  name: string;
  headSha: string;
  pullRequest?: string;
  runId?: string;
  attempt?: number;
  jobId?: string;
}>;

export type ProjectOperationsProps = Readonly<{
  operations: readonly ProjectOperationSummary[];
  onPrepare: (input: PrepareProjectCommandInput) => void | Promise<void>;
  onStart: (input: { operationId: string; definitionHash: string }) => void | Promise<void>;
  onStop: (operationId: string) => void | Promise<void>;
  onReadGitHub: (input: ReadGitHubInput) => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  renderArtifact: (artifact: Artifact) => ReactNode;
}>;

const stateNames: Record<ProjectOperationState, string> = {
  prepared: 'Prepared for review',
  running: 'Running',
  stopping: 'Stopping',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  unknown: 'Status unknown',
};

function DefinitionFacts({ definition }: { definition: ProjectCommandDefinitionView }) {
  const environment = Object.entries(definition.environment).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return (
    <div className="view-stack">
      <div className="facts-grid">
        <Fact label="Recipe" value={definition.recipe} />
        <Fact label="Deadline" value={`${definition.deadlineMs} ms`} />
        <Fact label="Definition hash" value={<code>{definition.hash}</code>} />
        <Fact label="Source head" value={<code>{definition.sourceHead}</code>} />
        <Fact label="Executable" value={<code>{definition.executable}</code>} />
        <Fact
          label="Executable SHA-256 (verified before launch)"
          value={<code>{definition.executableSha256}</code>}
        />
        <Fact label="Working directory" value={<code>{definition.cwd}</code>} />
        <Fact label="Native trust" value={definition.nativeTrust} />
      </div>
      <div>
        <p className="muted small">Arguments, one exact value per line</p>
        <pre className="worker-output">
          {definition.argv.length
            ? definition.argv.map((argument) => JSON.stringify(argument)).join('\n')
            : 'No arguments'}
        </pre>
      </div>
      <div>
        <p className="muted small">Environment</p>
        <pre className="worker-output">
          {environment.length
            ? environment.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n')
            : 'No environment entries'}
        </pre>
      </div>
    </div>
  );
}

function OperationCard({
  operation,
  acknowledged,
  starting,
  stopping,
  onAcknowledge,
  onStart,
  onStop,
  renderArtifact,
}: {
  operation: ProjectOperationSummary;
  acknowledged: boolean;
  starting: boolean;
  stopping: boolean;
  onAcknowledge: (checked: boolean) => void;
  onStart: () => void;
  onStop: () => void;
  renderArtifact: (artifact: Artifact) => ReactNode;
}) {
  const definition = operation.definition;
  const canStart = operation.state === 'prepared' && definition !== undefined;
  const canStop = operation.state === 'running';
  return (
    <article className="card" aria-labelledby={`operation-${operation.id}`}>
      <div className="section-heading">
        <h2 id={`operation-${operation.id}`}>
          {operation.kind === 'github-read' ? <GitPullRequest size={15} /> : <Terminal size={15} />}
          {operation.kind === 'github-read' ? 'GitHub read' : 'Project command'}
        </h2>
        <span>{stateNames[operation.state]}</span>
      </div>
      <div className="facts-grid">
        <Fact label="Operation" value={<code>{operation.id}</code>} />
        <Fact label="Task" value={<code>{operation.taskId}</code>} />
        <Fact
          label="Observed"
          value={<time dateTime={operation.observedAt}>{operation.observedAt}</time>}
        />
        <Fact label="Reason" value={operation.reason ?? 'No reason reported'} />
      </div>
      {operation.next && <p className="muted small">Next: {operation.next}</p>}
      {definition && (
        <details className="technical-details" open={canStart}>
          <summary>Exact prepared definition</summary>
          <DefinitionFacts definition={definition} />
        </details>
      )}
      {canStart && definition && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => onAcknowledge(event.currentTarget.checked)}
          />
          I understand this runs native local code from the project source copy at head{' '}
          {definition.sourceHead} using the disclosed executable, arguments, working directory,
          environment, and deadline.
        </label>
      )}
      <div className="button-row">
        {canStart && definition && (
          <button
            type="button"
            className="button primary"
            disabled={!acknowledged || starting}
            onClick={onStart}
          >
            <Play size={14} />
            Start exact definition
          </button>
        )}
        {(canStop || operation.state === 'stopping') && (
          <button
            type="button"
            className="button stop"
            disabled={!canStop || stopping}
            onClick={onStop}
          >
            <Square size={13} />
            {operation.state === 'stopping' ? 'Stopping' : 'Stop'}
          </button>
        )}
      </div>
      {operation.artifacts?.map((artifact) => (
        <section key={artifact.id} aria-label={`Retained output ${artifact.id}`}>
          {renderArtifact(artifact)}
        </section>
      ))}
    </article>
  );
}

export function ProjectOperations({
  operations,
  onPrepare,
  onStart,
  onStop,
  onReadGitHub,
  onRefresh,
  renderArtifact,
}: ProjectOperationsProps) {
  const [recipe, setRecipe] = useState<ProjectCommandDefinitionView['recipe']>('test');
  const [executable, setExecutable] = useState('');
  const [argumentsText, setArgumentsText] = useState('');
  const [cwdRelative, setCwdRelative] = useState('.');
  const [deadlineSeconds, setDeadlineSeconds] = useState('900');
  const [githubKind, setGitHubKind] = useState<ReadGitHubInput['kind']>('pull-request');
  const [host, setHost] = useState('github.com');
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const [headSha, setHeadSha] = useState('');
  const [pullRequest, setPullRequest] = useState('');
  const [runId, setRunId] = useState('');
  const [attempt, setAttempt] = useState('1');
  const [jobId, setJobId] = useState('');
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const pending = useRef(new Set<string>());
  const [pendingRevision, setPendingRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function perform(key: string, action: () => void | Promise<void>) {
    if (pending.current.has(key)) return;
    pending.current.add(key);
    setPendingRevision((value) => value + 1);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The operation could not complete.');
    } finally {
      pending.current.delete(key);
      setPendingRevision((value) => value + 1);
    }
  }

  const isPending = (key: string) => pending.current.has(key);

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const seconds = Number(deadlineSeconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) {
      setError('Deadline must be a whole number from 1 to 86400 seconds.');
      return;
    }
    void perform('prepare', () =>
      onPrepare({
        recipe,
        executable: executable.trim(),
        argv: argumentsText.split(/\r?\n/).filter((argument) => argument.length > 0),
        cwdRelative: cwdRelative.trim(),
        deadlineMs: seconds * 1000,
      }),
    );
  }

  function readGitHub(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const common = {
      host: host.trim(),
      owner: owner.trim(),
      name: name.trim(),
      headSha: headSha.trim().toLowerCase(),
    };
    const input: ReadGitHubInput =
      githubKind === 'pull-request'
        ? { ...common, kind: githubKind, pullRequest: pullRequest.trim() }
        : githubKind === 'workflow-run'
          ? { ...common, kind: githubKind, runId: runId.trim(), attempt: Number(attempt) }
          : {
              ...common,
              kind: githubKind,
              runId: runId.trim(),
              attempt: Number(attempt),
              jobId: jobId.trim(),
            };
    void perform('github', () => onReadGitHub(input));
  }

  return (
    <section className="view-stack" aria-labelledby="project-operations-heading">
      <div className="section-heading">
        <h2 id="project-operations-heading">
          <ShieldCheck size={15} />
          Project operations
        </h2>
        <button
          type="button"
          className="text-button"
          disabled={isPending('refresh')}
          onClick={() => void perform('refresh', onRefresh)}
        >
          <RefreshCw size={13} />
          Refresh
        </button>
      </div>
      <p className="muted small">
        Prepare local checks before starting them, or request GitHub status and logs with GET-only
        reads. These controls do not grant planning authority or authorize remote changes.
      </p>
      {error && <p role="alert">{error}</p>}

      <form className="card form-stack" onSubmit={prepare}>
        <div className="section-heading">
          <h2>
            <Terminal size={15} />
            Prepare project command
          </h2>
          <span>Review required before start</span>
        </div>
        <label>
          Recipe
          <select
            value={recipe}
            onChange={(event) => setRecipe(event.currentTarget.value as typeof recipe)}
          >
            <option value="lint">Lint</option>
            <option value="test">Test</option>
            <option value="build">Build</option>
          </select>
        </label>
        <label>
          Executable path
          <input
            required
            value={executable}
            onChange={(event) => setExecutable(event.currentTarget.value)}
            placeholder="/absolute/path/to/executable"
            autoComplete="off"
          />
        </label>
        <label>
          Arguments, one exact value per line
          <textarea
            rows={5}
            value={argumentsText}
            onChange={(event) => setArgumentsText(event.currentTarget.value)}
            placeholder={'--filter\n./src'}
          />
        </label>
        <label>
          Working directory relative to the project scratch copy
          <input
            required
            value={cwdRelative}
            onChange={(event) => setCwdRelative(event.currentTarget.value)}
            autoComplete="off"
          />
        </label>
        <label>
          Deadline in seconds
          <input
            required
            type="number"
            min={1}
            max={86400}
            step={1}
            value={deadlineSeconds}
            onChange={(event) => setDeadlineSeconds(event.currentTarget.value)}
          />
        </label>
        <p className="field-hint">
          The controller will return a pinned definition for review. Preparing does not run code.
        </p>
        <button type="submit" className="button secondary" disabled={isPending('prepare')}>
          Prepare exact definition
        </button>
      </form>

      <form className="card form-stack" onSubmit={readGitHub}>
        <div className="section-heading">
          <h2>
            <GitPullRequest size={15} />
            Read GitHub
          </h2>
          <span>GET-only</span>
        </div>
        <label>
          Read
          <select
            value={githubKind}
            onChange={(event) => setGitHubKind(event.currentTarget.value as typeof githubKind)}
          >
            <option value="pull-request">Pull request status</option>
            <option value="workflow-run">Workflow run status</option>
            <option value="job-log">Job log</option>
          </select>
        </label>
        <label>
          Host
          <input required value={host} onChange={(event) => setHost(event.currentTarget.value)} />
        </label>
        <label>
          Repository owner
          <input required value={owner} onChange={(event) => setOwner(event.currentTarget.value)} />
        </label>
        <label>
          Repository name
          <input required value={name} onChange={(event) => setName(event.currentTarget.value)} />
        </label>
        <label>
          Exact source head
          <input
            required
            pattern="[a-fA-F0-9]{40}([a-fA-F0-9]{24})?"
            value={headSha}
            onChange={(event) => setHeadSha(event.currentTarget.value)}
            autoComplete="off"
          />
        </label>
        {githubKind === 'pull-request' ? (
          <label>
            Pull request number
            <input
              required
              inputMode="numeric"
              pattern="[1-9][0-9]*"
              value={pullRequest}
              onChange={(event) => setPullRequest(event.currentTarget.value)}
            />
          </label>
        ) : (
          <>
            <label>
              Run ID
              <input
                required
                inputMode="numeric"
                pattern="[1-9][0-9]*"
                value={runId}
                onChange={(event) => setRunId(event.currentTarget.value)}
              />
            </label>
            <label>
              Attempt
              <input
                required
                type="number"
                min={1}
                step={1}
                value={attempt}
                onChange={(event) => setAttempt(event.currentTarget.value)}
              />
            </label>
          </>
        )}
        {githubKind === 'job-log' && (
          <label>
            Job ID
            <input
              required
              inputMode="numeric"
              pattern="[1-9][0-9]*"
              value={jobId}
              onChange={(event) => setJobId(event.currentTarget.value)}
            />
          </label>
        )}
        <p className="field-hint">
          This requests current status or logs only. It cannot rerun, cancel, dispatch, merge, or
          change the repository.
        </p>
        <button type="submit" className="button secondary" disabled={isPending('github')}>
          Read current GitHub data
        </button>
      </form>

      {operations.length === 0 ? (
        <section className="card">
          <p>No project operations are retained for this task.</p>
        </section>
      ) : (
        operations.map((operation) => {
          const definition = operation.definition;
          const acknowledgmentKey = definition
            ? `${operation.id}:${definition.hash}`
            : operation.id;
          return (
            <OperationCard
              key={operation.id}
              operation={operation}
              acknowledged={acknowledged[acknowledgmentKey] === true}
              starting={isPending(`start:${operation.id}`)}
              stopping={isPending(`stop:${operation.id}`)}
              onAcknowledge={(checked) =>
                setAcknowledged((current) => ({ ...current, [acknowledgmentKey]: checked }))
              }
              onStart={() => {
                if (!definition) return;
                void perform(`start:${operation.id}`, () =>
                  onStart({ operationId: operation.id, definitionHash: definition.hash }),
                );
              }}
              onStop={() => void perform(`stop:${operation.id}`, () => onStop(operation.id))}
              renderArtifact={renderArtifact}
            />
          );
        })
      )}
      {pendingRevision > 0 && pending.current.size > 0 && (
        <p role="status">Updating project operations...</p>
      )}
    </section>
  );
}
