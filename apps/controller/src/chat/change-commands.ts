import type { DatabaseSync } from 'node:sqlite';
import type { ChatThread, Command, CommandResult, Task } from '@crewkite/contracts';
import * as review from './change-review.ts';

type Payload<C extends Command['command']> = Extract<Command, { command: C }>['payload'];

/** What the hunk commands need from the chat service. Each check is the one Discard runs. */
export type ChangeCommandHost = {
  db: DatabaseSync;
  task: (taskId: string) => Task | undefined;
  /** The thread after the ownership check, with the process groups still recorded. */
  checkedThread: (task: Task) => { thread: ChatThread; left: number[] };
  ownershipUnknown: (left: number[], then: string) => CommandResult;
  projectPath: (projectId: string) => string | undefined;
  scratchDirectory: (taskId: string) => string;
  systemLine: (task: Task, text: string) => void;
  /** The send path, so a comment starts now on a free thread or waits in the queue. */
  send: (payload: Payload<'SendChatMessage'>) => CommandResult;
};

const blocked = (reason: string, next?: string): CommandResult => ({
  outcome: 'blocked',
  reason,
  ...(next ? { next } : {}),
});

const hunkRefusals: Record<string, string> = {
  'not-changed': 'This file has no changes to review.',
  'hunks-unavailable': 'This file takes Accept and Discard for the whole file only.',
  'hunk-not-found': 'This hunk changed. Read the changes again.',
};

type Ready = { task: Task; root: string; base: string; scratch: string };

/** The thread, project and copy a hunk command needs. A running turn blocks a change to the copy. */
function ready(
  host: ChangeCommandHost,
  taskId: string,
  verb: string,
  writes: boolean,
): Ready | CommandResult {
  const task = host.task(taskId);
  if (!task) return blocked('task-not-found');
  const { thread, left } = host.checkedThread(task);
  if (writes && thread.activeTurnId)
    return blocked('turn-running', `Wait for the reply or stop it, then ${verb}.`);
  if (writes && left.length) return host.ownershipUnknown(left, verb);
  const root = host.projectPath(task.projectId);
  if (!root) return blocked('project-not-found', `Add the project again, then ${verb}.`);
  if (!thread.base || !thread.scratchReady)
    return blocked('not-changed', 'This file has no changes to review.');
  return { task, root, base: thread.base, scratch: host.scratchDirectory(task.id) };
}

function locate(at: Ready, path: string, hunk: string) {
  try {
    const located = review.locateHunk(at.root, at.scratch, at.base, path, hunk);
    return 'refused' in located ? blocked(located.refused, hunkRefusals[located.refused]) : located;
  } catch {
    return blocked('scratch-unreadable', 'The scratch copy could not be read. Try again.');
  }
}

/**
 * Accept one hunk for the branch, or take that back. Accept to branch then publishes only the
 * accepted hunks of the file; its other hunks stay in the copy.
 */
export function decideHunk(
  host: ChangeCommandHost,
  payload: Payload<'DecideChatHunk'>,
): CommandResult {
  const at = ready(host, payload.taskId, 'accept the hunk', true);
  if ('outcome' in at) return at;
  const located = locate(at, payload.path, payload.hunk);
  if ('outcome' in located) return located;
  review.decideHunk(host.db, at.task.id, at.base, located, payload.decision);
  return { outcome: 'applied' };
}

/** Revert one hunk in the scratch copy. Accepted hunks elsewhere in the file keep their mark. */
export function discardHunk(
  host: ChangeCommandHost,
  payload: Payload<'DiscardChatHunk'>,
): CommandResult {
  const at = ready(host, payload.taskId, 'discard', true);
  if ('outcome' in at) return at;
  const located = locate(at, payload.path, payload.hunk);
  if ('outcome' in located) return located;
  try {
    review.discardHunk(host.db, { ...at, taskId: at.task.id }, located);
  } catch {
    return blocked('scratch-unreadable', 'The scratch copy could not be written. Discard again.');
  }
  host.systemLine(
    at.task,
    `Discarded one hunk of ${payload.path} at base line ${located.hunks[located.index].oldStart}.`,
  );
  return { outcome: 'applied' };
}

/**
 * A review comment becomes a message for the thread that quotes the hunk. It reads the copy only,
 * so a running turn does not block it: the message waits in the queue like any other send.
 */
export function commentChange(
  host: ChangeCommandHost,
  payload: Payload<'CommentChatChange'>,
): CommandResult {
  const at = ready(host, payload.taskId, 'comment', false);
  if ('outcome' in at) return at;
  const located = locate(at, payload.path, payload.hunk);
  if ('outcome' in located) return located;
  const text = review.commentMessage(located, payload);
  if (typeof text !== 'string')
    return blocked(text.refused, 'Pick lines inside the hunk, then comment.');
  return host.send({ taskId: at.task.id, text, role: 'assistant', attachments: [], files: [] });
}
