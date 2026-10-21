import {
  type Artifact,
  GitHubReadRequestSchema,
  ProjectOperationDataSchema,
  TaskOperationsPageSchema,
} from '@crewkite/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { OutputView } from './output-view.tsx';
import {
  type ProjectOperationSummary,
  ProjectOperations,
  type ReadGitHubInput,
} from './project-operations.tsx';
import type { Workspace } from './source.ts';

export function ProjectOperationsPanel({
  taskId,
  workspace,
}: {
  taskId: string;
  workspace: Workspace;
}) {
  const { operationCommand, events, activityRevision } = workspace;
  const [operations, setOperations] = useState<ProjectOperationSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newerCount, setNewerCount] = useState(0);
  const cursor = useRef<string | undefined>(undefined);
  const newer = useRef<Array<string | undefined>>([]);
  const generation = useRef(0);
  const mounted = useRef(true);
  const load = useCallback(
    async (beforeId?: string) => {
      if (!mounted.current) return false;
      const token = ++generation.current;
      setLoading(true);
      try {
        const result = await operationCommand({
          command: 'GetTaskOperations',
          payload: { taskId, beforeId, limit: 20 },
        });
        if (result.data?.kind !== 'task-operations')
          throw new Error([result.reason ?? result.outcome, result.next].filter(Boolean).join(' '));
        const page = TaskOperationsPageSchema.parse(result.data);
        if (page.taskId !== taskId) throw new Error('Operation history belongs to another task.');
        const rows: ProjectOperationSummary[] = [];
        for (const operation of page.operations) {
          if (token !== generation.current) return false;
          let summary = operation;
          let definition: ProjectOperationSummary['definition'];
          let githubRequest: ProjectOperationSummary['githubRequest'];
          if (operation.kind === 'github-read' || operation.state === 'prepared') {
            const detailResult = await operationCommand({
              command: 'GetProjectOperation',
              payload: { taskId, operationId: operation.id },
            });
            if (detailResult.outcome !== 'applied' && detailResult.outcome !== 'already-applied')
              throw new Error(
                [detailResult.reason ?? detailResult.outcome, detailResult.next]
                  .filter(Boolean)
                  .join(' '),
              );
            const detail = ProjectOperationDataSchema.parse(detailResult.data);
            if (
              detail.operation.id !== operation.id ||
              detail.operation.taskId !== taskId ||
              detail.operation.definition.hash !== operation.definition.hash
            )
              throw new Error('Operation definition identity changed. Refresh to review it.');
            summary = detail.operation;
            githubRequest = detail.githubRequest ?? undefined;
            if (detail.definition)
              definition = {
                hash: operation.definition.hash,
                recipe: detail.definition.recipe,
                sourceHead: detail.definition.source.base,
                dirtyCount: detail.definition.source.dirtyCount,
                untrackedCount: detail.definition.source.untrackedCount,
                executable: detail.definition.executable,
                executableSha256: detail.definition.executableSha256,
                argv: detail.definition.argv,
                cwd: detail.definition.cwd,
                environment: detail.definition.environment,
                deadlineMs: detail.definition.deadlineMs,
                nativeTrust: detail.definition.nativeTrust,
              };
          }
          rows.push({
            ...summary,
            definition,
            githubRequest,
            artifacts: [summary.stdout, summary.stderr, summary.result].filter(
              (artifact): artifact is Artifact => artifact !== null,
            ),
          });
        }
        if (token !== generation.current) return false;
        setError(null);
        setLoaded(true);
        setOperations(rows);
        setNext(page.nextBeforeId);
        cursor.current = beforeId;
        return true;
      } catch (failure) {
        if (token === generation.current)
          setError(
            failure instanceof Error ? failure.message : 'Operation history is unavailable.',
          );
        return false;
      } finally {
        if (token === generation.current) setLoading(false);
      }
    },
    [operationCommand, taskId],
  );
  const eventCursor = events
    .filter((event) => event.type === 'operation.updated' && event.payload.taskId === taskId)
    .at(-1)?.cursor;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const refreshIdentity = `${activityRevision}:${eventCursor ?? ''}`;
  const observedEvent = useRef<string | null>(null);
  useEffect(() => {
    if (observedEvent.current === refreshIdentity) return;
    observedEvent.current = refreshIdentity;
    void load(cursor.current);
    return () => {
      observedEvent.current = null;
      generation.current++;
    };
  }, [load, refreshIdentity]);
  async function action(input: Parameters<typeof operationCommand>[0], latest = false) {
    if (latest) {
      cursor.current = undefined;
      newer.current = [];
      setNewerCount(0);
      void load();
    }
    const result = await operationCommand(input);
    await load(cursor.current);
    if (result.outcome !== 'applied' && result.outcome !== 'already-applied')
      throw new Error([result.reason ?? result.outcome, result.next].filter(Boolean).join(' '));
  }
  function start(operationId: string, definitionHash: string) {
    const definition = operations.find(
      (operation) =>
        operation.id === operationId &&
        operation.state === 'prepared' &&
        operation.definition?.hash === definitionHash,
    )?.definition;
    if (!definition)
      throw new Error('Refresh and review the exact prepared definition before Start.');
    return action({
      command: 'StartProjectCommand',
      expectedRevision: 0,
      payload: {
        taskId,
        operationId,
        definitionHash,
        grant: {
          taskId,
          action: 'run-native-tools',
          target: definitionHash,
          expiresAt: new Date(Date.now() + definition.deadlineMs + 5000).toISOString(),
          revoked: false,
          usesRemaining: 1,
        },
        sourceConsent: 'explicit',
        nativeTrust: 'accepted',
      },
    });
  }
  function githubRequest(input: ReadGitHubInput) {
    const { host, owner, name, ...request } = input;
    return GitHubReadRequestSchema.parse({ ...request, repository: { host, owner, name } });
  }
  return (
    <section className="view-stack" aria-label="Task operations">
      {error && <p role="alert">{error}</p>}
      {loaded && (error || loading) && (
        <p role="status">
          Showing the last loaded operations while current history is unavailable or refreshing.
        </p>
      )}
      <p className="muted small">
        {loading
          ? 'Loading operation history.'
          : loaded
            ? `Showing ${operations.length} operations on this page. ${next ? 'Older operations are available.' : 'End of operation history.'}`
            : 'Operation history has not loaded.'}
      </p>
      <div className="dialog-footer">
        <button
          type="button"
          disabled={loading || newerCount === 0}
          onClick={async () => {
            const target = newer.current.at(-1);
            if (await load(target)) {
              newer.current.pop();
              setNewerCount(newer.current.length);
            }
          }}
        >
          Newer operations
        </button>
        <button
          type="button"
          disabled={loading || next === null}
          onClick={async () => {
            if (next === null) return;
            const previous = cursor.current;
            if (await load(next)) {
              newer.current.push(previous);
              setNewerCount(newer.current.length);
            }
          }}
        >
          Older operations
        </button>
        <button
          type="button"
          disabled={loading}
          onClick={async () => {
            if (await load()) {
              newer.current = [];
              setNewerCount(0);
            }
          }}
        >
          Latest operations
        </button>
      </div>
      <ProjectOperations
        historyKnown={loaded}
        operations={operations}
        onRefresh={async () => {
          setError(null);
          await load(cursor.current);
        }}
        onPrepare={(input) =>
          action(
            {
              command: 'PrepareProjectCommand',
              expectedRevision: 0,
              payload: { ...input, taskId },
            },
            true,
          )
        }
        onStart={({ operationId, definitionHash }) => start(operationId, definitionHash)}
        onStop={(operationId) =>
          action({
            command: 'StopProjectOperation',
            expectedRevision: 0,
            payload: { taskId, operationId },
          })
        }
        onReadGitHub={(input) =>
          action(
            {
              command: 'ReadGitHub',
              expectedRevision: 0,
              payload: { taskId, request: githubRequest(input) },
            },
            true,
          )
        }
        renderArtifact={(artifact) => (
          <OutputView
            key={`${artifact.id}:${artifact.hash}`}
            artifact={artifact}
            workspace={workspace}
          />
        )}
      />
    </section>
  );
}
