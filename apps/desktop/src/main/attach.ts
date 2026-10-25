import { mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DesktopFile } from '@crewkite/client';
import { MAX_CHAT_PASTE_BYTES } from '@crewkite/contracts';
import { app, type BrowserWindow, clipboard, dialog, nativeImage } from 'electron';
import { type AttachRequest, MAX_ATTACH_FILES, MAX_THUMBNAIL_LENGTH } from '../shared/attach.ts';
import type { PathGrants } from './grants.ts';

const THUMBNAIL_PIXELS = 96;
// A thumbnail decodes the whole picture first. Past this size the chip shows the name, which
// keeps a large photo from costing hundreds of megabytes for a 96 pixel preview.
const MAX_THUMBNAIL_SOURCE = 20 * 1024 * 1024;

// The platform decides what a picture is: a file nativeImage cannot decode gets no thumbnail.
// createThumbnailFromPath does not decide it, since macOS answers it with Quick Look previews of
// PDFs and text files too, and Linux has no thumbnail service.
function thumbnail(path: string, bytes: number): string | null {
  if (bytes === 0 || bytes > MAX_THUMBNAIL_SOURCE) return null;
  const image = nativeImage.createFromPath(path);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const scale = Math.min(1, THUMBNAIL_PIXELS / Math.max(width, height, 1));
  const url = image
    .resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'good',
    })
    .toDataURL();
  return url.length <= MAX_THUMBNAIL_LENGTH ? url : null;
}

// A folder, a socket or a path that no longer exists is left out. The controller copies only files.
function describe(path: string): DesktopFile | null {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const name = basename(path).slice(0, 255);
  return name ? { path, name, bytes: stat.size, thumbnail: thumbnail(path, stat.size) } : null;
}

// The clipboard offers a picture under one or more image types. The first one nativeImage decodes
// is written as PNG, so the file always matches its name.
async function clipboardImage(): Promise<Buffer | null> {
  for (const item of await clipboard.read())
    for (const type of item.types.filter((value) => value.startsWith('image/'))) {
      const blob = await item.getType(type);
      if (!(blob instanceof Blob)) continue;
      // The same cap as pasted bytes on the socket, so the folder stays bounded.
      if (blob.size > MAX_CHAT_PASTE_BYTES)
        throw new Error('The pasted image is over 32 MiB. Save it as a file and attach that.');
      const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
      if (image.isEmpty()) continue;
      const png = image.toPNG();
      if (png.length > MAX_CHAT_PASTE_BYTES)
        throw new Error('The pasted image is over 32 MiB. Save it as a file and attach that.');
      return png;
    }
  return null;
}

/**
 * Finds files for one window's composer. Pasted images have no path, so they are written to a
 * private folder under the system temp path. The folder holds one message worth of images and goes
 * when the window closes. Every path it returns is granted to the window, so the bridge can tell
 * a file main gave out from a path the renderer made up.
 */
export class ComposerFiles {
  private folder: string | null = null;
  private pasted: string[] = [];
  private count = 0;
  private readonly window: BrowserWindow;
  private readonly grants: PathGrants;

  constructor(window: BrowserWindow, grants: PathGrants) {
    this.window = window;
    this.grants = grants;
  }

  async find(request: AttachRequest): Promise<DesktopFile[]> {
    if (request.from === 'clipboard') return this.paste();
    const paths =
      request.from === 'paths'
        ? request.paths
        : await dialog
            .showOpenDialog(this.window, {
              title: 'Attach files',
              properties: ['openFile', 'multiSelections'],
            })
            .then((choice) => (choice.canceled ? [] : choice.filePaths));
    const found = paths.slice(0, MAX_ATTACH_FILES).flatMap((path) => describe(path) ?? []);
    for (const file of found) this.grants.grant(file.path);
    return found;
  }

  private async paste(): Promise<DesktopFile[]> {
    const png = await clipboardImage();
    if (!png) return [];
    this.folder ??= mkdtempSync(join(app.getPath('temp'), 'crewkite-paste-'));
    this.count += 1;
    const path = join(this.folder, `pasted-image-${this.count}.png`);
    writeFileSync(path, png, { flag: 'wx', mode: 0o600 });
    this.pasted.push(path);
    // An image the composer dropped long ago has been copied or discarded by now.
    while (this.pasted.length > MAX_ATTACH_FILES) {
      const oldest = this.pasted.shift();
      if (!oldest) continue;
      rmSync(oldest, { force: true });
      this.grants.revoke(oldest);
    }
    const file = describe(path);
    if (!file) {
      unlinkSync(path);
      throw new Error('The pasted image could not be saved.');
    }
    this.grants.grant(file.path);
    return [file];
  }

  close() {
    if (this.folder) rmSync(this.folder, { recursive: true, force: true });
    this.folder = null;
    this.pasted = [];
  }
}
