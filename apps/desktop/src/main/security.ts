import { globSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { type BrowserWindow, dialog, type IpcMainInvokeEvent, type Session, shell } from 'electron';
import { externalLink, type OpenLinkResult } from '../shared/external-link.ts';
import { allowsFrameNavigation } from '../shared/frame-navigation.ts';

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
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

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
  const signInInstructions =
    'https://github.com/rjk6831/crewkite/blob/main/docs/providers.md#anthropic-writer-preparation';
  contents.setWindowOpenHandler(({ url }) => {
    // The Changes tab links to a pull request, a compare page or a CI run on GitHub. Those open in
    // the person's browser; every other window open stays denied.
    if (githubWorkLink(url)) {
      void shell.openExternal(url).catch(() => {
        dialog.showErrorBox(
          'The link could not be opened',
          `Open this address in your browser: ${url}`,
        );
      });
      return { action: 'deny' };
    }
    if (url === signInInstructions)
      void shell.openExternal(signInInstructions).catch(() => {
        dialog.showErrorBox(
          'Sign-in instructions could not be opened',
          `Open this address in your browser: ${signInInstructions}`,
        );
      });
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event) => event.preventDefault());
  // The share preview is a sandboxed frame made from text. Its own first load is the one frame
  // navigation allowed, and the page never names an address for it.
  contents.on('will-frame-navigate', (event) => {
    if (allowsFrameNavigation(event)) return;
    event.preventDefault();
  });
  contents.on('will-redirect', (event) => event.preventDefault());
}

function githubWorkLink(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === 'github.com' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(pull\/[0-9]+|compare\/[^/]+|actions\/runs\/[0-9]+)(\/.*)?$/.test(
      url.pathname,
    )
  );
}

const confirming = new WeakSet<BrowserWindow>();

// A link in a reply opens in the person's browser. Main validates the address itself and asks
// before opening plain http. One question at a time, so a reply full of links cannot stack dialogs.
export async function openExternalLink(
  window: BrowserWindow,
  value: unknown,
): Promise<OpenLinkResult> {
  const target = externalLink(value);
  if (!target) return 'refused';
  if (!target.secure) {
    if (confirming.has(window)) return 'declined';
    confirming.add(window);
    try {
      const choice = await dialog.showMessageBox(window, {
        type: 'warning',
        message: 'Open a link that is not encrypted?',
        detail: `${target.href}\n\nThis address uses http. Anything on the page, and anything you send to it, can be read on the network.`,
        buttons: ['Cancel', 'Open in browser'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (choice.response !== 1 || window.isDestroyed()) return 'declined';
    } finally {
      confirming.delete(window);
    }
  }
  try {
    await shell.openExternal(target.href);
    return 'opened';
  } catch {
    dialog.showErrorBox(
      'The link could not be opened',
      `Open this address in your browser: ${target.href}`,
    );
    return 'refused';
  }
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
