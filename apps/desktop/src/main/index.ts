import { join } from 'node:path';
import { app, BrowserWindow, nativeTheme, protocol, screen, session } from 'electron';
import { installThreadAttention } from './attention.ts';
import { installBridge } from './bridge.ts';
import { installOnboarding } from './onboarding-ipc.ts';
import { OnboardingStore } from './onboarding-store.ts';
import { DesktopController, prepareStateDirectory, resolveRuntime } from './runtime.ts';
import { rendererURL, secureSession, secureWindow } from './security.ts';
import { BoundsStore, clampBounds, MINIMUM_SIZE } from './window-bounds.ts';

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
    const bounds = new BoundsStore(paths.profile);
    window = new BrowserWindow({
      ...clampBounds(
        bounds.load(),
        screen.getAllDisplays().map((display) => display.workArea),
      ),
      minWidth: MINIMUM_SIZE.width,
      minHeight: MINIMUM_SIZE.height,
      // The page paints its own theme after load. This color keeps the first frame from flashing.
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#151718' : '#f7f8f5',
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
    // Move and resize fire many times a second, so the file is written once the window settles.
    let settle: NodeJS.Timeout | undefined;
    const remember = (target: BrowserWindow) => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        if (!target.isDestroyed()) bounds.save(target.getNormalBounds());
      }, 400);
    };
    window.on('move', () => window && remember(window));
    window.on('resize', () => window && remember(window));
    window.on('close', () => {
      clearTimeout(settle);
      if (window && !window.isDestroyed()) bounds.save(window.getNormalBounds());
    });
    await installBridge(window, controller);
    installThreadAttention(window);
    installOnboarding(window, new OnboardingStore(paths.profile));
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
