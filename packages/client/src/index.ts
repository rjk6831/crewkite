import type {
  Artifact,
  Command,
  CommandResult,
  DesktopNotice,
  Event,
  ProjectPage,
  ProjectPageRequest,
  Snapshot,
  SnapshotScope,
  TaskPage,
  TaskPageRequest,
  TransportMessage,
  WorkspaceState,
} from '@crewkite/contracts';
import { MAX_FRAME_BYTES, PROTOCOL_VERSION, TransportMessageSchema } from '@crewkite/contracts';

export type { Command, CommandResult, Snapshot, TransportMessage } from '@crewkite/contracts';
export type DesktopCommand = Command extends infer Item
  ? Item extends Command
    ? Omit<Item, 'protocol' | 'key' | 'actor'>
    : never
  : never;
export type ConnectionState = 'connecting' | 'connected' | 'offline';
export interface DesktopSource {
  getSnapshot(scope?: SnapshotScope): Promise<Snapshot>;
  workspaceState(): Promise<WorkspaceState>;
  projectPage(input: ProjectPageRequest): Promise<ProjectPage>;
  taskPage(input: TaskPageRequest): Promise<TaskPage>;
  command(input: DesktopCommand): Promise<CommandResult>;
  verifyArtifact?(input: {
    requestId: string;
    artifact: Artifact;
  }): Promise<{ integrity: 'whole-verified'; hash: string; bytes: number }>;
  cancelArtifactVerification?(requestId: string): Promise<void>;
  subscribe(onEvent: (event: Event) => void): () => void;
  onConnection?(listener: (state: ConnectionState) => void): () => void;
  pickProject?(): Promise<CommandResult | null>;
  reconnect?(): Promise<void>;
  retryCommand?(expected?: DesktopCommand): Promise<CommandResult | null>;
  onNotice?(listener: (notice: DesktopNotice) => void): () => void;
}

export class ProtocolError extends Error {
  readonly reason: 'protocol-mismatch' | 'invalid-frame';
  constructor(reason: 'protocol-mismatch' | 'invalid-frame') {
    super(reason);
    this.name = 'ProtocolError';
    this.reason = reason;
  }
}

function parseMessage(bytes: Uint8Array): TransportMessage {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (value !== null && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      const nested =
        object.type === 'command' ? object.command : object.type === 'event' ? object.event : null;
      const version =
        'protocol' in object
          ? object.protocol
          : nested !== null && typeof nested === 'object' && 'protocol' in nested
            ? nested.protocol
            : PROTOCOL_VERSION;
      if (version !== PROTOCOL_VERSION) throw new ProtocolError('protocol-mismatch');
    }
    const parsed = TransportMessageSchema.safeParse(value);
    if (!parsed.success) throw new ProtocolError('invalid-frame');
    return parsed.data;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    // Parser diagnostics can quote the authentication frame. Keep them off every output path.
    throw new ProtocolError('invalid-frame');
  }
}

export function encodeFrame(message: TransportMessage): Uint8Array {
  const parsed = TransportMessageSchema.safeParse(message);
  if (!parsed.success) throw new ProtocolError('invalid-frame');
  const content = new TextEncoder().encode(JSON.stringify(parsed.data));
  if (content.byteLength === 0 || content.byteLength > MAX_FRAME_BYTES)
    throw new ProtocolError('invalid-frame');
  const frame = new Uint8Array(content.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, content.byteLength, false);
  frame.set(content, 4);
  return frame;
}

export class FrameDecoder {
  private header = new Uint8Array(4);
  private headerBytes = 0;
  private body: Uint8Array | null = null;
  private bodyBytes = 0;
  private failed = false;

  push(chunk: Uint8Array): TransportMessage[] {
    if (this.failed) throw new ProtocolError('invalid-frame');
    const messages: TransportMessage[] = [];
    let offset = 0;
    try {
      while (offset < chunk.byteLength) {
        if (this.body === null) {
          const count = Math.min(4 - this.headerBytes, chunk.byteLength - offset);
          this.header.set(chunk.subarray(offset, offset + count), this.headerBytes);
          this.headerBytes += count;
          offset += count;
          if (this.headerBytes !== 4) continue;
          const length = new DataView(this.header.buffer).getUint32(0, false);
          if (length === 0 || length > MAX_FRAME_BYTES) throw new ProtocolError('invalid-frame');
          this.body = new Uint8Array(length);
        }
        const count = Math.min(this.body.byteLength - this.bodyBytes, chunk.byteLength - offset);
        this.body.set(chunk.subarray(offset, offset + count), this.bodyBytes);
        this.bodyBytes += count;
        offset += count;
        if (this.bodyBytes === this.body.byteLength) {
          messages.push(parseMessage(this.body));
          this.headerBytes = 0;
          this.body = null;
          this.bodyBytes = 0;
        }
      }
      return messages;
    } catch (error) {
      this.failed = true;
      this.body = null;
      throw error;
    }
  }

  finish(): void {
    if (this.failed || this.headerBytes !== 0 || this.body !== null)
      throw new ProtocolError('invalid-frame');
  }
}
