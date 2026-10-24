import type { ChatBranchStatus, ChatThread, Command, CommandResult } from '@crewkite/contracts';

type Payload<C extends Command['command']> = Extract<Command, { command: C }>['payload'];

/** What the git steps after Accept need from the chat service. */
export type ChatGitHost = {
  thread: (taskId: string) => ChatThread | null;
  saveThread: (taskId: string, thread: ChatThread) => void;
  /** Appends a system line to the thread. */
  note: (taskId: string, text: string) => void;
  /** The project checkout the thread belongs to. */
  projectRoot: (taskId: string) => string | undefined;
  now: () => string;
};

const unsupported = (): CommandResult => ({
  outcome: 'unsupported',
  reason: 'git-step-unavailable',
  next: 'Push the branch from a terminal for now.',
});

/** Push an accepted branch with the person's own git credentials. */
export async function pushChatBranch(
  _host: ChatGitHost,
  _payload: Payload<'PushChatBranch'>,
): Promise<CommandResult> {
  return unsupported();
}

/** Open a pull request through gh, or hand back the compare link when gh is missing. */
export async function openChatPullRequest(
  _host: ChatGitHost,
  _payload: Payload<'OpenChatPullRequest'>,
): Promise<CommandResult> {
  return unsupported();
}

/** Read the CI runs for a pushed branch through gh. */
export async function readChatBranchStatus(
  host: ChatGitHost,
  payload: Payload<'ReadChatBranchStatus'>,
): Promise<ChatBranchStatus> {
  return { branch: payload.branch, runs: null, reason: 'Not read yet.', readAt: host.now() };
}
