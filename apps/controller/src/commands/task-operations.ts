import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import {
  type Artifact,
  ArtifactSchema,
  type Command,
  type CommandResult,
  canonicalJson,
  GitHubObservationSchema,
  GitHubReadRequestSchema,
  ProjectCommandPreviewSchema,
  type Task,
  TaskOperationSummarySchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import type { ArtifactFiles } from '../artifacts/index.ts';
import { type GitHubExecutable, githubReadArgv, startGitHubRead } from '../github/read.ts';
import { committedFiles, git, inspectSource, materialize } from '../host/source.ts';
import { groupAbsent, verifyOwnedCommandExecutable } from '../host/worker.ts';
import type { Store } from '../store/index.ts';
import { type OperationRecord, OperationStore } from './operation-store.ts';
import { createOwnedProjectCommandRunner } from './owned-runner.ts';
import { type OwnedProjectCommandLifecycle, startProjectCommand } from './project-command.ts';

export type TaskOperationCommand = Extract<
  Command,
  {
    command:
      | 'PrepareProjectCommand'
      | 'StartProjectCommand'
      | 'ReadGitHub'
      | 'StopProjectOperation'
      | 'GetTaskOperations'
      | 'GetProjectOperation';
  }
>;
type Dependencies = {
  store: Store;
  artifacts: ArtifactFiles;
  home: string;
  now: () => string;
  id: (prefix: 'cmd' | 'art') => string;
  event: (record: OperationRecord) => void;
};

function executablePin(input: string) {
  const candidates = isAbsolute(input)
    ? [input]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .filter(isAbsolute)
        .map((directory) => join(directory, input));
  for (const candidate of candidates) {
    let fd: number | undefined;
    try {
      const path = realpathSync(candidate);
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.size > 256n * 1024n * 1024n) continue;
      const hash = createHash('sha256');
      const bytes = Buffer.allocUnsafe(65536);
      let count = 0n;
      for (;;) {
        const read = readSync(fd, bytes, 0, bytes.length, null);
        if (!read) break;
        count += BigInt(read);
        if (count > before.size) throw Error('Tool identity changed.');
        hash.update(bytes.subarray(0, read));
      }
      const after = fstatSync(fd, { bigint: true });
      if (
        count !== before.size ||
        ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode'].some(
          (key) => before[key as keyof typeof before] !== after[key as keyof typeof after],
        )
      )
        throw Error('Tool identity changed.');
      const sha256 = hash.digest('hex');
      verifyOwnedCommandExecutable(path, sha256);
      return { path, sha256 };
    } catch {
      /* Try only the explicit executable or ordinary PATH candidates. */
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  throw Error('Choose an installed executable file. Shell launch is unavailable.');
}

export function taskOperationSummary(record: OperationRecord) {
  return TaskOperationSummarySchema.parse({
    id: record.id,
    taskId: record.taskId,
    kind: record.kind,
    state: record.state,
    observedAt: record.observedAt,
    reason: record.reason,
    next: record.next,
    definition: record.definition,
    stdout: record.stdout,
    stderr: record.stderr,
    result: record.result,
  });
}

export class TaskOperations {
  private readonly journal: OperationStore;
  private readonly active = new Map<
    string,
    { key: string; hash: string; stop: () => void; promise: Promise<CommandResult> }
  >();
  private closed = false;
  private readonly options: Dependencies;
  constructor(options: Dependencies) {
    this.options = options;
    this.journal = new OperationStore(options.store, options.now, options.event);
  }
  recover() {
    this.journal.recover(groupAbsent, new Set(this.active.keys()));
  }
  busyTask(taskId: string): boolean {
    return !!this.options.store.db
      .prepare(
        "SELECT operation_id FROM task_operations WHERE task_id=? AND kind='project-command' AND state IN ('running','stopping','unknown') LIMIT 1",
      )
      .get(taskId);
  }
  private summary(record: OperationRecord) {
    return taskOperationSummary(record);
  }
  private definition(record: OperationRecord): unknown {
    if (record.definition.bytes > 262144) throw Error('Operation definition is unavailable.');
    const stored = this.options.store.get<Artifact>('artifact', record.definition.id);
    if (!stored || canonicalJson(stored) !== canonicalJson(record.definition))
      throw Error('Operation definition changed.');
    return JSON.parse(this.options.artifacts.read(record.definition.hash).toString('utf8'));
  }
  private detail(record: OperationRecord): CommandResult {
    const value = this.definition(record);
    const request =
      record.kind === 'github-read'
        ? GitHubReadRequestSchema.parse((value as { request: unknown }).request)
        : null;
    let githubResult = null;
    if (request && record.result) {
      const resultArtifact = this.options.store.get<Artifact>('artifact', record.result.id);
      if (
        !resultArtifact ||
        canonicalJson(resultArtifact) !== canonicalJson(record.result) ||
        resultArtifact.bytes > 1048576
      )
        throw Error('GitHub result binding is unavailable.');
      const result = JSON.parse(this.options.artifacts.read(resultArtifact.hash).toString('utf8'));
      if (
        result.source?.headSha !== request.headSha ||
        canonicalJson(result.source?.repository) !== canonicalJson(request.repository)
      )
        throw Error('GitHub result source changed.');
      if (
        result.state === 'complete' &&
        (result.kind !== request.kind ||
          (request.kind === 'pull-request'
            ? result.pullRequest !== request.pullRequest
            : result.runId !== request.runId ||
              result.attempt !== request.attempt ||
              (request.kind === 'job-log' &&
                (result.jobId !== request.jobId ||
                  result.complete !== true ||
                  !record.stdout ||
                  result.artifact?.hash !== record.stdout.hash ||
                  result.artifact?.bytes !== record.stdout.bytes))))
      )
        throw Error('GitHub result request identity changed.');
      const repositoryUrl = `https://${request.repository.host}/${request.repository.owner}/${request.repository.name}`;
      const url =
        request.kind === 'pull-request'
          ? `${repositoryUrl}/pull/${request.pullRequest}`
          : request.kind === 'workflow-run'
            ? `${repositoryUrl}/actions/runs/${request.runId}/attempts/${request.attempt}`
            : `${repositoryUrl}/actions/runs/${request.runId}/job/${request.jobId}`;
      githubResult = GitHubObservationSchema.parse({
        state: result.state,
        status:
          result.state === 'complete'
            ? result.kind === 'job-log'
              ? result.jobStatus
              : result.status
            : null,
        fetchedAt: result.source.fetchedAt,
        url: result.state === 'complete' ? url : null,
        reason: result.state === 'complete' ? null : result.reason,
      });
    }
    return {
      outcome: 'applied',
      data: {
        kind: 'project-operation',
        operation: this.summary(record),
        definition:
          record.kind === 'project-command' ? ProjectCommandPreviewSchema.parse(value) : null,
        githubRequest: request,
        githubResult,
      },
    };
  }
  private artifact(value: unknown): Artifact {
    const published = this.options.artifacts.publish(Buffer.from(canonicalJson(value)));
    return ArtifactSchema.parse({
      id: this.options.id('art'),
      ...published,
      mediaType: 'application/json',
    });
  }
  private putArtifact(artifact: Artifact) {
    this.options.store.put('artifact', artifact.id, 0, artifact);
  }
  private task(taskId: string): Task {
    const task = this.options.store.get<Task>('task', taskId);
    if (!task) throw Error('Task is unavailable.');
    return task;
  }
  private root(task: Task): string {
    const path = this.options.store.db
      .prepare('SELECT path FROM project_paths WHERE project_id=?')
      .get(task.projectId)?.path;
    if (typeof path !== 'string' || realpathSync(path) !== path)
      throw Error('Project is unavailable.');
    return path;
  }
  private admit(task: Task) {
    if (
      this.closed ||
      task.state !== 'draft' ||
      this.busyTask(task.id) ||
      this.options.store.db
        .prepare('SELECT task_id FROM writer_leases WHERE task_id=?')
        .get(task.id)
    )
      throw Error('Use an idle draft task with no unresolved command or writer.');
  }
  private save(command: TaskOperationCommand, result: CommandResult) {
    this.options.store.saveReceipt(command.key, hashCanonical(command), 'local-owner', result);
    return result;
  }
  async execute(command: TaskOperationCommand): Promise<CommandResult> {
    const store = this.options.store;
    const hash = hashCanonical(command);
    if ('expectedRevision' in command) this.recover();
    const receipt = store.receipt(command.key);
    if (receipt) {
      if (receipt.hash !== hash || receipt.principal !== 'local-owner')
        return { outcome: 'denied', reason: 'idempotency-key-reused' };
      const running = [...this.active.values()].find((value) => value.key === command.key);
      if (running)
        return running.hash === hash
          ? running.promise
          : { outcome: 'denied', reason: 'idempotency-key-reused' };
      return {
        ...receipt.result,
        ...(receipt.result.outcome === 'applied' ? { outcome: 'already-applied' as const } : {}),
      };
    }
    if ('expectedRevision' in command && command.expectedRevision !== 0)
      return { outcome: 'stale-revision', revision: 0 };
    try {
      const task = this.task(command.payload.taskId);
      if (command.command === 'GetTaskOperations') {
        const rows = this.journal.list(
          task.id,
          command.payload.beforeId,
          command.payload.limit + 1,
        );
        const operations = rows.slice(0, command.payload.limit).map((row) => this.summary(row));
        return {
          outcome: 'applied',
          data: {
            kind: 'task-operations',
            taskId: task.id,
            operations,
            nextBeforeId:
              rows.length > command.payload.limit ? (operations.at(-1)?.id ?? null) : null,
          },
        };
      }
      if (command.command === 'GetProjectOperation') {
        const record = this.journal.get(command.payload.operationId);
        if (!record || record.taskId !== task.id) throw Error('Operation is unavailable.');
        return this.detail(record);
      }
      if (command.command === 'StopProjectOperation') {
        const record = this.journal.get(command.payload.operationId);
        if (!record || record.taskId !== task.id) throw Error('Operation is unavailable.');
        const running = this.active.get(record.id);
        if (running) {
          if (record.state === 'running') this.journal.stopping(record.id);
          running.stop();
          await running.promise;
        }
        const current = this.journal.get(record.id);
        if (!current) throw Error('Operation is unavailable.');
        return store.transaction(() =>
          this.save(
            command,
            current.state === 'unknown' ||
              current.state === 'running' ||
              current.state === 'stopping'
              ? {
                  outcome: 'blocked',
                  reason: 'operation-ownership-unknown',
                  next: 'Refresh the exact operation. No process closure has been established.',
                }
              : this.detail(current),
          ),
        );
      }
      if (command.command === 'PrepareProjectCommand') {
        this.admit(task);
        const root = this.root(task);
        const source = inspectSource(task.projectId, root);
        const pin = executablePin(command.payload.executable);
        const operationId = this.options.id('cmd');
        const scratchRoot = join(this.options.home, 'operations', operationId, 'scratch');
        const cwd = resolve(scratchRoot, command.payload.cwdRelative);
        const inside = relative(scratchRoot, cwd);
        if (inside === '..' || inside.startsWith('../') || isAbsolute(inside))
          throw Error('Working directory must stay inside the scratch copy.');
        const definition = ProjectCommandPreviewSchema.parse({
          version: 1,
          id: operationId,
          taskId: task.id,
          taskRevision: task.revision,
          source,
          sourceMode: 'committed-head',
          repositoryRoot: root,
          scratchRoot,
          cwd,
          recipe: command.payload.recipe,
          executable: pin.path,
          executableSha256: pin.sha256,
          executableIdentity: 'verified-prelaunch-sha256',
          argv: command.payload.argv,
          environment: command.payload.environment ?? {
            CI: '1',
            LANG: 'C',
            NO_COLOR: '1',
            HOME: join(this.options.home, 'operations', operationId, 'environment'),
            TMPDIR: join(this.options.home, 'operations', operationId, 'temporary'),
            PATH: process.env.PATH ?? '',
          },
          deadlineMs: command.payload.deadlineMs,
          nativeTrust: 'required',
        });
        const artifact = this.artifact(definition);
        return store.transaction(() => {
          this.admit(this.task(task.id));
          this.putArtifact(artifact);
          const record = this.journal.create({
            id: operationId,
            taskId: task.id,
            kind: 'project-command',
            definition: artifact,
          });
          return this.save(command, this.detail(record));
        });
      }
      if (command.command === 'StartProjectCommand') return await this.start(command, task, hash);
      return await this.github(command, task, hash);
    } catch (error) {
      const result: CommandResult = {
        outcome: 'blocked',
        reason: 'operation-unavailable',
        next:
          error instanceof Error
            ? error.message.slice(0, 4096)
            : 'Read the exact operation and prepare a new explicit request.',
      };
      if (!('expectedRevision' in command)) return result;
      return store.transaction(
        () => store.receipt(command.key)?.result ?? this.save(command, result),
      );
    }
  }
  private lifecycle(
    id: string,
    phase: 'command' | 'metadata' | 'content',
  ): OwnedProjectCommandLifecycle {
    return {
      intent: () => {
        this.journal.phase(id, phase, 'intent', null);
      },
      owned: (group) => {
        this.journal.phase(id, phase, 'owned', group);
      },
      quiescent: (group) => {
        this.journal.phase(id, phase, 'closed', group);
      },
    };
  }
  private async publish(
    source: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<Artifact> {
    const bytes = await this.options.artifacts.publishStream(source, { signal });
    const artifact = ArtifactSchema.parse({
      id: this.options.id('art'),
      ...bytes,
      mediaType: 'text/plain; charset=utf-8',
    });
    this.options.store.transaction(() => this.putArtifact(artifact));
    return artifact;
  }
  private async start(
    command: Extract<TaskOperationCommand, { command: 'StartProjectCommand' }>,
    task: Task,
    hash: string,
  ): Promise<CommandResult> {
    const record = this.journal.get(command.payload.operationId);
    if (
      !record ||
      record.taskId !== task.id ||
      record.kind !== 'project-command' ||
      record.definition.hash !== command.payload.definitionHash
    )
      throw Error('Read the exact prepared operation before starting.');
    const definition = ProjectCommandPreviewSchema.parse(this.definition(record));
    const grant = command.payload.grant;
    const grantKey = `grant:${hashCanonical({ taskId: grant.taskId, action: grant.action, target: grant.target, expiresAt: grant.expiresAt })}`;
    this.journal.begin(record.id, command.key, hash, () => {
      this.admit(this.task(task.id));
      if (
        task.revision !== definition.taskRevision ||
        this.root(task) !== definition.repositoryRoot ||
        inspectSource(task.projectId, definition.repositoryRoot).base !== definition.source.base
      )
        throw Error('Task or committed source changed. Prepare a new operation.');
      if (
        grant.taskId !== task.id ||
        grant.target !== record.definition.hash ||
        Date.parse(grant.expiresAt) - Date.parse(this.options.now()) < definition.deadlineMs ||
        Date.parse(grant.expiresAt) - Date.parse(this.options.now()) > 86405000 ||
        this.options.store.receipt(grantKey)
      )
        throw Error(
          'Approve a fresh one-use native-tool grant covering this definition and deadline.',
        );
      this.options.store.saveReceipt(grantKey, hashCanonical(grant), 'local-owner', {
        outcome: 'applied',
        entity: record.definition,
      });
    });
    const admittedDeadline = performance.now() + definition.deadlineMs;
    let stopped = false;
    let childStop: (() => void) | undefined;
    const stop = () => {
      stopped = true;
      childStop?.();
    };
    const promise = (async (): Promise<CommandResult> => {
      try {
        // Yield after durable admission so status and Stop can observe preparation.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (stopped || this.closed)
          return this.complete(record.id, 'cancelled', 'stopped', null, null, null);
        const files = committedFiles(definition.repositoryRoot, definition.source.base);
        materialize(definition.scratchRoot, files);
        mkdirSync(join(this.options.home, 'operations', record.id, 'environment'), {
          recursive: true,
          mode: 0o700,
        });
        mkdirSync(join(this.options.home, 'operations', record.id, 'temporary'), {
          recursive: true,
          mode: 0o700,
        });
        if (stopped || this.closed)
          return this.complete(record.id, 'cancelled', 'stopped', null, null, null);
        const artifacts = new Map<string, Artifact>();
        const execution = startProjectCommand(
          {
            version: 1,
            operationId: record.id,
            recipe: definition.recipe,
            source: {
              projectId: task.projectId,
              repositoryRoot: definition.repositoryRoot,
              baseRevision: definition.source.base,
            },
            scratchRoot: definition.scratchRoot,
            cwd: definition.cwd,
            executable: definition.executable,
            executableIdentity: definition.executableIdentity,
            executableSha256: definition.executableSha256,
            argv: definition.argv,
            environment: Object.fromEntries(
              Object.entries(definition.environment).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
              ),
            ),
            output: { stdout: 'artifact', stderr: 'artifact', chunkBytes: 65536 },
          },
          {
            runner: createOwnedProjectCommandRunner({
              deadlineMs: Math.floor(admittedDeadline - performance.now()),
            }),
            lifecycle: this.lifecycle(record.id, 'command'),
            publishStream: async (source, options) => {
              const artifact = await this.publish(source, options?.signal);
              artifacts.set(artifact.hash, artifact);
              return artifact;
            },
          },
        );
        childStop = execution.stop;
        if (stopped || this.closed) childStop();
        const result = await execution.result;
        const resultArtifact = this.artifact(result);
        this.options.store.transaction(() => this.putArtifact(resultArtifact));
        return this.complete(
          record.id,
          result.status,
          result.reason,
          result.stdout ? (artifacts.get(result.stdout.hash) ?? null) : null,
          result.stderr ? (artifacts.get(result.stderr.hash) ?? null) : null,
          resultArtifact,
        );
      } catch {
        const current = this.journal.get(record.id);
        const unknown = current?.phases.some((phase) => phase.state !== 'closed') ?? true;
        return this.complete(
          record.id,
          unknown ? 'unknown' : stopped ? 'cancelled' : 'failed',
          unknown ? 'operation-ownership-unknown' : stopped ? 'stopped' : 'operation-failed',
          null,
          null,
          null,
        );
      }
    })();
    this.active.set(record.id, { key: command.key, hash, stop, promise });
    try {
      return await promise;
    } finally {
      this.active.delete(record.id);
    }
  }
  private complete(
    id: string,
    state: 'succeeded' | 'failed' | 'cancelled' | 'unknown',
    reason: string,
    stdout: Artifact | null,
    stderr: Artifact | null,
    result: Artifact | null,
  ): CommandResult {
    const scopedReason = state === 'unknown' ? 'operation-ownership-unknown' : reason;
    const current = this.journal.get(id);
    if (!current) throw Error('Operation is unavailable.');
    const next =
      state === 'unknown'
        ? 'Ownership remains unresolved. This operation will not replay.'
        : state === 'succeeded'
          ? null
          : 'Read the retained result. Prepare a new explicit operation to retry.';
    const preview = { ...current, state, reason: scopedReason, next, stdout, stderr, result };
    const response: CommandResult =
      state === 'unknown'
        ? { outcome: 'blocked', reason: scopedReason, next: next ?? undefined }
        : {
            ...this.detail(preview),
            ...(state === 'succeeded'
              ? {}
              : { outcome: 'blocked' as const, reason: scopedReason, next: next ?? undefined }),
          };
    this.journal.finish(
      id,
      { state, reason: scopedReason, next, stdout, stderr, result },
      response,
    );
    return response;
  }
  private async github(
    command: Extract<TaskOperationCommand, { command: 'ReadGitHub' }>,
    task: Task,
    hash: string,
  ): Promise<CommandResult> {
    if (this.closed) throw Error('Controller is closing.');
    const root = this.root(task);
    const requested = command.payload.request;
    const source = inspectSource(task.projectId, root);
    if (source.base !== requested.headSha)
      throw Error('Choose the registered project committed head.');
    const origin = git(root, ['remote', 'get-url', 'origin']).toString('utf8').trim();
    const repository = requested.repository;
    const allowed = [
      `https://${repository.host}/${repository.owner}/${repository.name}`,
      `https://${repository.host}/${repository.owner}/${repository.name}.git`,
      `git@${repository.host}:${repository.owner}/${repository.name}`,
      `git@${repository.host}:${repository.owner}/${repository.name}.git`,
    ];
    if (!allowed.includes(origin))
      throw Error('The requested repository must match the registered origin.');
    const pin = executablePin('gh');
    const operationId = this.options.id('cmd');
    const cwd = join(this.options.home, 'operations', operationId, 'github');
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const client: GitHubExecutable = {
      path: pin.path,
      sha256: pin.sha256,
      cwd,
      environment: { HOME: homedir(), PATH: process.env.PATH ?? '', LC_ALL: 'C' },
    };
    const artifact = this.artifact({
      version: 1,
      taskId: task.id,
      request: requested,
      client,
      argv: githubReadArgv(requested),
    });
    const record = this.journal.createAndBegin(
      { id: operationId, taskId: task.id, kind: 'github-read', definition: artifact },
      command.key,
      hash,
      () => {
        if (
          this.closed ||
          this.options.store.db
            .prepare(
              "SELECT operation_id FROM task_operations WHERE task_id=? AND kind='github-read' AND operation_id<>? AND state IN ('running','stopping','unknown') LIMIT 1",
            )
            .get(task.id, operationId)
        )
          throw Error('Resolve the current GitHub read before starting another one for this task.');
      },
      () => this.putArtifact(artifact),
    );
    const published = new Map<string, Artifact>();
    const execution = startGitHubRead(record.id, client, requested, {
      runner: createOwnedProjectCommandRunner({ deadlineMs: 60000 }),
      lifecycle: (phase) => this.lifecycle(record.id, phase),
      now: this.options.now,
      publishStream: async (source, options) => {
        const artifact = await this.publish(source, options?.signal);
        published.set(artifact.hash, artifact);
        return artifact;
      },
    });
    const promise = execution.result
      .then((result) => {
        const resultArtifact = this.artifact(result);
        this.options.store.transaction(() => this.putArtifact(resultArtifact));
        return this.complete(
          record.id,
          result.state === 'complete'
            ? 'succeeded'
            : result.state === 'unknown'
              ? 'unknown'
              : result.state === 'cancelled'
                ? 'cancelled'
                : 'failed',
          result.state === 'complete' ? 'read-complete' : result.reason,
          result.state === 'complete' && result.kind === 'job-log'
            ? (published.get(result.artifact.hash) ?? null)
            : null,
          null,
          resultArtifact,
        );
      })
      .catch(() => {
        const current = this.journal.get(record.id);
        const unknown = current?.phases.some((phase) => phase.state !== 'closed') ?? true;
        return this.complete(
          record.id,
          unknown ? 'unknown' : 'failed',
          unknown ? 'operation-ownership-unknown' : 'operation-output-failed',
          null,
          null,
          null,
        );
      });
    this.active.set(record.id, { key: command.key, hash, stop: execution.stop, promise });
    try {
      return await promise;
    } finally {
      this.active.delete(record.id);
    }
  }
  stopTask(taskId: string) {
    for (const [id, value] of this.active)
      if (this.journal.get(id)?.taskId === taskId) value.stop();
  }
  close(): void | Promise<void> {
    this.closed = true;
    if (!this.active.size) return;
    for (const value of this.active.values()) value.stop();
    return Promise.allSettled([...this.active.values()].map((value) => value.promise)).then(
      () => {},
    );
  }
}
