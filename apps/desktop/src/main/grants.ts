import type { Command } from '@crewkite/contracts';

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
