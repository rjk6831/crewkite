import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ConversationContextCapture,
  ConversationContextReceipt,
  ConversationContextRequest,
} from '@crewkite/client';
import { type ControllerClient, createCommandKey, transferArtifact } from '@crewkite/client/node';
import {
  ArtifactSchema,
  ArtifactVerificationSchema,
  type Command,
  CommandIdSchema,
  type CommandResult,
  CommandResultSchema,
  CommandSchema,
  canonicalJson,
  type DesktopNotice,
  DesktopNoticeSchema,
  type Event,
  EventSchema,
  MAX_FRAME_BYTES,
  ProjectIdSchema,
  SnapshotSchema,
  SnapshotScopeSchema,
} from '@crewkite/contracts';
import { type BrowserWindow, dialog, ipcMain } from 'electron';
import { CommandReceipts, syncDirectory } from './receipts.ts';
import { type DesktopController, desktopActor } from './runtime.ts';
import { assertSender } from './security.ts';

const verifications = new WeakMap<BrowserWindow, { requestId: string; abort: AbortController }>();
const validVerificationId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const applied = (result: CommandResult) =>
  result.outcome === 'applied' || result.outcome === 'already-applied';
export async function installBridge(window: BrowserWindow, controller: DesktopController) {
  verifications.get(window)?.abort.abort();
  let client: ControllerClient | null = null;
  let listening = false;
  let busy = false;
  let activeCommand: Command | null = null;
  let cancelling = false;
  const receipts = new CommandReceipts(controller.paths.home, controller.paths.profile);
  let connection: DesktopNotice = {
    kind: 'connection',
    state: 'connecting',
    reconnectAvailable: false,
  };
  let lastCursor = '0';
  let droppedThrough = '0';
  const events: Event[] = [];
  let eventBytes = 0;
  function notice(value: DesktopNotice) {
    const parsed = DesktopNoticeSchema.parse(value);
    if (!window.isDestroyed() && window.webContents.getURL() === 'app://crewkite/index.html')
      window.webContents.send('crewkite:notice', parsed);
  }
  function retain(command: Command, pending: boolean) {
    receipts.retain(command, pending);
    notice({ kind: 'retry', available: receipts.commands.length > 0 });
  }
  async function send(command: Command) {
    if (!client || (connection.kind === 'connection' && connection.state !== 'connected'))
      throw new Error('The controller is offline. Reconnect before sending a command.');
    const mutation = 'expectedRevision' in command;
    if (mutation) retain(command, true);
    const result = CommandResultSchema.parse(await client.command(command));
    if (mutation && result.outcome !== 'outcome-unknown') retain(command, false);
    return result;
  }
  async function save(result: CommandResult, assertCurrent: () => void) {
    const parsed = ArtifactSchema.safeParse(result.entity);
    if (!applied(result) || !parsed.success) return;
    const artifact = parsed.data;
    try {
      if (artifact.bytes > 64 * 1024 * 1024) throw new Error('The patch exceeds the save bound.');
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < artifact.bytes || offset === 0) {
        const part = await send(
          CommandSchema.parse({
            protocol: 1,
            key: createCommandKey(),
            actor: desktopActor,
            command: 'GetArtifact',
            payload: { artifactId: artifact.id, offset, limit: 65536 },
          }),
        );
        if (!applied(part) || part.data?.kind !== 'artifact')
          throw new Error('The patch is unavailable.');
        const data = part.data;
        if (
          canonicalJson(data.artifact) !== canonicalJson(artifact) ||
          data.offset !== offset ||
          data.encoding !== 'base64'
        )
          throw new Error('The patch identity changed.');
        const bytes = Buffer.from(data.content, 'base64');
        if (
          bytes.toString('base64') !== data.content ||
          bytes.length > 65536 ||
          (bytes.length === 0 && offset !== artifact.bytes)
        )
          throw new Error('The patch chunk is invalid.');
        chunks.push(bytes);
        offset += bytes.length;
        if (offset > artifact.bytes || data.eof !== (offset === artifact.bytes))
          throw new Error('The patch length changed.');
        if (data.eof) break;
      }
      const bytes = Buffer.concat(chunks);
      if (
        bytes.length !== artifact.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== artifact.hash
      )
        throw new Error('The patch checksum changed.');
      assertCurrent();
      const choice = await dialog.showSaveDialog(window, {
        title: 'Save exported patch',
        defaultPath: 'candidate.patch',
        filters: [{ name: 'Patch', extensions: ['patch'] }],
      });
      assertCurrent();
      if (choice.canceled || !choice.filePath) {
        notice({ kind: 'export', artifactId: artifact.id, outcome: 'cancelled' });
        return;
      }
      const file = openSync(
        choice.filePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(file, bytes);
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      syncDirectory(dirname(choice.filePath));
      notice({ kind: 'export', artifactId: artifact.id, outcome: 'saved' });
    } catch {
      notice({ kind: 'export', artifactId: artifact.id, outcome: 'failed' });
    }
  }
  async function execute(command: Command, assertCurrent: () => void) {
    const exportResult =
      command.command === 'ExportPatch' ||
      (command.command === 'ResolveApproval' &&
        command.payload.decision === 'approved' &&
        command.payload.binding.action === 'export-patch');
    const result = await send(command);
    if (exportResult) await save(result, assertCurrent);
    return result;
  }
  const handlers = [
    'snapshot',
    'command',
    'pick-project',
    'pick-context',
    'retry-context',
    'reconnect',
    'retry',
    'events',
    'verify-artifact',
    'cancel-artifact-verification',
  ];
  for (const channel of handlers) ipcMain.removeHandler(`crewkite:${channel}`);
  ipcMain.handle('crewkite:verify-artifact', async (event, input: unknown) => {
    assertSender(event, window);
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length !== 2 ||
      !('requestId' in input) ||
      !('artifact' in input) ||
      !validVerificationId(input.requestId)
    )
      throw Error('Output verification request is invalid.');
    const artifact = ArtifactSchema.parse(input.artifact);
    if (!client) throw Error('The controller is offline.');
    if (verifications.has(window)) throw Error('Another output verification is still finishing.');
    const reader = client;
    const operation = { requestId: input.requestId, abort: new AbortController() };
    verifications.set(window, operation);
    try {
      const proof = await transferArtifact(
        artifact,
        (request) => reader.artifactRange(request),
        () => {},
        { signal: operation.abort.signal },
      );
      assertSender(event, window);
      return ArtifactVerificationSchema.parse(proof);
    } finally {
      if (verifications.get(window) === operation) verifications.delete(window);
    }
  });
  ipcMain.handle('crewkite:cancel-artifact-verification', (event, requestId: unknown) => {
    assertSender(event, window);
    if (!validVerificationId(requestId)) throw Error('Output verification identity is invalid.');
    const operation = verifications.get(window);
    if (operation?.requestId === requestId) operation.abort.abort();
  });
  ipcMain.handle('crewkite:snapshot', async (event, scope: unknown) => {
    assertSender(event, window);
    if (!client) throw new Error('The controller is offline.');
    const snapshot = SnapshotSchema.parse(
      await client.snapshot(SnapshotScopeSchema.parse(scope ?? {})),
    );
    assertSender(event, window);
    return snapshot;
  });
  ipcMain.handle('crewkite:command', async (event, input: unknown) => {
    assertSender(event, window);
    const bytes = JSON.stringify(input);
    if (
      !bytes ||
      Buffer.byteLength(bytes) > MAX_FRAME_BYTES ||
      input === null ||
      typeof input !== 'object' ||
      Array.isArray(input)
    )
      throw new Error('The desktop command is invalid.');
    const value = input as Record<string, unknown>;
    if (
      'protocol' in value ||
      'key' in value ||
      'actor' in value ||
      value.command === 'RegisterProject' ||
      value.command === 'CaptureConversationContext'
    )
      throw new Error('The desktop command requests trusted metadata or a native-only action.');
    const command = CommandSchema.parse({
      ...value,
      protocol: 1,
      key: createCommandKey(),
      actor: desktopActor,
    });
    if (
      [
        'GetWorkspaceState',
        'GetProjectPage',
        'GetTaskPage',
        'GetTaskActivityPage',
        'GetArtifactRange',
        'GetTaskOperations',
        'GetProjectOperation',
        'PrepareProjectCommand',
        'StartProjectCommand',
        'ReadGitHub',
        'StopProjectOperation',
        'ObserveUsage',
        'RefreshAnthropicUsage',
        'StopAnthropicUsage',
        'CheckNativeConnection',
        'RefreshTaskModelCatalog',
        'InstallGoogleAcp',
        'StopGoogleAcpInstall',
        'InitializeGoogleAcp',
        'AuthenticateGoogleAcp',
        'DiscoverGoogleAcp',
        'StopGoogleAcpSetup',
      ].includes(command.command)
    ) {
      if (!client) throw new Error('The controller is offline.');
      const result = CommandResultSchema.parse(await client.command(command));
      assertSender(event, window);
      return result;
    }
    const stopSetup = command.command === 'StopGoogleAcpSetup';
    const setupCommands = ['InitializeGoogleAcp', 'AuthenticateGoogleAcp', 'DiscoverGoogleAcp'];
    const matchesSetup =
      stopSetup &&
      activeCommand?.key === command.payload.operationId &&
      setupCommands.includes(activeCommand.command);
    const matchesStart =
      command.command === 'StopRun' &&
      activeCommand?.command === 'StartRun' &&
      activeCommand.payload.taskId === command.payload.taskId &&
      activeCommand.payload.runId === command.payload.runId;
    const cancellation = stopSetup || matchesStart;
    if (cancelling || (busy && !(matchesSetup || matchesStart)))
      throw new Error('Wait for the pending desktop command.');
    if (
      receipts.commands.length &&
      'expectedRevision' in command &&
      command.command !== 'StopRun' &&
      !cancellation
    )
      throw new Error('Resolve the uncertain command with exact retry before another change.');
    if (
      command.command === 'StopRun' &&
      receipts.commands.some(
        (item) => item.command === 'StopRun' && item.payload.taskId === command.payload.taskId,
      )
    )
      throw new Error('Retry the existing uncertain stop with its exact command key.');
    if (
      stopSetup &&
      receipts.commands.some(
        (item) =>
          item.command === 'StopGoogleAcpSetup' &&
          item.payload.operationId === command.payload.operationId,
      )
    )
      throw new Error('Retry the existing uncertain setup stop with its exact command key.');
    if (cancellation) cancelling = true;
    else {
      busy = true;
      activeCommand = command;
    }
    try {
      if (stopSetup) {
        const setup = (await client?.workspaceState())?.googleAcpSetup;
        assertSender(event, window);
        if (
          !setup ||
          setup.operationId !== command.payload.operationId ||
          setup.revision !== command.expectedRevision
        )
          throw new Error('The setup operation changed. Read its current state before stopping.');
      }
      const result = await execute(command, () => assertSender(event, window));
      assertSender(event, window);
      return result;
    } finally {
      if (cancellation) cancelling = false;
      else {
        busy = false;
        activeCommand = null;
      }
    }
  });
  ipcMain.handle('crewkite:pick-project', async (event) => {
    assertSender(event, window);
    if (busy || cancelling || receipts.commands.length)
      throw new Error('Resolve the pending desktop command first.');
    busy = true;
    try {
      const choice = await dialog.showOpenDialog(window, {
        title: 'Choose a project',
        properties: ['openDirectory'],
      });
      assertSender(event, window);
      if (choice.canceled || choice.filePaths.length !== 1) return null;
      const result = await send(
        CommandSchema.parse({
          protocol: 1,
          key: createCommandKey(),
          actor: desktopActor,
          expectedRevision: 0,
          command: 'RegisterProject',
          payload: { path: choice.filePaths[0] },
        }),
      );
      assertSender(event, window);
      return result;
    } finally {
      busy = false;
    }
  });
  function contextScope(input: unknown, retry: false): ConversationContextRequest;
  function contextScope(input: unknown, retry: true): ConversationContextReceipt;
  function contextScope(input: unknown, retry: boolean) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('The context selection is invalid.');
    const keys = Object.keys(input);
    const allowed = retry ? ['receiptId', 'projectId', 'base'] : ['projectId', 'base', 'mode'];
    if (
      keys.length !== allowed.length ||
      keys.some((key) => !allowed.includes(key)) ||
      !('projectId' in input) ||
      !('base' in input) ||
      typeof input.base !== 'string' ||
      !/^[a-f0-9]{40}$/.test(input.base)
    )
      throw new Error('The context selection is invalid.');
    const projectId = ProjectIdSchema.parse(input.projectId);
    const base = input.base;
    if (retry) {
      if (!('receiptId' in input)) throw new Error('The context receipt is missing.');
      return { projectId, base, receiptId: CommandIdSchema.parse(input.receiptId) };
    }
    if (
      !('mode' in input) ||
      (input.mode !== 'source-file' && input.mode !== 'source-folder' && input.mode !== 'log-file')
    )
      throw new Error('The context selection mode is invalid.');
    return { projectId, base, mode: input.mode };
  }
  async function capture(
    command: Extract<Command, { command: 'CaptureConversationContext' }>,
    assertCurrent: () => void,
  ): Promise<ConversationContextCapture> {
    try {
      const result = await send(command);
      assertCurrent();
      return { receiptId: command.key, result };
    } catch (failure) {
      assertCurrent();
      if (!receipts.commands.some((item) => item.key === command.key)) throw failure;
      return { receiptId: command.key, result: null };
    }
  }
  ipcMain.handle('crewkite:pick-context', async (event, input: unknown) => {
    assertSender(event, window);
    const scope = contextScope(input, false);
    if (busy || cancelling || receipts.commands.length)
      throw new Error('Resolve the pending desktop command first.');
    busy = true;
    try {
      if (!client) throw new Error('The controller is offline.');
      const beforeHeader = await client.workspaceState();
      const before = (
        await client.projectPage({ stamp: beforeHeader.stamp, projectId: scope.projectId })
      ).projects[0];
      assertSender(event, window);
      if (!before) throw new Error('The registered project is unavailable.');
      const choice = await dialog.showOpenDialog(window, {
        title: scope.mode === 'log-file' ? 'Choose a project log' : 'Choose project source',
        message:
          scope.mode === 'source-folder'
            ? 'Committed nonempty UTF-8 files inside the project. Up to 32 files, 8 KiB each, 32 KiB encoded total.'
            : scope.mode === 'log-file'
              ? 'Nonempty UTF-8 log inside the project, outside hidden folders. 8 KiB at most.'
              : 'Committed nonempty UTF-8 file inside the project. 8 KiB at most.',
        properties: [scope.mode === 'source-folder' ? 'openDirectory' : 'openFile'],
      });
      assertSender(event, window);
      if (choice.canceled) return null;
      if (choice.filePaths.length !== 1) throw new Error('Choose one project file or folder.');
      const afterHeader = await client.workspaceState();
      const after = (
        await client.projectPage({ stamp: afterHeader.stamp, projectId: scope.projectId })
      ).projects[0];
      assertSender(event, window);
      if (!after || after.revision !== before.revision)
        throw new Error('The project changed. Choose context again.');
      const command = CommandSchema.parse({
        protocol: 1,
        key: createCommandKey(),
        actor: desktopActor,
        command: 'CaptureConversationContext',
        expectedRevision: after.revision,
        payload: {
          projectId: scope.projectId,
          base: scope.base,
          selections: [{ kind: scope.mode, path: choice.filePaths[0] }],
        },
      });
      if (command.command !== 'CaptureConversationContext')
        throw new Error('The context command is invalid.');
      activeCommand = command;
      return await capture(command, () => assertSender(event, window));
    } finally {
      busy = false;
      activeCommand = null;
    }
  });
  ipcMain.handle('crewkite:retry-context', async (event, input: unknown) => {
    assertSender(event, window);
    const scope = contextScope(input, true);
    if (busy || cancelling) throw new Error('Wait for the pending desktop command.');
    const command = receipts.commands[0];
    if (
      receipts.commands.length !== 1 ||
      command?.command !== 'CaptureConversationContext' ||
      command.key !== scope.receiptId ||
      command.payload.projectId !== scope.projectId ||
      command.payload.base !== scope.base
    )
      throw new Error('The retained context receipt does not match this draft.');
    busy = true;
    activeCommand = command;
    try {
      return await capture(command, () => assertSender(event, window));
    } finally {
      busy = false;
      activeCommand = null;
    }
  });
  ipcMain.handle('crewkite:retry', async (event, expected: unknown) => {
    assertSender(event, window);
    if (busy || cancelling) throw new Error('Wait for the pending desktop command.');
    const command = receipts.commands[0];
    if (expected !== undefined) {
      if (
        !expected ||
        typeof expected !== 'object' ||
        Array.isArray(expected) ||
        Buffer.byteLength(JSON.stringify(expected)) > MAX_FRAME_BYTES ||
        'protocol' in expected ||
        'key' in expected ||
        'actor' in expected
      )
        throw new Error('The expected desktop command is invalid.');
      const parsed = CommandSchema.parse({
        ...expected,
        protocol: 1,
        key: createCommandKey(),
        actor: desktopActor,
      });
      const normalize = ({ protocol: _protocol, key: _key, actor: _actor, ...value }: Command) =>
        value;
      if (!command || canonicalJson(normalize(parsed)) !== canonicalJson(normalize(command)))
        throw new Error('The retained command does not match this draft.');
    }
    if (!command) return null;
    busy = true;
    activeCommand = command;
    try {
      const result = await execute(command, () => assertSender(event, window));
      assertSender(event, window);
      return result;
    } finally {
      busy = false;
      activeCommand = null;
    }
  });
  ipcMain.handle('crewkite:events', (event) => {
    assertSender(event, window);
    listening = true;
    notice(connection);
    notice({ kind: 'retry', available: receipts.commands.length > 0 });
    if (droppedThrough !== '0') notice({ kind: 'history-gap', after: droppedThrough });
    for (const row of events) window.webContents.send('crewkite:event', row);
  });
  ipcMain.handle('crewkite:reconnect', async (event) => {
    assertSender(event, window);
    if (!client) await connect();
    else await client.connect();
    assertSender(event, window);
  });
  window.webContents.on('did-start-loading', () => {
    listening = false;
  });
  window.once('closed', () => {
    verifications.get(window)?.abort.abort();
    for (const channel of handlers) ipcMain.removeHandler(`crewkite:${channel}`);
  });
  async function connect() {
    try {
      receipts.load();
      client = await controller.connect();
      client.onConnection((state) => {
        connection = { kind: 'connection', state, reconnectAvailable: state === 'offline' };
        notice(connection);
      });
      client.onReconnectExhausted(() => {
        connection = { kind: 'connection', state: 'offline', reconnectAvailable: true };
        notice(connection);
      });
      await client.subscribe(
        '0',
        (value) => {
          const event = EventSchema.parse(value);
          if (BigInt(event.cursor) <= BigInt(lastCursor)) return;
          lastCursor = event.cursor;
          events.push(event);
          eventBytes += Buffer.byteLength(JSON.stringify(event));
          while (events.length > 1000 || eventBytes > MAX_FRAME_BYTES) {
            const dropped = events.shift();
            if (!dropped) break;
            eventBytes -= Buffer.byteLength(JSON.stringify(dropped));
            droppedThrough = dropped.cursor;
          }
          if (listening && !window.isDestroyed()) window.webContents.send('crewkite:event', event);
        },
        undefined,
        {
          resync: 'workspace',
          onResync: (header) => {
            events.length = 0;
            eventBytes = 0;
            lastCursor = header.cursor;
            droppedThrough = header.cursor;
            notice({ kind: 'history-gap', after: header.cursor });
          },
        },
      );
    } catch {
      controller.resetClient();
      client = null;
      connection = { kind: 'connection', state: 'offline', reconnectAvailable: true };
      notice(connection);
    }
  }
  await connect();
}
