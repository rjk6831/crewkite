import type { ChatFamily } from '@crewkite/contracts';

/**
 * The sign-in line the controller returns for an API connection, as the browser preview shows it.
 * Each client signs in to the connection's own profile folder and reads the key itself.
 */
export function previewLoginLine(family: ChatFamily, profileId: string): string {
  const root = '/Users/you/.crewkite/providers';
  return family === 'anthropic'
    ? `CLAUDE_CONFIG_DIR='${root}/anthropic/claude-profiles/${profileId}' claude auth login --console`
    : `CODEX_HOME='${root}/openai/codex-profiles/${profileId}' codex login --with-api-key`;
}
