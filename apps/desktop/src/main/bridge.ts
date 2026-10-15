import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type ControllerClient, createCommandKey } from '@crewkite/client/node';
import {
  ArtifactSchema,
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
  SnapshotSchema,
} from '@crewkite/contracts';
import { type BrowserWindow, dialog, ipcMain } from 'electron';
import { CommandReceipts, syncDirectory } from './receipts.ts';
import { type DesktopController, desktopActor } from './runtime.ts';
import { assertSender } from './security.ts';

const applied = (result: CommandResult) =>
  result.outcome === 'applied' || result.outcome === 'already-applied';
export async function installBridge(window: BrowserWindow, controller: DesktopController) {
  let client: ControllerClient | null = null;
  let listening = false;
  let busy = false;
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
  const handlers = ['snapshot', 'command', 'pick-project', 'reconnect', 'retry', 'events'];
  for (const channel of handlers) ipcMain.removeHandler(`crewkite:${channel}`);
  ipcMain.handle('crewkite:snapshot', async (event) => {
    assertSender(event, window);
    if (!client) throw new Error('The controller is offline.');
    const snapshot = SnapshotSchema.parse(await client.snapshot());
    assertSender(event, window);
    return snapshot;
  });
  ipcMain.handle('crewkite:command', async (event, input: unknown) => {
    assertSender(event, window);
    if (busy) throw new Error('Wait for the pending desktop command.');
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
    if (receipts.commands.length && 'expectedRevision' in command && command.command !== 'StopRun')
      throw new Error('Resolve the uncertain command with exact retry before another change.');
    if (
      command.command === 'StopRun' &&
      receipts.commands.some(
        (item) => item.command === 'StopRun' && item.payload.taskId === command.payload.taskId,
      )
    )
      throw new Error('Retry the existing uncertain stop with its exact command key.');
    busy = true;
    try {
      const result = await execute(command, () => assertSender(event, window));
      assertSender(event, window);
      return result;
    } finally {
      busy = false;
    }
  });
  ipcMain.handle('crewkite:pick-project', async (event) => {
    assertSender(event, window);
    if (busy || receipts.commands.length)
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
  ipcMain.handle('crewkite:retry', async (event) => {
    assertSender(event, window);
    if (busy) throw new Error('Wait for the pending desktop command.');
    if (!receipts.commands.length) return null;
    busy = true;
    try {
      const result = await execute(receipts.commands[0], () => assertSender(event, window));
      assertSender(event, window);
      return result;
    } finally {
      busy = false;
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
        (snapshot) => {
          droppedThrough = snapshot.cursor;
          notice({ kind: 'history-gap', after: snapshot.cursor });
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
