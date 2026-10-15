import { globSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent, Session } from 'electron';

export const rendererURL = 'app://crewkite/index.html';
const contentTypes: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  svg: 'image/svg+xml',
  png: 'image/png',
};
const csp =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function secureSession(session: Session, rendererRoot: string) {
  const root = realpathSync(rendererRoot);
  const assets = new Map<string, string>();
  for (const file of globSync('**/*', { cwd: root, exclude: ['**/*.map'] })) {
    if (!statSync(resolve(root, file)).isFile()) continue;
    const extension = file.split('.').at(-1) ?? '';
    if (!contentTypes[extension]) continue;
    const path = realpathSync(resolve(root, file));
    const inside = relative(root, path);
    if (inside === '..' || inside.startsWith(`..${sep}`) || inside.startsWith(sep))
      throw new Error('A renderer asset escapes its bundle.');
    assets.set(`app://crewkite/${file.split(sep).join('/')}`, path);
  }
  if (!assets.has(rendererURL)) throw new Error('The built desktop renderer is missing.');
  session.protocol.handle('app', (request) => {
    const path = request.method === 'GET' ? assets.get(request.url) : undefined;
    if (!path) return new Response(null, { status: 404 });
    return new Response(readFileSync(path), {
      headers: {
        'Content-Type': contentTypes[path.split('.').at(-1) ?? ''],
        'Content-Security-Policy': csp,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
  session.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !assets.has(details.url) }),
  );
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.on('will-download', (event) => event.preventDefault());
}

export function secureWindow(window: BrowserWindow) {
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-frame-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
}

export function assertSender(event: IpcMainInvokeEvent, window: BrowserWindow) {
  if (
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== rendererURL ||
    window.webContents.getURL() !== rendererURL
  )
    throw new Error('The desktop request sender is invalid.');
}
