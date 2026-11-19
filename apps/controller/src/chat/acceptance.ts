import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  type AcceptanceAttempt,
  AcceptanceAttemptSchema,
  type AcceptanceCheck,
  type AcceptanceRead,
  type AcceptanceRefusal,
  type ChatCheck,
  type ChatCheckRun,
  type ChatThread,
  MAX_MUTATED_PATHS,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { scopeDirectory } from '../host/dependencies.ts';
import {
  blobToFile,
  type CandidateHash,
  type PlannedFile,
  readPlannedBlobs,
} from '../host/source.ts';
import type { Store } from '../store/index.ts';
import { CHANGED_FILES } from './checks.ts';
import { copyScratch } from './scratch-copy.ts';

// Accept with required checks. A thread whose checks are on publishes only a tree those checks
// passed on. Accept freezes the candidate tree and its commit, the reviewed hunks, the commands and
// their permissions, writes the tree's files into a copy of their own and runs the checks there,
// because a Git tree object cannot run tests. The thread is held meanwhile. A check that fails or
// changes a publishable file refuses the attempt, and so does a choice that changed while the
// checks ran. Publication then writes the frozen commit with the usual compare-and-create. A
// controller that stops mid-attempt never resumes it: the attempt reads unknown and the next Accept
// checks again. Earlier passes of the same checks are feedback and never stand in for this run.

const HOLDING = "('reserved','checking','publishing')";
export const holds = (attempt: AcceptanceAttempt) =>
  attempt.state === 'reserved' || attempt.state === 'checking' || attempt.state === 'publishing';

/** What an attempt froze at reservation, kept in memory while its checks run. */
export type Frozen = {
  attempt: AcceptanceAttempt;
  root: string;
  ref: string;
  /** The copy the checks run in. It is the acceptance scope's dependency folder. */
  copy: string;
  /** The repository that holds the candidate tree, its commit and the pack. */
  repository: string;
  items: readonly ChatCheck[];
  /** The Changes listing the hunk decisions were read against, as a digest. */
  listed: string;
  /** What the checks run in the copy, as a digest. */
  seen: string;
  prepared: { treeOid: string; commitOid: string; pack: { file: string } };
  parents: readonly string[] | undefined;
  /** The commit the branch holds now, when Accept adds a merge to a branch it made before. */
  expected: string | undefined;
  /** When Accept was asked for. The commit carries this time. */
  at: string;
  /** The Changes tab count. */
  fileCount: number;
  /** The thread line once the branch is written. */
  line: string;
  /** A merge with a pull request's base waited in the copy, and publication settles it. */
  merge: boolean;
};

/** The attempt that holds the thread. The index allows one. */
export function holdingAttempt(store: Store, taskId: string): AcceptanceAttempt | undefined {
  const row = store.db
    .prepare(`SELECT body FROM acceptance_attempts WHERE task_id=? AND state IN ${HOLDING}`)
    .get(taskId) as { body: string } | undefined;
  return row ? AcceptanceAttemptSchema.parse(JSON.parse(row.body)) : undefined;
}

export function readAcceptance(store: Store, taskId: string): AcceptanceRead {
  const attempts = store.acceptanceAttempts(taskId);
  return {
    taskId,
    current: attempts.find(holds) ?? null,
    last: attempts.findLast((attempt) => !holds(attempt)) ?? null,
  };
}

/**
 * After a restart nothing owns an attempt that held a thread. Its checks may not have ended and its
 * publication may have run, so it reads unknown and nothing replays it. Runs in a transaction.
 */
export function recoverAttempts(store: Store, at: string): AcceptanceAttempt[] {
  const rows = store.db
    .prepare(`SELECT body FROM acceptance_attempts WHERE state IN ${HOLDING}`)
    .all() as { body: string }[];
  return rows.map((row) => {
    const attempt: AcceptanceAttempt = {
      ...AcceptanceAttemptSchema.parse(JSON.parse(row.body)),
      state: 'unknown',
    };
    store.putAcceptanceAttempt(attempt, at);
    return attempt;
  });
}

/** Where an attempt's copy and its repository live under the thread's folder. */
export function attemptFolders(home: string, taskId: string, attemptId: string) {
  const copy = scopeDirectory(home, taskId, 'acceptance', attemptId);
  if (!copy) throw new Error('The acceptance has no folder.');
  return { copy, repository: `${copy}-commit` };
}

/**
 * Remove what earlier attempts left, such as the copy a check changed, which stays for review
 * until the next Accept. None of them holds the thread by now.
 */
export function clearAttemptFolders(home: string, taskId: string) {
  const folder = join(home, 'chat', taskId);
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return;
  }
  for (const name of names)
    if (name.startsWith('accept-')) rmSync(join(folder, name), { recursive: true, force: true });
}

/** Remove an ended attempt's folders. The copy stays when a check changed it, for review. */
export function dropAttemptFolders(frozen: Pick<Frozen, 'copy' | 'repository'>, keepCopy: boolean) {
  rmSync(frozen.repository, { recursive: true, force: true });
  if (!keepCopy) rmSync(frozen.copy, { recursive: true, force: true });
}

/**
 * Write the candidate tree's files into a new folder. The bytes come from the attempt's repository
 * with no filters, so the checks read exactly what Accept would publish. A file the checkout holds
 * unchanged on the base is cloned where the volume allows, and the clone is checked by its oid.
 */
export function materializeCandidate(input: {
  copy: string;
  repository: string;
  root: string;
  base: string;
  candidates: readonly CandidateHash[];
}) {
  const files: PlannedFile[] = input.candidates.map((file) => ({ ...file, hash: '' }));
  copyScratch(input.copy, files, [], {
    read: (chunk) => readPlannedBlobs(input.repository, chunk as PlannedFile[]),
    stream: (file, target) => blobToFile(input.repository, (file as PlannedFile).oid, target),
    checkout: { root: input.root, base: input.base },
    name: 'the accepted changes',
  });
}

/** The reviewed hunk decisions of the thread against the listing they were read on. */
export function choicesDigest(db: DatabaseSync, taskId: string, listed: string): string {
  const rows = db
    .prepare(
      'SELECT path,hunk,base,blob FROM chat_hunk_decisions WHERE task_id=? ORDER BY path,hunk',
    )
    .all(taskId) as { path: string; hunk: string; base: string; blob: string }[];
  return hashCanonical({
    listed,
    decisions: rows.map((row) => [row.path, row.hunk, row.base, row.blob]),
  });
}

/**
 * The required checks, what they run in the copy and the permissions they run under. An allow
 * answered for the attempt changes neither, so the answer itself never cancels it.
 */
export function commandsDigest(
  thread: ChatThread,
  checks: readonly Pick<ChatCheck, 'id' | 'command'>[],
  seen: string,
): string {
  return hashCanonical({
    checks: checks.map((check) => [check.id, check.command]),
    seen,
    flightMode: thread.flightMode ?? null,
    permissionPolicy: thread.permissionPolicy ?? null,
    permissionGrants: [...(thread.permissionGrants ?? [])].sort(),
  });
}

/** A run as one of the attempt's checks. A run that changed a publishable file never passes. */
export function checkStatus(run: ChatCheckRun): AcceptanceCheck['status'] {
  if (run.reason === CHANGED_FILES) return 'mutated';
  if (run.status === 'running' || run.status === 'passed' || run.status === 'unknown')
    return run.status;
  return 'failed';
}

/** Why the checks refuse the attempt, or null when every one passed. */
export function verdict(checks: readonly AcceptanceCheck[]): AcceptanceRefusal | null {
  if (checks.some((check) => check.status === 'unknown')) return 'process-unknown';
  if (checks.some((check) => check.status === 'mutated')) return 'check-mutated';
  if (checks.some((check) => check.status !== 'passed')) return 'check-failed';
  return null;
}

/**
 * The files the checks changed. Checks run one after another in one copy, so each path counts
 * once. A run that could not list its changes counts one.
 */
export function mutations(
  runs: readonly ChatCheckRun[],
): Pick<AcceptanceAttempt, 'mutatedPaths' | 'mutatedCount'> {
  const changed = runs.filter((run) => run.reason === CHANGED_FILES);
  const paths = [...new Set(changed.flatMap((run) => run.changedPaths ?? []))].sort();
  return {
    mutatedPaths: paths.slice(0, MAX_MUTATED_PATHS),
    mutatedCount: Math.max(paths.length, ...changed.map((run) => run.changedCount ?? 1)),
  };
}

const NOTHING = 'Nothing was published.';

/** The words for a refusal, for the thread line and the command's next step. */
export function refusalWords(attempt: AcceptanceAttempt, detail?: string | null): string {
  const failed = attempt.requiredChecks
    .filter((check) => check.status !== 'passed')
    .map((check) => check.label);
  switch (attempt.refusal) {
    case 'check-failed':
      return `${failed.join(', ') || 'A check'} did not pass. ${NOTHING}`;
    case 'check-mutated': {
      const more = attempt.mutatedCount - attempt.mutatedPaths.length;
      const named = `${attempt.mutatedPaths.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
      return `A check changed ${named || 'files in the copy'}. ${NOTHING} The change was not taken in. Review it, then accept again.`;
    }
    case 'process-unknown':
      return `CrewKite could not confirm a check's process exited. ${NOTHING}`;
    case 'choice-changed':
      return `The reviewed hunks, the checks or their permissions changed while the checks ran. ${NOTHING} Accept again to check the new choice.`;
    case 'publish-conflict':
      return `${attempt.branch} was created or moved after Accept started. ${NOTHING} Choose another branch name and accept again.`;
    case 'candidate-unsupported':
      return `The checks cannot run on an exact copy of these changes, because the base holds links or submodules. ${NOTHING}`;
    case 'design-system-findings':
      return `${detail ?? 'The design check did not pass.'} Settle the values under Design, then accept. ${NOTHING}`;
    default:
      return `${detail ?? 'Accept stopped.'} ${NOTHING}`;
  }
}
