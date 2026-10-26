import { dirname, join, resolve } from 'node:path';
import type { Command } from '@crewkite/contracts';
import type { AttachmentTarget } from '../shared/open-file.ts';

/**
 * The file paths main handed one window: picker choices, saved clipboard images and files the
 * preload read from a drop. The renderer is not trusted, so the bridge passes an import by path to
 * the controller only when main gave that path to the window first. Pasted bytes need no grant.
 */
export class PathGrants {
  private readonly paths = new Set<string>();

  grant(path: string) {
    this.paths.add(path);
  }

  revoke(path: string) {
    this.paths.delete(path);
  }

  /** Why the bridge refuses this command, or null when it may go to the controller. */
  refusal(command: Command): string | null {
    if (command.command !== 'ImportChatAttachment' || !('path' in command.payload.source))
      return null;
    return this.paths.has(command.payload.source.path)
      ? null
      : 'This window did not choose that file. Attach it again.';
  }
}

/**
 * Where the controller stored one attached file: `<home>/chat/<task>/files/<sha256>/<name>`. Null
 * for anything that would resolve outside that thread's files folder, so a name the page made up
 * cannot reach another folder.
 */
export function storedAttachmentPath(
  home: string,
  target: Pick<AttachmentTarget, 'taskId' | 'id' | 'name'>,
): string | null {
  const folder = resolve(join(home, 'chat', target.taskId, 'files'));
  const path = resolve(folder, target.id, target.name);
  return dirname(path) === join(folder, target.id) && dirname(dirname(path)) === folder
    ? path
    : null;
}
