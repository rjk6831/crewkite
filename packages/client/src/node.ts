import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  type Command,
  type CommandResult,
  CommandSchema,
  CursorSchema,
  type Event,
  type ProjectPageRequest,
  ProjectPageSchema,
  type Snapshot,
  type SnapshotScope,
  type TaskPageRequest,
  TaskPageSchema,
  type TransportMessage,
  type WorkspaceState,
  WorkspaceStateSchema,
} from '@crewkite/contracts';
import { type ConnectionState, encodeFrame, FrameDecoder } from './index.ts';

interface Options {
  socketPath: string;
  token: string;
  actor: Command['actor'];
  reconnectDelaysMs?: readonly number[];
  timeoutMs?: number;
  nextKey?: () => string;
}
interface Pending {
  resolve: (result: CommandResult) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface Subscription {
  cursor: string;
  event: (event: Event) => void;
  resync: (snapshot: Snapshot) => void;
  workspace: boolean;
  workspaceResync?: (header: WorkspaceState) => void;
}

export function createCommandKey(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let value = (BigInt(Date.now()) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
  let suffix = '';
  for (let index = 0; index < 26; index++) {
    suffix = alphabet[Number(value & 31n)] + suffix;
    value >>= 5n;
  }
  return `cmd_${suffix}`;
}

export function readControllerEndpoint(home: string): { socketPath: string; token: string } {
  const directory = lstatSync(home);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o777) !== 0o700 ||
    directory.uid !== process.getuid?.()
  )
    throw new Error('Controller home must be private to its owner.');
  const file = openSync(
    join(home, 'token'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const state = fstatSync(file);
    if (
      !state.isFile() ||
      state.nlink !== 1 ||
      state.size > 65 ||
      (state.mode & 0o777) !== 0o600 ||
      state.uid !== process.getuid?.()
    )
      throw new Error('Controller token must be private to its owner.');
    const token = readFileSync(file, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Controller token is invalid.');
    return { socketPath: join(home, 'control.sock'), token };
  } finally {
    closeSync(file);
  }
}

export class ControllerClient {
  private readonly options: Options;
  private socket: Socket | null = null;
  private state: ConnectionState = 'connecting';
  private pending = new Map<string, Pending>();
  private subscription: Subscription | null = null;
  private listeners = new Set<(state: ConnectionState) => void>();
  private exhaustedListeners = new Set<() => void>();
  private closed = false;
  private connectedOnce = false;
  private reconnectIndex = 0;
  private reconnectExhausted = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncing = false;
  private resyncRequested = false;
  private pagingUnavailable = false;

  constructor(options: Options) {
    this.options = options;
    if (!Number.isSafeInteger(options.timeoutMs ?? 5000) || (options.timeoutMs ?? 5000) < 1)
      throw new Error('Connection timeout must be positive.');
    if (
      (options.reconnectDelaysMs ?? []).some(
        (value) => !Number.isSafeInteger(value) || value < 0 || value > 30_000,
      )
    )
      throw new Error('Reconnect delays must be bounded.');
  }

  private connectionState(state: ConnectionState) {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  onConnection(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  onReconnectExhausted(listener: () => void): () => void {
    this.exhaustedListeners.add(listener);
    if (this.reconnectExhausted) listener();
    return () => this.exhaustedListeners.delete(listener);
  }

  connect(): Promise<void> {
    if (this.socket) return Promise.reject(new Error('Client already has a connection.'));
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectIndex = 0;
    this.reconnectExhausted = false;
    return this.open();
  }

  private async open(): Promise<void> {
    if (this.closed) throw new Error('Client is closed.');
    if (this.socket) throw new Error('Client already has a connection.');
    this.connectionState('connecting');
    return new Promise<void>((resolve, reject) => {
      const decoder = new FrameDecoder();
      const socket = createConnection(this.options.socketPath);
      this.socket = socket;
      let welcomed = false;
      let settled = false;
      const fail = (message: string) => {
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
        socket.destroy();
      };
      socket.setTimeout(this.options.timeoutMs ?? 5000, () =>
        fail('Controller handshake timed out.'),
      );
      socket.once('connect', () => {
        try {
          socket.write(
            encodeFrame({
              type: 'hello',
              protocol: 1,
              token: this.options.token,
              actor: this.options.actor,
            }),
          );
        } catch {
          fail('Controller authentication frame is invalid.');
        }
      });
      socket.on('data', (chunk) => {
        if (this.socket !== socket) return;
        try {
          for (const message of decoder.push(chunk)) {
            if (!welcomed) {
              if (message.type === 'error') {
                this.closed = true;
                fail(`Controller rejected the handshake: ${message.reason}.`);
                return;
              }
              if (message.type !== 'welcome') throw new Error('Expected controller welcome.');
              welcomed = true;
              this.connectedOnce = true;
              this.reconnectExhausted = false;
              if (!this.subscription) this.reconnectIndex = 0;
              socket.setTimeout(0);
              settled = true;
              this.connectionState('connected');
              resolve();
              if (this.subscription) void this.resynchronize(false);
            } else this.receive(message);
          }
        } catch {
          fail('Controller sent an invalid frame.');
        }
      });
      socket.on('error', () => fail('Controller connection failed.'));
      socket.once('close', () => {
        if (!settled) {
          settled = true;
          reject(new Error('Controller disconnected during handshake.'));
        }
        if (this.socket !== socket) return;
        this.socket = null;
        this.connectionState('offline');
        this.resyncing = false;
        for (const [key, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.resolve({
            outcome: 'outcome-unknown',
            reason: 'connection-lost',
            next: 'Read a fresh snapshot and retry the same command key if needed.',
          });
          this.pending.delete(key);
        }
        this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect() {
    if (this.closed || !this.connectedOnce || this.socket) return;
    const delays = this.options.reconnectDelaysMs ?? [
      250, 500, 1000, 2000, 5000, 10000, 20000, 30000,
    ];
    const delay = delays[this.reconnectIndex++];
    if (delay === undefined) {
      this.reconnectExhausted = true;
      for (const listener of this.exhaustedListeners) listener();
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open().catch(() => {});
    }, delay);
  }

  private receive(message: TransportMessage) {
    if (message.type === 'result' || message.type === 'snapshot') {
      const pending = this.pending.get(message.key);
      if (!pending) return;
      this.pending.delete(message.key);
      clearTimeout(pending.timer);
      pending.resolve(
        message.type === 'result'
          ? message.result
          : { outcome: 'applied', data: { kind: 'snapshot', snapshot: message.snapshot } },
      );
    } else if (message.type === 'event' && this.subscription) {
      const subscription = this.subscription;
      if (BigInt(message.event.cursor) <= BigInt(subscription.cursor)) return;
      subscription.event(message.event);
      subscription.cursor = message.event.cursor;
    } else if (message.type === 'resync' && this.subscription) {
      this.resyncRequested = true;
      void this.resynchronize();
    } else if (message.type === 'error') {
      this.socket?.destroy();
    }
  }

  command(input: Command): Promise<CommandResult> {
    const command = CommandSchema.parse(input);
    if (this.closed || this.state !== 'connected' || !this.socket)
      return Promise.reject(new Error('Controller is offline.'));
    if (this.pending.has(command.key))
      return Promise.reject(new Error('Command key is already pending.'));
    if (this.pending.size >= 128)
      return Promise.reject(new Error('Too many commands are pending.'));
    const socket = this.socket;
    const frame = encodeFrame({ type: 'command', command });
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(command.key);
          resolve({
            outcome: 'outcome-unknown',
            reason: 'response-timeout',
            next: 'Read a fresh snapshot and retry the same command key if needed.',
          });
        },
        this.options.timeoutMs ??
          (command.command === 'StartRun'
            ? 40000
            : command.command === 'CheckNativeConnection'
              ? 35000
              : command.command === 'AuthenticateGoogleAcp'
                ? 130000
                : command.command === 'InitializeGoogleAcp'
                  ? 15000
                  : ['ObserveUsage', 'DiscoverGoogleAcp', 'StopGoogleAcpSetup'].includes(
                        command.command,
                      )
                    ? 30000
                    : command.command === 'PrepareCandidateEvaluation' &&
                        command.payload.checkRecipeId === 'crewkite-verify-v1'
                      ? 65000
                      : 5000),
      );
      this.pending.set(command.key, { resolve, timer });
      socket.write(frame);
    });
  }

  private read(
    command: 'GetSnapshot' | 'Subscribe' | 'GetWorkspaceState' | 'GetProjectPage' | 'GetTaskPage',
    payload: Record<string, unknown>,
  ): Promise<CommandResult> {
    return this.command(
      CommandSchema.parse({
        protocol: 1,
        key: (this.options.nextKey ?? createCommandKey)(),
        actor: this.options.actor,
        command,
        payload,
      }),
    );
  }

  async snapshot(scope?: SnapshotScope): Promise<Snapshot> {
    const result = await this.read('GetSnapshot', scope ?? {});
    if (
      (result.outcome !== 'applied' && result.outcome !== 'already-applied') ||
      result.data?.kind !== 'snapshot'
    )
      throw new Error(`Snapshot unavailable: ${result.reason ?? result.outcome}.`);
    return result.data.snapshot;
  }

  private workspaceFailure(result: CommandResult): Error {
    if (result.outcome === 'unsupported') {
      this.pagingUnavailable = true;
      return new Error(
        'Workspace paging is unavailable with this controller. Use the matching controller package.',
      );
    }
    return new Error(`Workspace read unavailable: ${result.reason ?? result.outcome}.`);
  }

  async workspaceState() {
    const result = await this.read('GetWorkspaceState', {});
    if (result.outcome !== 'applied' || result.data?.kind !== 'workspace-state')
      throw this.workspaceFailure(result);
    return WorkspaceStateSchema.parse(result.data);
  }

  async projectPage(input: ProjectPageRequest) {
    const result = await this.read('GetProjectPage', input);
    if (result.outcome !== 'applied' || result.data?.kind !== 'project-page')
      throw this.workspaceFailure(result);
    return ProjectPageSchema.parse(result.data);
  }

  async taskPage(input: TaskPageRequest) {
    const result = await this.read('GetTaskPage', input);
    if (result.outcome !== 'applied' || result.data?.kind !== 'task-page')
      throw this.workspaceFailure(result);
    return TaskPageSchema.parse(result.data);
  }

  async subscribe(
    after: string,
    event: Subscription['event'],
    resync: Subscription['resync'] = () => {},
    options?: { resync: 'workspace'; onResync?: (header: WorkspaceState) => void },
  ): Promise<() => void> {
    if (this.subscription) throw new Error('This client already has a subscription.');
    const subscription = {
      cursor: CursorSchema.parse(after),
      event,
      resync,
      workspace: options?.resync === 'workspace',
      workspaceResync: options?.onResync,
    };
    this.subscription = subscription;
    try {
      const result = await this.read('Subscribe', { after });
      if (result.outcome !== 'applied' && result.outcome !== 'already-applied')
        throw new Error('Controller subscription failed.');
    } catch (error) {
      if (this.subscription === subscription) this.subscription = null;
      throw error;
    }
    return () => {
      if (this.subscription === subscription) this.subscription = null;
    };
  }

  private async resynchronize(freshSnapshot = true) {
    if (this.resyncing || !this.subscription) return;
    this.resyncing = true;
    const subscription = this.subscription;
    try {
      if (freshSnapshot) {
        this.resyncRequested = false;
        if (subscription.workspace) {
          const header = await this.workspaceState();
          if (this.subscription !== subscription) return;
          subscription.cursor = header.cursor;
          subscription.workspaceResync?.(header);
        } else {
          const snapshot = await this.snapshot();
          if (this.subscription !== subscription) return;
          subscription.resync(snapshot);
          subscription.cursor = snapshot.cursor;
        }
      }
      const result = await this.read('Subscribe', { after: subscription.cursor });
      if (result.outcome !== 'applied' && result.outcome !== 'already-applied')
        throw new Error('Controller subscription failed.');
      this.reconnectIndex = 0;
    } catch {
      if (subscription.workspace && this.pagingUnavailable) {
        this.closed = true;
        this.reconnectExhausted = true;
        for (const listener of this.exhaustedListeners) listener();
      }
      this.socket?.destroy();
    } finally {
      this.resyncing = false;
      if (this.resyncRequested && this.state === 'connected') void this.resynchronize();
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
  }
}

export async function connectController(options: Options): Promise<ControllerClient> {
  const client = new ControllerClient(options);
  await client.connect();
  return client;
}
