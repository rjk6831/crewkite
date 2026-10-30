import type { ChatFailure } from '@crewkite/contracts';
import { chatFailure } from './adapter.ts';

// Startup recovery fails a turn that a stopped controller left open. The thread keeps no marker
// of that beyond the failure itself, so these two builders are the only place that writes the
// texts and `failedByRestart` is the only place that reads them back. A failure a client
// produced carries its own stage and text, usually with the client's output in `detail` or
// `providerMessage`, so the check requires every field a client can fill to stay empty.
const OPEN_MESSAGE = 'The turn did not finish before the controller restarted.';
const LEFT_MESSAGE =
  /^The provider (?:process|processes) \([^()]+\) was still running when the controller restarted\.$/;

/** The failure for a turn left open, or one whose provider processes were still present. */
export function restartFailure(left: number, names: string): ChatFailure {
  if (left === 0) return chatFailure({ stage: 'stream', kind: 'internal', message: OPEN_MESSAGE });
  return chatFailure({
    stage: 'finish',
    kind: 'internal',
    message: `The provider ${left === 1 ? 'process' : 'processes'} (${names}) was still running when the controller restarted.`,
    nextAction: `Quit process ${names}, then send again.`,
  });
}

/** Whether startup recovery wrote this failure. */
export function failedByRestart(failure: ChatFailure | null): boolean {
  if (!failure) return false;
  if (
    failure.kind !== 'internal' ||
    failure.providerMessage !== null ||
    failure.method !== null ||
    failure.code !== null ||
    failure.resetsAt !== null ||
    failure.detail !== undefined
  )
    return false;
  return failure.stage === 'stream'
    ? failure.message === OPEN_MESSAGE
    : failure.stage === 'finish' && LEFT_MESSAGE.test(failure.message);
}
