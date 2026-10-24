import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  type ChatBranchStatus,
  ChatBranchStatusSchema,
  type ChatThread,
  type Command,
  type CommandResult,
} from '@crewkite/contracts';
import { z } from 'zod';

type Payload<C extends Command['command']> = Extract<Command, { command: C }>['payload'];

export type ToolRun = { code: number | null; stdout: string; stderr: string };
/** Runs git or gh in a directory. Null means the tool is not on the search path. */
export type ToolRunner = (
  tool: 'git' | 'gh',
  args: string[],
  cwd: string,
) => Promise<ToolRun | null>;

/** What the git steps after Accept need from the chat service. */
export type ChatGitHost = {
  thread: (taskId: string) => ChatThread | null;
  saveThread: (taskId: string, thread: ChatThread) => void;
  /** Appends a system line to the thread. */
  note: (taskId: string, text: string) => void;
  /** The project checkout the thread belongs to. */
  projectRoot: (taskId: string) => string | undefined;
  now: () => string;
  /** Tests pass real git and a fake gh here. The controller uses the PATH it started with. */
  run?: ToolRunner;
};

// A push over a slow link can take a while. Two minutes is long enough for a real push and short
// enough that a hung credential helper does not hold the Changes tab forever.
const RUN_MS = 120_000;
const OUTPUT_CHARS = 64 * 1024;
const REASON_CHARS = 400;

// The variables git and gh read to find the person's own credentials and proxies. Everything else
// the controller holds stays out of these processes.
const passed = [
  'HOME',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'LANG',
  'SSH_AUTH_SOCK',
  'XDG_CONFIG_HOME',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
];

/**
 * A packaged app starts with a short PATH, so the Homebrew directories are searched as well when
 * the inherited PATH leaves them out.
 */
export function toolRunner(environment: NodeJS.ProcessEnv = process.env): ToolRunner {
  const directories = [
    ...new Set([
      ...(environment.PATH ?? '').split(delimiter).filter(isAbsolute),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ]),
  ];
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      passed.flatMap((key) => (environment[key] ? [[key, environment[key]]] : [])),
    ),
    PATH: directories.join(delimiter),
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
  };
  const find = (tool: string) => {
    for (const directory of directories)
      try {
        accessSync(join(directory, tool), constants.X_OK);
        return join(directory, tool);
      } catch {}
    return null;
  };
  return (tool, args, cwd) => {
    const executable = find(tool);
    return executable ? runTool(executable, args, cwd, env) : Promise.resolve(null);
  };
}

function runTool(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<ToolRun>((settle) => {
    // Its own session has no terminal, so ssh and credential helpers fail fast where they would
    // otherwise wait for a password nobody can type.
    const child = spawn(executable, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let code: number | null = null;
    let done = false;
    const finish = (extra?: string) => {
      if (done) return;
      done = true;
      clearTimeout(limit);
      child.stdout.destroy();
      child.stderr.destroy();
      settle({ code, stdout, stderr: extra ? `${stderr}\n${extra}` : stderr });
    };
    const limit = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {}
      code = null;
      finish(`${executable.split('/').at(-1)} did not finish within two minutes.`);
    }, RUN_MS);
    limit.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-OUTPUT_CHARS);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-OUTPUT_CHARS);
    });
    child.once('error', (error) => finish(error.message));
    child.once('exit', (status) => {
      code = status;
      // An ssh control master started by the push can keep the pipes open after git exits.
      setTimeout(finish, 1000).unref();
    });
    child.once('close', () => finish());
  });
}

const lastLine = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, REASON_CHARS);

const blocked = (reason: string, next: string): CommandResult => ({
  outcome: 'blocked',
  reason,
  next,
});

/** Push an accepted branch with the person's own git credentials. */
export async function pushChatBranch(
  host: ChatGitHost,
  payload: Payload<'PushChatBranch'>,
): Promise<CommandResult> {
  const thread = host.thread(payload.taskId);
  if (!thread) return blocked('task-not-found', 'Open the thread again.');
  const accepted = thread.lastAcceptance;
  if (accepted?.branch !== payload.branch || !accepted.commit)
    return blocked('branch-not-accepted', 'Accept the changes to this branch, then push.');
  const commit = accepted.commit;
  const result = {
    kind: 'chat-push' as const,
    branch: payload.branch,
    remote: payload.remote,
    commit,
  };
  const pushed = thread.lastPush;
  // A second click after a push that landed would only repeat it. The journal already says so.
  if (
    pushed?.branch === payload.branch &&
    pushed.remote === payload.remote &&
    pushed.commit === commit
  )
    return { outcome: 'already-applied', data: result };
  const root = host.projectRoot(payload.taskId);
  if (!root) return blocked('project-not-found', 'Add the project again, then push.');
  const run = host.run ?? toolRunner();
  const ref = `refs/heads/${payload.branch}`;
  const head = await run('git', ['rev-parse', '--verify', '--quiet', ref], root);
  if (!head) return blocked('git-missing', 'Install Git, then push again.');
  // The thread journals the accepted commit. A branch moved since then holds work it never saw.
  if (head.code !== 0 || head.stdout.trim() !== commit)
    return blocked(
      'branch-moved',
      `${payload.branch} moved after Accept. Push it from a terminal.`,
    );
  const push = await run('git', ['push', payload.remote, `${ref}:${ref}`], root);
  if (push?.code !== 0)
    return blocked(
      lastLine(push?.stderr ?? '') ?? 'git push failed.',
      'Check the remote and your git credentials, then push again.',
    );
  // The push can take minutes. Turns and the queue may have moved on since the first read.
  host.saveThread(payload.taskId, {
    ...(host.thread(payload.taskId) ?? thread),
    lastPush: {
      branch: payload.branch,
      remote: payload.remote,
      commit,
      at: host.now(),
      pullRequestUrl: null,
    },
  });
  host.note(payload.taskId, `Pushed ${payload.branch} to ${payload.remote}.`);
  return { outcome: 'applied', data: result };
}

// The forms git prints for a github.com remote: https with or without a user, scp style and ssh.
const githubRemote =
  /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const pullUrl = /^https:\/\/\S+\/pull\/\d+$/;

/** Open a pull request through gh, or hand back the compare link when gh is missing. */
export async function openChatPullRequest(
  host: ChatGitHost,
  payload: Payload<'OpenChatPullRequest'>,
): Promise<CommandResult> {
  const thread = host.thread(payload.taskId);
  if (!thread) return blocked('task-not-found', 'Open the thread again.');
  const pushed = thread.lastPush;
  if (pushed?.branch !== payload.branch)
    return blocked('branch-not-pushed', 'Push the branch, then open a pull request.');
  const root = host.projectRoot(payload.taskId);
  if (!root)
    return blocked('project-not-found', 'Add the project again, then open a pull request.');
  const run = host.run ?? toolRunner();
  const save = (url: string, via: 'gh' | 'compare-link'): CommandResult => {
    host.saveThread(payload.taskId, {
      ...(host.thread(payload.taskId) ?? thread),
      lastPush: { ...pushed, pullRequestUrl: url },
    });
    host.note(
      payload.taskId,
      via === 'gh'
        ? `Opened a pull request for ${payload.branch}.`
        : `Copied the compare link for ${payload.branch}.`,
    );
    return { outcome: 'applied', data: { kind: 'chat-pull-request', url, via } };
  };
  const created = await run(
    'gh',
    ['pr', 'create', '--head', payload.branch, '--title', payload.title, '--body', payload.body],
    root,
  );
  if (created) {
    const printed = lastLine(created.code === 0 ? created.stdout : created.stderr);
    // gh refuses a second request for the branch and prints the open one's address.
    if (printed && pullUrl.test(printed)) return save(printed, 'gh');
    return blocked(
      lastLine(created.stderr) ?? 'gh pr create failed.',
      'Run gh auth status in a terminal, then open the pull request again.',
    );
  }
  const remote = await run('git', ['remote', 'get-url', pushed.remote], root);
  const match = remote?.code === 0 ? githubRemote.exec(remote.stdout.trim()) : null;
  if (!match)
    return blocked(
      'compare-link-unavailable',
      'Install gh, or open the pull request on the remote site.',
    );
  return save(
    `https://github.com/${match[1]}/${match[2]}/compare/${payload.branch}?expand=1`,
    'compare-link',
  );
}

// gh run list output. Only these fields are read, and anything gh adds later is ignored.
const GhRunsSchema = z.array(
  z.object({
    databaseId: z.union([z.number(), z.string()]),
    name: z.string().nullish(),
    workflowName: z.string().nullish(),
    status: z.string(),
    conclusion: z.string().nullish(),
    url: z.string(),
    createdAt: z.string(),
  }),
);
const RunSchema = ChatBranchStatusSchema.shape.runs.unwrap().element;
const statuses = new Set<string>(RunSchema.shape.status.options);

/** Read the CI runs for a pushed branch through gh. */
export async function readChatBranchStatus(
  host: ChatGitHost,
  payload: Payload<'ReadChatBranchStatus'>,
): Promise<ChatBranchStatus> {
  const status = (runs: ChatBranchStatus['runs'], reason: string | null): ChatBranchStatus => ({
    branch: payload.branch,
    runs,
    reason,
    readAt: host.now(),
  });
  const root = host.projectRoot(payload.taskId);
  if (!root) return status(null, 'Add the project again to read CI runs.');
  const listed = await (host.run ?? toolRunner())(
    'gh',
    [
      'run',
      'list',
      '--branch',
      payload.branch,
      '--json',
      'databaseId,name,status,conclusion,url,createdAt',
      '--limit',
      '5',
    ],
    root,
  );
  if (!listed) return status(null, 'Install gh to see CI runs here.');
  if (listed.code !== 0)
    return status(null, lastLine(listed.stderr) ?? 'gh could not read CI runs.');
  let rows: z.infer<typeof GhRunsSchema>;
  try {
    rows = GhRunsSchema.parse(JSON.parse(listed.stdout));
  } catch {
    return status(null, 'gh returned CI runs in a form CrewKite cannot read.');
  }
  const runs = rows.flatMap((row) => {
    const run = RunSchema.safeParse({
      id: String(row.databaseId),
      name: row.name || row.workflowName || 'Workflow run',
      // gh reports a few states CrewKite does not name. They read as pending until they finish.
      status: statuses.has(row.status) ? row.status : 'pending',
      conclusion: row.conclusion || null,
      url: row.url,
      createdAt: row.createdAt,
    });
    return run.success ? [run.data] : [];
  });
  return status(
    runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    null,
  );
}
