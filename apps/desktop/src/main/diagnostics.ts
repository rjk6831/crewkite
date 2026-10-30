import { createCommandKey, writeDiagnosticsFolder } from '@crewkite/client/node';
import {
  type Command,
  type CommandResult,
  CommandSchema,
  type DesktopNotice,
  DiagnosticsReadSchema,
} from '@crewkite/contracts';
import { app, type BrowserWindow, dialog, ipcMain } from 'electron';
import {
  dismissCrash,
  unseenCrash,
  writeCrashRecord,
} from '../../../controller/src/diagnostics/crash.ts';
import { appendControllerLog } from '../../../controller/src/diagnostics/log.ts';
import { TASK_ID_PATTERN } from '../shared/thread-notice.ts';
import { desktopActor } from './runtime.ts';
import { assertSender } from './security.ts';

// Export diagnostics and the line about an unexpected close. Main reads the bundle from the
// controller, lists it for the person, and writes it where they choose. The page supplies at
// most a thread ID and never any bytes. Nothing leaves the computer.

/** Records a window process that ended badly, so the next launch can say so. */
export function watchRendererCrashes(window: BrowserWindow, home: string) {
  window.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    const detail = `${details.reason}, exit code ${details.exitCode}`;
    writeCrashRecord(home, {
      source: 'renderer',
      kind: 'render-process-gone',
      message: 'The window process ended.',
      detail,
    });
    appendControllerLog(home, `renderer render-process-gone: ${detail}`);
  });
}

const kilobytes = (text: string) => `${Math.max(1, Math.ceil(Buffer.byteLength(text) / 1024))} KB`;

export function installDiagnostics(deps: {
  window: BrowserWindow;
  home: string;
  send: (command: Command) => Promise<CommandResult>;
  notice: (notice: DesktopNotice) => void;
}) {
  const { window, home } = deps;
  // The record the last run left, read once at launch. A crash in this session waits for the
  // next launch, and dismissing hides only the record the line was about.
  let shown = unseenCrash(home);
  ipcMain.handle('crewkite:export-diagnostics', async (event, input: unknown) => {
    assertSender(event, window);
    const requested =
      input && typeof input === 'object' ? (input as { taskId?: unknown }).taskId : undefined;
    if (
      requested !== undefined &&
      (typeof requested !== 'string' || !TASK_ID_PATTERN.test(requested))
    )
      throw new Error('The thread is not valid.');
    const result = await deps.send(
      CommandSchema.parse({
        protocol: 1,
        key: createCommandKey(),
        actor: desktopActor,
        command: 'ReadDiagnostics',
        payload: {
          ...(requested ? { taskId: requested } : {}),
          desktop: {
            app: app.getVersion(),
            electron: process.versions.electron,
            chrome: process.versions.chrome,
          },
        },
      }),
    );
    const parsed =
      result.outcome === 'applied' && result.data?.kind === 'diagnostic-files'
        ? DiagnosticsReadSchema.safeParse({ files: result.data.files })
        : null;
    if (!parsed?.success) throw new Error('The diagnostics could not be read.');
    const answer = await dialog.showMessageBox(window, {
      type: 'info',
      title: 'Export diagnostics',
      message: 'The export is a folder with these files.',
      detail: `${parsed.data.files
        .map((file) => `${file.name} (${kilobytes(file.text)}): ${file.about}`)
        .join(
          '\n\n',
        )}\n\nSecrets, your home folder and email addresses are removed. Nothing is sent anywhere.`,
      buttons: ['Choose where to save', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    assertSender(event, window);
    if (answer.response !== 0) return 'cancelled';
    const choice = await dialog.showSaveDialog(window, {
      title: 'Save diagnostics folder',
      defaultPath: `crewkite-diagnostics-${new Date().toISOString().slice(0, 10)}`,
      properties: ['createDirectory'],
    });
    assertSender(event, window);
    if (choice.canceled || !choice.filePath) return 'cancelled';
    writeDiagnosticsFolder(parsed.data.files, choice.filePath);
    return 'saved';
  });
  ipcMain.handle('crewkite:dismiss-crash', (event) => {
    assertSender(event, window);
    if (shown) dismissCrash(home, shown.name);
    shown = null;
    deps.notice({ kind: 'crash', at: null });
  });
  return {
    /** Tells the page about the last unexpected close, if the person has not dismissed it. */
    announce() {
      if (shown) deps.notice({ kind: 'crash', at: shown.at });
    },
  };
}
