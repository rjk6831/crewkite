import { join } from 'node:path';
import { app, BrowserWindow, protocol, session } from 'electron';
import { installThreadAttention } from './attention.ts';
import { installBridge } from './bridge.ts';
import { DesktopController, prepareStateDirectory, resolveRuntime } from './runtime.ts';
import { rendererURL, secureSession, secureWindow } from './security.ts';

let ownedController: DesktopController | null = null;
async function start() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
  const paths = resolveRuntime(app.getAppPath());
  for (const directory of [
    join(paths.profile, 'session'),
    join(paths.profile, 'logs'),
    join(paths.profile, 'crashes'),
  ])
    prepareStateDirectory(paths.profile, directory);
  app.setPath('userData', paths.profile);
  app.setPath('sessionData', join(paths.profile, 'session'));
  app.setPath('crashDumps', join(paths.profile, 'crashes'));
  app.setAppLogsPath(join(paths.profile, 'logs'));
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    const controller = new DesktopController(paths);
    ownedController = controller;
    let closing = false;
    let window: BrowserWindow | null = null;
    app.on('second-instance', () => {
      window?.show();
      window?.focus();
    });
    app.on('before-quit', (event) => {
      if (closing) return;
      event.preventDefault();
      closing = true;
      void controller.close().finally(() => app.quit());
    });
    app.on('window-all-closed', () => app.quit());
    await app.whenReady();
    secureSession(session.defaultSession, join(app.getAppPath(), 'out/renderer'));
    window = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1080,
      minHeight: 700,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(app.getAppPath(), 'out/preload/index.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        webSecurity: true,
        navigateOnDragDrop: false,
      },
    });
    secureWindow(window);
    await installBridge(window, controller);
    installThreadAttention(window);
    if (closing || window.isDestroyed()) return;
    await window.loadURL(rendererURL);
    window.show();
  }
}
void start().catch(async (error: unknown) => {
  console.error(
    `Desktop startup failed: ${error instanceof Error ? error.message.slice(0, 512) : 'unknown error'}`,
  );
  await ownedController?.close();
  app.exit(1);
});
