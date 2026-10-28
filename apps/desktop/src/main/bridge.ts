import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  openSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, relative, sep } from 'node:path';
import { type ControllerClient, createCommandKey, transferArtifact } from '@crewkite/client/node';
import {
  ArtifactSchema,
  ArtifactVerificationSchema,
  type Command,
  type CommandResult,
  CommandResultSchema,
  CommandSchema,
  canonicalJson,
  type DesktopNotice,
  DesktopNoticeSchema,
  type Event,
  EventSchema,
  MAX_FRAME_BYTES,
  type McpServerInput,
  type McpState,
  SnapshotSchema,
  SnapshotScopeSchema,
} from '@crewkite/contracts';
import { type BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { attachRequest } from '../shared/attach.ts';
import { attachmentTarget, PREVIEW_EXTENSIONS } from '../shared/open-file.ts';
import { ComposerFiles } from './attach.ts';
import { PathGrants, storedAttachmentPath } from './grants.ts';
import {
  controllerPort,
  LocalTokenVault,
  RememberedLocalToken,
  type SecretStorage,
} from './local-token.ts';
import { McpVault, supplyMcp } from './mcp-vault.ts';
import { CommandReceipts, syncDirectory } from './receipts.ts';
import { type DesktopController, desktopActor } from './runtime.ts';
import { assertSender, openExternalLink } from './security.ts';

const verifications = new WeakMap<BrowserWindow, { requestId: string; abort: AbortController }>();
const validVerificationId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const applied = (result: CommandResult) =>
  result.outcome === 'applied' || result.outcome === 'already-applied';
export async function installBridge(
  window: BrowserWindow,
  controller: DesktopController,
  storage: SecretStorage = safeStorage,
) {
  verifications.get(window)?.abort.abort();
  let client: ControllerClient | null = null;
  let listening = false;
  let busy = false;
  let activeCommand: Command | null = null;
  let cancelling = false;
  const receipts = new CommandReceipts(controller.paths.home, controller.paths.profile);
  const grants = new PathGrants();
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
    'reconnect',
    'retry',
    'events',
    'verify-artifact',
    'cancel-artifact-verification',
    'open-link',
    'attach',
    'open-attachment',
    'local-token-status',
    'local-token-remember',
    'local-token-forget',
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
      value.command === 'RegisterProject'
    )
      throw new Error('The desktop command requests trusted metadata or a native-only action.');
    const command = CommandSchema.parse({
      ...value,
      protocol: 1,
      key: createCommandKey(),
      actor: desktopActor,
    });
    const refused = grants.refusal(command);
    if (refused) throw new Error(refused);
    if (
      [
        'GetWorkspaceState',
        'GetProjectPage',
        'GetTaskPage',
        'GetTaskActivityPage',
        'GetArtifactRange',
        'GetTaskOperations',
        'ReadChatThread',
        'ReadChatTurnEvents',
        'ReadChatChanges',
        'ReadChatCatalog',
        'RefreshChatModels',
        'ReadChatBranchStatus',
        'PushChatBranch',
        'OpenChatPullRequest',
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
    // A chat turn runs on its own in the controller. Its stop, and a steer that stops it, have to
    // get through while another desktop command holds the lock or waits for an exact retry, so
    // they neither wait for a lock nor take one.
    const stopTurn = command.command === 'StopChatTurn' || command.command === 'SteerChatMessage';
    const cancellation = stopSetup || matchesStart || stopTurn;
    if (!stopTurn && (cancelling || (busy && !(matchesSetup || matchesStart))))
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
      command.command === 'StopChatTurn' &&
      receipts.commands.some(
        (item) => item.command === 'StopChatTurn' && item.payload.turnId === command.payload.turnId,
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
    const lock = stopTurn ? null : cancellation ? 'cancelling' : 'busy';
    if (lock === 'cancelling') cancelling = true;
    if (lock === 'busy') {
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
      // A remembered token goes to the controller in memory first, so the connect that follows
      // uses it with no token window. Without one, or when the hand over fails, the window asks.
      if (command.command === 'BeginLocalConnectionInput') {
        await tokens.supply().catch(() => false);
        assertSender(event, window);
      }
      const result = await execute(command, () => assertSender(event, window));
      if (command.command === 'ConfigureLocal' && applied(result))
        await tokens.reconcile().catch(() => {});
      assertSender(event, window);
      return result;
    } finally {
      if (lock === 'cancelling') cancelling = false;
      if (lock === 'busy') {
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
  ipcMain.handle('crewkite:open-link', (event, url: unknown) => {
    assertSender(event, window);
    return openExternalLink(window, url);
  });
  // Reading the setup fails while the controller is offline. That must not look like no setup,
  // because no setup deletes the remembered token.
  const tokens = new RememberedLocalToken(
    new LocalTokenVault(controller.paths.profile, storage),
    controllerPort(async (command) => {
      if (!client) throw new Error('The controller is offline.');
      return client.command(command);
    }, desktopActor),
    async () => {
      if (!client) throw new Error('The controller is offline.');
      return (await client.workspaceState()).localSetup ?? null;
    },
    async (revision) => {
      await send(
        CommandSchema.parse({
          protocol: 1,
          key: createCommandKey(),
          actor: desktopActor,
          expectedRevision: revision,
          command: 'DisconnectLocal',
          payload: {},
        }),
      );
    },
  );
  // The person's MCP servers. Main keeps the secrets and the renderer gets the view only. Every
  // change goes to the controller in memory, so a thread's next turn sees it.
  const mcp = new McpVault(controller.paths.profile, storage);
  const handOver = async () => {
    if (client)
      await supplyMcp(
        mcp,
        (value) => client?.command(value) ?? Promise.resolve(null),
        desktopActor,
      );
  };
  const mcpCall = (name: string, run: (input: Record<string, unknown>) => McpState) => {
    ipcMain.handle(`crewkite:mcp-${name}`, async (event, input: unknown) => {
      assertSender(event, window);
      const state = run((input ?? {}) as Record<string, unknown>);
      await handOver().catch(() => {});
      return state;
    });
  };
  ipcMain.handle('crewkite:mcp-state', (event) => {
    assertSender(event, window);
    return mcp.state();
  });
  mcpCall('save', (input) => mcp.save(input as McpServerInput));
  mcpCall('remove', (input) => mcp.remove(String(input.name)));
  mcpCall('thread', (input) =>
    mcp.setThread(
      String(input.taskId),
      String(input.name),
      (input.policy as string | null) ?? null,
    ),
  );
  ipcMain.handle('crewkite:local-token-status', async (event) => {
    assertSender(event, window);
    return tokens.status();
  });
  ipcMain.handle('crewkite:local-token-remember', async (event) => {
    assertSender(event, window);
    return tokens.remember();
  });
  ipcMain.handle('crewkite:local-token-forget', async (event) => {
    assertSender(event, window);
    return tokens.forget();
  });
  const files = new ComposerFiles(window, grants);
  ipcMain.handle('crewkite:attach', async (event, input: unknown) => {
    assertSender(event, window);
    const request = attachRequest(input);
    if (!request) throw new Error('The file request is invalid.');
    const found = await files.find(request);
    assertSender(event, window);
    return found;
  });
  // A stored attachment, named by thread, hash and name. Main builds the path under the controller
  // home and refuses a link that leaves the thread's files folder.
  ipcMain.handle('crewkite:open-attachment', async (event, input: unknown) => {
    assertSender(event, window);
    const target = attachmentTarget(input);
    const path = target && storedAttachmentPath(controller.paths.home, target);
    if (!target || !path) throw new Error('That file is not one this thread stored.');
    let real: string;
    try {
      real = realpathSync(path);
      const inside = relative(realpathSync(dirname(dirname(path))), real);
      if (inside.startsWith(`..${sep}`) || inside === '..' || !statSync(real).isFile())
        throw new Error('outside');
    } catch {
      throw new Error('The stored file is missing.');
    }
    if (target.action === 'reveal') {
      shell.showItemInFolder(real);
      return 'done';
    }
    if (target.action === 'save') {
      const choice = await dialog.showSaveDialog(window, {
        title: 'Save a copy',
        defaultPath: target.name,
      });
      assertSender(event, window);
      if (choice.canceled || !choice.filePath) return 'cancelled';
      if (choice.filePath === real) throw new Error('Choose a different place to save the copy.');
      copyFileSync(real, choice.filePath);
      return 'done';
    }
    // Opening a file hands it to the system, which would run a script or an app. Only a picture or
    // a PDF opens, whatever the page says its type is.
    if (!PREVIEW_EXTENSIONS.has(extname(target.name).toLowerCase()))
      throw new Error('Only a picture or a PDF opens here. Use Save as for other files.');
    if (process.platform === 'darwin') window.previewFile(real, target.name);
    else {
      const failed = await shell.openPath(real);
      if (failed) throw new Error('The system could not open this file.');
    }
    return 'done';
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
    files.close();
    for (const channel of handlers) ipcMain.removeHandler(`crewkite:${channel}`);
  });
  async function connect() {
    try {
      receipts.load();
      client = await controller.connect();
      await handOver().catch(() => {});
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
