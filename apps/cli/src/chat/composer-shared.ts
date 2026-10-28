// The slash command list and mention ranking are shared with the desktop composer through
// @crewkite/client. Only the local fallback below stays here: it ranks tracked files when the
// controller cannot answer CompleteChatMention.
import { foldersOf, type MentionCandidate, rankMentions } from '@crewkite/client';

export {
  completeSlash,
  findMentionTrigger,
  insertMention,
  type MentionCandidate,
  type MentionTrigger,
  mentionText,
  type ParsedSlash,
  parseSlash,
  rankMentions,
  type SlashCommand,
  type SlashName,
  slashCommands,
  slashHelp,
} from '@crewkite/client';

/** Files and the folders that hold them, ranked for one query. */
export function completeMentionLocally(
  files: readonly string[],
  query: string,
  limit: number,
): MentionCandidate[] {
  const candidates: MentionCandidate[] = [
    ...foldersOf(files).map((path) => ({ path, kind: 'folder' as const })),
    ...files.map((path) => ({ path, kind: 'file' as const })),
  ];
  return rankMentions(candidates, query, limit);
}
