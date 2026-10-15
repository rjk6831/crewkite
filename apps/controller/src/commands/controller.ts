import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Command,
  type CommandResult,
  CommandResultSchema,
  CommandSchema,
  type Event,
  type Observation,
  ObservationSchema,
  type Project,
  ProjectSchema,
  type Route,
  RouteSchema,
  type Snapshot,
  SnapshotSchema,
  type Task,
  TaskSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { inspectSource, projectRoot } from '../host/source.ts';
import { createIds, type IdPrefix } from '../store/ids.ts';
import { Store } from '../store/index.ts';
import { deriveWindow } from '../usage/index.ts';

export type ControllerOptions = {
  home: string;
  now?: () => string;
  id?: (prefix: IdPrefix) => string;
  routes?: Route[];
  observations?: Observation[];
};
const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));

export class Controller {
  readonly store: Store;
  readonly home: string;
  readonly now: () => string;
  readonly id: (prefix: IdPrefix) => string;

  constructor(options: ControllerOptions) {
    this.home = options.home;
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? createIds(this.now);
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const home = lstatSync(this.home);
    if (!home.isDirectory() || home.isSymbolicLink())
      throw new Error('Controller home must be a private directory.');
    chmodSync(this.home, 0o700);
    this.store = new Store(join(this.home, 'state.sqlite'));
    this.store.applyMigrations(migrations);
    this.store.transaction(() => {
      for (const value of options.routes ?? []) {
        const route = RouteSchema.parse(value);
        if (!route.fake) throw new Error('Live routes are unsupported in D0.');
        if (!this.store.get('route', route.id)) this.store.put('route', route.id, 0, route);
      }
      for (const value of options.observations ?? []) {
        const observation = ObservationSchema.parse(value);
        if (!this.store.get('route', observation.routeId))
          throw new Error('Usage route is not registered.');
        const key = `${observation.routeId}/${observation.windowId}`;
        if (!this.store.get('window', key)) this.store.put('window', key, 0, observation);
      }
    });
  }

  async execute(input: unknown, principal: string): Promise<CommandResult> {
    if (principal !== 'local-owner')
      return {
        outcome: 'denied',
        reason: 'unauthenticated-actor',
        next: 'Connect through the private authenticated socket.',
      };
    const parsed = CommandSchema.safeParse(input);
    if (!parsed.success)
      return {
        outcome: 'unsupported',
        reason: 'invalid-command',
        next: 'Send a valid protocol 1 command.',
      };
    const command = parsed.data;
    const hash = hashCanonical(command);
    return this.store.transaction(() => {
      const receipt = this.store.receipt(command.key);
      if (receipt) {
        if (receipt.hash !== hash || receipt.principal !== principal)
          return {
            outcome: 'denied',
            reason: 'idempotency-key-reused',
            next: 'Use a new key for changed command content.',
          };
        return receipt.result.outcome === 'applied'
          ? { ...receipt.result, outcome: 'already-applied' }
          : receipt.result;
      }
      const stale = this.checkRevision(command);
      const result = CommandResultSchema.parse(stale ?? this.apply(command));
      this.store.saveReceipt(command.key, hash, principal, result);
      return result;
    });
  }

  snapshot(): Snapshot {
    return SnapshotSchema.parse({
      protocol: 1,
      cursor: this.store.cursor(),
      projects: this.store.list('project'),
      tasks: this.store.list('task'),
      runs: this.store.list('run'),
      attempts: this.store.list('attempt'),
      routes: this.store.list('route'),
      approvals: this.store.list('approval'),
      candidates: this.store.list('candidate'),
      artifacts: this.store.list('artifact'),
      evidence: this.store.db
        .prepare('SELECT body FROM evidence')
        .all()
        .map((row) => JSON.parse(row.body as string)),
      usage: this.store
        .list<Observation>('window')
        .map((observation) =>
          deriveWindow(observation, { nowMs: Date.parse(this.now()), maxAgeMs: 300000 }),
        ),
    });
  }

  subscribe(listener: (event: Event) => void): () => void {
    return this.store.subscribe(listener);
  }
  close() {
    this.store.close();
  }

  private checkRevision(command: Command): CommandResult | undefined {
    if (!('expectedRevision' in command)) return;
    if (command.command === 'RegisterProject' || command.command === 'CreateTask') {
      if (command.expectedRevision !== 0)
        return { outcome: 'stale-revision', revision: 0, next: 'Create from revision zero.' };
      return;
    }
    const taskId =
      command.command === 'ResolveApproval'
        ? command.payload.binding.taskId
        : command.payload.taskId;
    const task = this.store.get<Task>('task', taskId);
    if (!task)
      return { outcome: 'blocked', reason: 'task-not-found', next: 'Choose a registered task.' };
    if (task.revision !== command.expectedRevision)
      return {
        outcome: 'stale-revision',
        entity: task,
        revision: task.revision,
        next: 'Refresh the task and review the action.',
      };
  }

  private apply(command: Command): CommandResult {
    switch (command.command) {
      case 'RegisterProject': {
        const path = projectRoot(command.payload.path);
        const existing = this.store.db
          .prepare('SELECT project_id FROM project_paths WHERE path=?')
          .get(path);
        if (existing)
          return {
            outcome: 'already-applied',
            entity: this.store.get<Project>('project', existing.project_id as string),
          };
        const project = ProjectSchema.parse({
          id: this.id('prj'),
          name: basename(path),
          revision: 0,
        });
        this.store.put('project', project.id, project.revision, project);
        this.store.db
          .prepare('INSERT INTO project_paths(project_id,path) VALUES (?,?)')
          .run(project.id, path);
        return { outcome: 'applied', entity: project, revision: 0 };
      }
      case 'InspectSource': {
        const path = this.projectPath(command.payload.projectId);
        if (!path) return { outcome: 'blocked', reason: 'project-not-found' };
        return {
          outcome: 'applied',
          data: { kind: 'source', source: inspectSource(command.payload.projectId, path) },
        };
      }
      case 'CreateTask': {
        if (!this.store.get('project', command.payload.projectId))
          return { outcome: 'blocked', reason: 'project-not-found' };
        const task = TaskSchema.parse({
          ...command.payload,
          id: this.id('tsk'),
          state: 'draft',
          waitingReason: null,
          revision: 0,
          runId: null,
          next: 'Prepare the run.',
        });
        this.store.put('task', task.id, task.revision, task);
        this.event('task.created', task.id, task.revision, task);
        return { outcome: 'applied', entity: task, revision: task.revision };
      }
      case 'AmendTask': {
        const task = this.store.get<Task>('task', command.payload.taskId);
        if (!task || !['draft', 'stopped', 'interrupted', 'failed'].includes(task.state))
          return {
            outcome: 'blocked',
            reason: 'task-not-amendable',
            next: 'Stop the current work before changing its criteria.',
          };
        const updated = TaskSchema.parse({
          ...task,
          title: command.payload.title,
          outcome: command.payload.outcome,
          criteria: command.payload.criteria,
          id: task.id,
          revision: task.revision + 1,
          runId: null,
        });
        this.store.put('task', updated.id, updated.revision, updated);
        this.event('task.updated', updated.id, updated.revision, updated);
        return { outcome: 'applied', entity: updated, revision: updated.revision };
      }
      case 'GetSnapshot':
        return { outcome: 'applied', data: { kind: 'snapshot', snapshot: this.snapshot() } };
      case 'GetUsage':
        return { outcome: 'applied', data: { kind: 'usage', windows: this.snapshot().usage } };
      case 'GetHealth':
        return {
          outcome: 'applied',
          data: {
            kind: 'health',
            status: 'degraded',
            version: '0.0.0',
            blockers: ['Run execution is not implemented.'],
          },
        };
      default:
        return {
          outcome: 'unsupported',
          reason: 'command-not-implemented',
          next: 'This controller slice currently supports project and task metadata.',
        };
    }
  }

  private projectPath(projectId: string): string | undefined {
    return this.store.db.prepare('SELECT path FROM project_paths WHERE project_id=?').get(projectId)
      ?.path as string | undefined;
  }

  private event(type: Event['type'], taskId: string, revision: number, payload: Event['payload']) {
    this.store.append({
      protocol: 1,
      id: this.id('evt'),
      at: this.now(),
      taskId,
      revision,
      type,
      payload,
    });
  }
}
