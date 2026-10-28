import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { foldersOf, rankMentions } from '@crewkite/client';
import {
  type ChatInstructionsRead,
  type ChatMention,
  ChatMentionSchema,
  INSTRUCTION_VIEW_BYTES,
} from '@crewkite/contracts';
import { instructionFileNames } from '../providers/instruction-files.ts';
import { fitBytes, listFiles, readScratchFile } from './local-tools.ts';

// Completion for @file and @folder mentions. Candidates come from the same listing the Local
// tools use: files inside the scratch copy, without ignored files, links or anything under .git.
// A folder is a candidate only when it holds a listed file, so an ignored folder never shows.

const LISTING_MS = 3000;

export type MentionIndex = {
  complete(
    scratch: string,
    environment: NodeJS.ProcessEnv,
    query: string,
    limit: number,
  ): ChatMention[];
};

/**
 * Typing runs one completion per key. The listing runs git, so it is kept for a few seconds per
 * copy and a file added a moment ago appears on the next listing.
 * shortcut: the keep time is fixed. Upgrade: invalidate it when a turn edits the copy.
 */
export function createMentionIndex(now: () => number): MentionIndex {
  const kept = new Map<string, { at: number; entries: ChatMention[] }>();
  return {
    complete(scratch, environment, query, limit) {
      const current = now();
      let listing = kept.get(scratch);
      if (!listing || current - listing.at > LISTING_MS || current < listing.at) {
        const paths = listFiles(scratch, environment)
          .map(({ path }) => path)
          .filter((path) => !path.split('/').includes('.git'));
        const entries: ChatMention[] = [];
        for (const path of paths) entries.push({ path, kind: 'file' });
        for (const path of foldersOf(paths)) entries.push({ path, kind: 'folder' });
        listing = {
          at: current,
          entries: entries.filter((entry) => ChatMentionSchema.safeParse(entry).success),
        };
        kept.clear();
        kept.set(scratch, listing);
      }
      return rankMentions(listing.entries, query, limit);
    },
  };
}

/** The instruction files that exist as plain files at the root of the copy. */
export function instructionFilesAt(scratch: string): string[] {
  return instructionFileNames.filter((name) => {
    try {
      return lstatSync(join(scratch, name)).isFile();
    } catch {
      return false;
    }
  });
}

/** The file list, and the text of one listed file when `name` is given. */
export function readInstructions(
  taskId: string,
  scratch: string,
  name: string | undefined,
): ChatInstructionsRead {
  const files = instructionFilesAt(scratch);
  let text: string | null = null;
  let truncated = false;
  if (name !== undefined && files.includes(name)) {
    try {
      const whole = readScratchFile(scratch, name);
      text = fitBytes(whole, INSTRUCTION_VIEW_BYTES);
      truncated = text.length < whole.length;
    } catch {
      text = null;
    }
  }
  return {
    taskId,
    files,
    name: text === null ? null : (name ?? null),
    text,
    truncated,
  };
}
