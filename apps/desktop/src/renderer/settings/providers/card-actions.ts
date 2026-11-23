import type { ClientVersionStatus } from '@crewkite/contracts';
import type { DesktopCommand } from '../../source.ts';

export type CardFamily = 'openai' | 'anthropic' | 'google';
export type CardActionId = 'check' | 'models' | 'sign-out';

/** The actions every cloud card offers, in the order the card shows them. */
export const CARD_ACTIONS: readonly { id: CardActionId; label: string; busy: string }[] = [
  { id: 'check', label: 'Check again', busy: 'Checking…' },
  { id: 'models', label: 'Refresh models', busy: 'Reading models…' },
  { id: 'sign-out', label: 'Sign out', busy: 'Signing out…' },
];

const done = {
  check: (time: string) => `Checked at ${time}.`,
  models: (time: string) => `Models read at ${time}.`,
};
const refused = {
  check: 'The client could not be checked.',
  models: 'The model list could not be read. Refresh models to try again.',
  'sign-out': 'Sign out did not go through. Try again.',
};
// OpenAI signs out of the home CrewKite owns. The other two end CrewKite's connection and leave
// the client signed in, so the line says that.
const signedOut = (family: CardFamily) =>
  family === 'openai'
    ? 'Signed out. Press Connect to connect again.'
    : 'Disconnected from CrewKite. The client stays signed in. Press Connect to use it again.';

/** The line an action leaves behind. A refusal carries the controller's next step when it has one. */
export function actionResult(
  id: CardActionId,
  family: CardFamily,
  outcome: { ok: boolean; next?: string },
  time: string,
): string {
  if (!outcome.ok) return outcome.next ?? refused[id];
  return id === 'sign-out' ? signedOut(family) : done[id](time);
}

/**
 * The existing command that does each action for a family. Google reads its models through its
 * setup, which needs the setup revision and the proof it holds. Sign out for OpenAI ends the
 * client home CrewKite owns. For the other two it ends CrewKite's connection and nothing else.
 */
export function actionCommand(
  id: CardActionId,
  family: CardFamily,
  google: { revision: number; proofId: string },
): DesktopCommand {
  if (id === 'check') return { command: 'CheckProviderClient', payload: { family } };
  if (id === 'models')
    return family === 'google'
      ? {
          command: 'RefreshGoogleAcpModels',
          expectedRevision: google.revision,
          payload: { profileId: 'google-acp-v1', proofId: google.proofId, consent: 'explicit' },
        }
      : { command: 'RefreshChatModels', expectedRevision: 0, payload: { family } };
  return family === 'openai'
    ? { command: 'SignOutOpenAi', expectedRevision: 0, payload: {} }
    : { command: 'SignOutProvider', expectedRevision: 0, payload: { family } };
}

const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

// A fixed format keeps the line the same on every machine and in every test.
const day = (iso: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${Number(match[3])} ${months[Number(match[2]) - 1]} ${match[1]}` : null;
};

/**
 * What the copy line adds to the status message above it. The message already names the version
 * and an app or CrewKite's own folder, so this says only where a search-path copy came from, when
 * CrewKite fetched the copy in use, and a fetched build it does not use. The Google status is the
 * quota client, so its line says what that client does. Null when there is nothing to add.
 */
export function clientCopyLine(family: CardFamily, status: ClientVersionStatus): string | null {
  const copy = status.copy;
  if (!status.accepted || !copy) return null;
  const lines: string[] = [];
  if (copy.place === 'search-path')
    lines.push(`${family === 'google' ? 'Reads quota' : 'Runs'} from your search path.`);
  else if (copy.place === 'crewkite') {
    const fetched = copy.fetched?.version === status.version ? day(copy.fetched.at) : null;
    lines.push(fetched ? `Fetched by CrewKite on ${fetched}.` : 'Kept by CrewKite.');
  }
  if (copy.notUsed)
    lines.push(
      `CrewKite fetched ${copy.notUsed.version} and does not use it. ${copy.notUsed.reason.replace(/\.?$/, '.')}`,
    );
  return lines.length ? lines.join(' ') : null;
}
