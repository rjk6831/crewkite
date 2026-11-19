import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  type ChatBranchStatus,
  ChatBranchStatusSchema,
  type ChatDeploy,
  ChatDeploySchema,
  type ChatThread,
  type Command,
  type CommandResult,
  type RemoteEffect,
} from '@crewkite/contracts';
import { z } from 'zod';
import { type RemoteEffects, remoteWritePreview } from '../github/effects.ts';
import { gitAndGhEnvironment, notGitHubLine } from '../github/remote.ts';

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
  /**
   * Saves the thread as `update` makes it from the current row and appends the system line, in
   * one transaction. The git step can take minutes, so the update starts from the row as it is
   * then, never from the one read before the push.
   */
  journal: (taskId: string, update: (thread: ChatThread) => ChatThread, line: string) => void;
  /** The project checkout the thread belongs to. */
  projectRoot: (taskId: string) => string | undefined;
  now: () => string;
  /** Tests pass real git and a fake gh here. The controller uses the PATH it started with. */
  run?: ToolRunner;
  /**
   * The journal for remote writes, so an uncertain result can be reconciled. A push is confirmed
   * by the Push button's own question. A pull request is only proposed there until the person
   * confirms its preview.
   */
  effects: RemoteEffects;
};

// These reads talk to the remote too. Two minutes is long enough over a slow link and short
// enough that a hung credential helper does not hold the Changes tab forever.
const RUN_MS = 120_000;
const OUTPUT_CHARS = 64 * 1024;
const REASON_CHARS = 400;

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
    ...gitAndGhEnvironment(environment),
    ...(environment.HOME ? { HOME: environment.HOME } : {}),
    ...(environment.LANG ? { LANG: environment.LANG } : {}),
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

/**
 * Push an accepted branch with the person's own git credentials, through the remote write journal.
 * The Push button asks first, so the proposal is confirmed at once. A push that ends without a
 * result stays unknown there and holds the next one until a read of the remote settles it.
 */
export async function pushChatBranch(
  host: ChatGitHost,
  payload: Payload<'PushChatBranch'>,
): Promise<CommandResult> {
  const thread = host.thread(payload.taskId);
  if (!thread) return blocked('task-not-found', 'Open the thread again.');
  const accepted = thread.lastAcceptance;
  if (accepted?.branch !== payload.branch || !accepted.commit)
    return blocked('branch-not-accepted', 'Accept the changes to this branch, then push.');
  // The person was asked about one commit. One accepted after the question is not what they saw.
  if (accepted.commit !== payload.commit)
    return blocked(
      'branch-not-accepted',
      `The thread accepted ${accepted.commit.slice(0, 12)} after you were asked. Read it again, then push.`,
    );
  const commit = accepted.commit;
  const result = {
    kind: 'chat-push' as const,
    branch: payload.branch,
    remote: payload.remote,
    commit,
  };
  const same = (entry: { branch: string; remote: string }) =>
    entry.branch === payload.branch && entry.remote === payload.remote;
  const journal = (plain = false) =>
    host.journal(
      payload.taskId,
      (current) => ({
        ...current,
        lastPush: {
          branch: payload.branch,
          remote: payload.remote,
          commit,
          at: host.now(),
          pullRequestUrl: null,
        },
        ...(plain
          ? {
              pushes: [
                { branch: payload.branch, remote: payload.remote, commit },
                ...(current.pushes ?? []).filter((entry) => !same(entry)),
              ].slice(0, 64),
            }
          : {}),
      }),
      `Pushed ${payload.branch} to ${payload.remote}.`,
    );
  const pushed = thread.lastPush;
  // A second click after a push that landed would only repeat it. The journal already says so.
  if (
    pushed?.branch === payload.branch &&
    pushed.remote === payload.remote &&
    pushed.commit === commit
  )
    return { outcome: 'already-applied', data: result };
  // A push that a read of the remote settled later reaches the thread here.
  const settled = host.effects
    .list(payload.taskId)
    .some(
      (effect) =>
        effect.request.kind === 'push' &&
        effect.state === 'applied' &&
        effect.request.commit === commit &&
        effect.request.remote === payload.remote &&
        effect.target.branch === payload.branch,
    );
  if (settled) {
    journal();
    return { outcome: 'already-applied', data: result };
  }
  const root = host.projectRoot(payload.taskId);
  if (!root) return blocked('project-not-found', 'Add the project again, then push.');
  const run = host.run ?? toolRunner();
  // The push sends the journaled object, so a local branch that moved after Accept changes
  // nothing. The object has to exist here.
  const known = await run('git', ['cat-file', '-e', `${commit}^{commit}`], root);
  if (!known) return blocked('git-missing', 'Install Git, then push again.');
  if (known.code !== 0)
    return blocked(
      'accepted-commit-missing',
      'The accepted commit is gone from this project. Accept the changes again.',
    );
  const read = host.effects.remote(payload.taskId, payload.remote);
  if (!read)
    return blocked('remote-not-found', `${payload.remote} is not a remote of this project.`);
  // The lease names what this thread last pushed to this branch of this remote, whichever branch
  // it pushed since. A branch never pushed from here must be absent on the remote, so a name
  // someone else already took refuses. A thread from before the per-branch record has only its
  // last push to go on.
  const legacy = pushed && same(pushed) ? pushed.commit : null;
  if (read.kind !== 'github') {
    // Plain git with a lease works for any remote git can reach. Only the GitHub parts need a
    // GitHub repository.
    const expected = thread.pushes?.find(same)?.commit ?? legacy;
    const ref = `refs/heads/${payload.branch}`;
    const sent = await run(
      'git',
      ['push', payload.remote, `${commit}:${ref}`, `--force-with-lease=${ref}:${expected ?? ''}`],
      root,
    );
    if (!sent) return blocked('git-missing', 'Install Git, then push again.');
    if (sent.code === 0) {
      journal(true);
      return { outcome: 'applied', data: result };
    }
    if (/stale info|\[rejected\]|\[remote rejected\]|non-fast-forward/i.test(sent.stderr))
      return blocked(
        `${payload.branch} changed on ${payload.remote} since you last saw it.`,
        'Fetch it, check what is there, then push again from a terminal.',
      );
    return blocked(
      lastLine(sent.stderr) ?? 'git push failed.',
      'Check the remote and your git credentials, then push again.',
    );
  }
  const repo = read.repo;
  const journaled = host.effects
    .list(payload.taskId)
    .findLast(
      (effect) =>
        effect.request.kind === 'push' &&
        effect.state === 'applied' &&
        effect.request.remote === payload.remote &&
        effect.target.branch === payload.branch,
    );
  const expected = journaled?.request.kind === 'push' ? journaled.request.commit : legacy;
  const sent = await host.effects.submit({
    taskId: payload.taskId,
    target: { repo, branch: payload.branch, pr: null, headSha: commit, baseRef: null },
    request: { kind: 'push', remote: payload.remote, commit, expectedRemote: expected },
  });
  const effect = sent.data?.kind === 'remote-effect' ? sent.data.effect : null;
  if (effect?.state === 'applied') {
    journal();
    return { outcome: 'applied', data: result };
  }
  if (effect?.state === 'refused' && effect.observed)
    return blocked(
      effect.reason ?? 'git push was refused.',
      /changed on/.test(effect.reason ?? '')
        ? 'Fetch it, check what is there, then push again from a terminal.'
        : 'Check the remote and your git credentials, then push again.',
    );
  return plain(sent);
}

/**
 * Propose a pull request in the remote write journal, from the pushed branch into the remote's
 * default branch, ready for review, and answer with its preview. The click is not the
 * confirmation: the person reads the preview and confirms it with ConfirmRemoteEffect. An empty
 * body is built from the thread's plan and the branch's diff. Without gh, hand back the compare
 * link, which writes nothing.
 */
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
  const save = (url: string, via: 'gh' | 'compare-link'): CommandResult => {
    host.journal(
      payload.taskId,
      (current) => ({ ...current, lastPush: { ...pushed, pullRequestUrl: url } }),
      via === 'gh'
        ? `Opened a pull request for ${payload.branch}.`
        : `Copied the compare link for ${payload.branch}.`,
    );
    return { outcome: 'applied', data: { kind: 'chat-pull-request', url, via } };
  };
  const read = host.effects.remote(payload.taskId, pushed.remote);
  if (read?.kind !== 'github')
    return blocked(
      'remote-not-github',
      read
        ? notGitHubLine(pushed.remote, read)
        : `${pushed.remote} is not a remote of this project.`,
    );
  const repo = read.repo;
  if (!host.effects.hasGh())
    return save(
      `https://${repo.host}/${repo.owner}/${repo.name}/compare/${payload.branch}?expand=1`,
      'compare-link',
    );
  const ours = host.effects
    .list(payload.taskId)
    .filter(
      (effect) =>
        effect.request.kind === 'pr-open' &&
        effect.target.branch === payload.branch &&
        effect.target.headSha === pushed.commit,
    );
  // A pull request confirmed from its preview reaches the thread here.
  const opened = ours.findLast((effect) => effect.state === 'applied')?.observed?.created?.pr;
  if (opened) {
    const url = `https://${repo.host}/${repo.owner}/${repo.name}/pull/${opened}`;
    if (pushed.pullRequestUrl !== url) save(url, 'gh');
    return {
      outcome: 'already-applied',
      data: { kind: 'chat-pull-request', url, via: 'gh' },
    };
  }
  // A second click shows the waiting proposal. A click with another title or body replaces it, so
  // the preview the person confirms always holds what they wrote last. An empty body is built
  // from the same plan and diff, so it matches whatever body was built for it.
  const waiting = ours.findLast((effect) => effect.state === 'proposed');
  if (
    waiting?.request.kind === 'pr-open' &&
    waiting.request.title === payload.title &&
    (payload.body === '' || waiting.request.body === payload.body)
  )
    return proposed(waiting);
  const base = await host.effects.defaultBranch(payload.taskId, pushed.remote, repo);
  if (!base)
    return blocked(
      'base-branch-unknown',
      `CrewKite could not tell the default branch of ${repo.owner}/${repo.name}. Open the pull request on the remote site.`,
    );
  const proposal = {
    taskId: payload.taskId,
    target: { repo, branch: payload.branch, pr: null, headSha: pushed.commit, baseRef: base },
    request: { kind: 'pr-open' as const, title: payload.title, body: payload.body, draft: false },
  };
  const result = waiting
    ? host.effects.proposeInstead(waiting.id, proposal)
    : host.effects.proposeNow(proposal);
  return result.data?.kind === 'remote-effect' ? proposed(result.data.effect) : result;
}

// A proposal opens nothing, so the button must not read it as done. The preview travels with it
// for the confirmation.
const proposed = (effect: RemoteEffect): CommandResult => ({
  outcome: 'blocked',
  reason: 'pull-request-needs-confirmation',
  next: 'The pull request is proposed and waits for you to confirm its preview. Nothing was sent.',
  data: { kind: 'remote-effect', effect, preview: remoteWritePreview(effect) },
});

// Push answers with a reason and a next step only. The write itself is in the journal, which
// ReadRemoteEffects reads.
const plain = (result: CommandResult): CommandResult => ({
  outcome: result.outcome,
  ...(result.reason ? { reason: result.reason } : {}),
  ...(result.next ? { next: result.next } : {}),
});

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
    headSha: z.string().nullish(),
  }),
);
const RunSchema = ChatBranchStatusSchema.shape.runs.unwrap().element;
const JobSchema = RunSchema.shape.jobs.unwrap().element;
// gh run view output for one run. The jobs carry their steps, which are never read.
const GhRunViewSchema = z.object({
  attempt: z.number().int().positive(),
  headSha: z.string().nullish(),
  jobs: z.array(
    z.object({
      databaseId: z.union([z.number(), z.string()]),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullish(),
      url: z.string(),
    }),
  ),
});
const statuses = new Set<string>(RunSchema.shape.status.options);

/** Read the CI runs for a pushed branch through gh. */
export async function readChatBranchStatus(
  host: ChatGitHost,
  payload: Payload<'ReadChatBranchStatus'>,
): Promise<ChatBranchStatus> {
  const status = (
    runs: ChatBranchStatus['runs'],
    reason: string | null,
    read: { commit: string | null; headMoved: boolean } = { commit: null, headMoved: false },
  ): ChatBranchStatus => ({
    branch: payload.branch,
    deploy: null,
    runs,
    ...read,
    reason,
    readAt: host.now(),
  });
  const root = host.projectRoot(payload.taskId);
  if (!root) return status(null, 'Add the project again to read CI runs.');
  const thread = host.thread(payload.taskId);
  const accepted = thread?.lastAcceptance;
  // CI is read for the commit Accept made. Any other run on the branch name says nothing about it.
  if (accepted?.branch !== payload.branch || !accepted.commit)
    return status(null, 'Accept the changes to this branch to read its CI runs.');
  const commit = accepted.commit;
  const remote = thread?.lastPush?.remote ?? 'origin';
  // gh finds the repository from the project's remotes. It is never asked about one that is not
  // a GitHub repository, or about an ssh name whose real host is unknown.
  const read = host.effects.remote(payload.taskId, remote);
  if (read && read.kind !== 'github') return status(null, notGitHubLine(remote, read));
  const run = host.run ?? toolRunner();
  const listed = await run(
    'gh',
    [
      'run',
      'list',
      '--commit',
      commit,
      '--json',
      'databaseId,name,status,conclusion,url,createdAt,headSha',
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
    // gh filters by commit already. A row that names another commit is dropped, not trusted.
    if (row.headSha && row.headSha !== commit) return [];
    const run = RunSchema.safeParse({
      id: String(row.databaseId),
      name: row.name || row.workflowName || 'Workflow run',
      // gh reports a few states CrewKite does not name. They read as pending until they finish.
      status: statuses.has(row.status) ? row.status : 'pending',
      conclusion: row.conclusion || null,
      url: row.url,
      createdAt: row.createdAt,
      // The run list names no attempt or jobs. A run view reads them below.
      attempt: null,
      jobs: [],
    });
    return run.success ? [run.data] : [];
  });
  // One bounded view per run, at most five. A view that fails, names another commit or holds a
  // job CrewKite cannot read leaves the run with no attempt and no jobs, which the thread shows
  // as unread. Dropping one job would hide a failure behind a green row.
  const viewed = await Promise.all(
    runs.map(async (entry) => {
      const view = await run(
        'gh',
        ['run', 'view', entry.id, '--json', 'attempt,headSha,jobs'],
        root,
      );
      if (view?.code !== 0) return entry;
      try {
        const parsed = GhRunViewSchema.parse(JSON.parse(view.stdout));
        if (parsed.headSha && parsed.headSha !== commit) return entry;
        const jobs = parsed.jobs.map((job) =>
          JobSchema.parse({
            id: String(job.databaseId),
            name: job.name,
            status: job.status,
            conclusion: job.conclusion || null,
            url: job.url,
          }),
        );
        return RunSchema.parse({ ...entry, attempt: parsed.attempt, jobs });
      } catch {
        return entry;
      }
    }),
  );
  // The remote branch may point past the commit that was accepted. Say so, and say when the
  // remote could not be read, so a quiet answer never reads as a passed one.
  // The branch went to the push URL, so that is where its tip is read, as a reconcile does.
  const pushUrl = await run('git', ['remote', 'get-url', '--push', remote], root);
  const tip =
    pushUrl?.code === 0
      ? await run('git', ['ls-remote', pushUrl.stdout.trim(), `refs/heads/${payload.branch}`], root)
      : pushUrl;
  const tipSha = tip?.code === 0 ? tip.stdout.trim().split(/\s+/)[0] : undefined;
  let reason: string | null = null;
  if (tipSha && tipSha !== commit)
    reason = 'The branch now points at a newer commit than the one you accepted.';
  else if (tip?.code !== 0)
    reason = `The remote branch could not be read, so a newer commit would not show here.`;
  else if (runs.length === 0) reason = 'No CI run has been reported for the accepted commit yet.';
  return {
    ...status(
      viewed.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      reason,
      { commit, headMoved: !!tipSha && tipSha !== commit },
    ),
    deploy: await readDeploy(host, payload.taskId, root, run),
  };
}

// After a merge the base branch runs its own workflows, and a deployment may follow. This is read
// only. Nothing here reruns, cancels or rolls anything back.
const FOLLOW_MS = 2 * 60 * 60_000;
// GitHub lists a push-triggered run within seconds of the merge. With nothing listed after this,
// nothing ran.
const NOTHING_RAN_MS = 15 * 60_000;
const STILL_RUNNING = 'Still running on GitHub. Check it there.';
const NOTHING_RAN = 'Nothing ran on GitHub for this merge.';
// A finished read does not change, so it is kept and gh is not asked again. The key names the
// thread and the merge commit.
const finishedDeploys = new Map<string, ChatDeploy>();

const GhDeploymentsSchema = z.array(
  z.object({
    id: z.union([z.number(), z.string()]),
    environment: z.string().min(1),
    sha: z.string().nullish(),
    created_at: z.string(),
  }),
);
const GhDeploymentStatusesSchema = z.array(
  z.object({
    state: z.string().min(1),
    log_url: z.string().nullish(),
    target_url: z.string().nullish(),
    environment_url: z.string().nullish(),
  }),
);
const DeployRunSchema = ChatDeploySchema.shape.runs.unwrap().element;
const DeploymentSchema = ChatDeploySchema.shape.deployments.unwrap().element;
const RUNNING_STATES = new Set(['queued', 'pending', 'in_progress', 'unknown']);

async function readDeploy(
  host: ChatGitHost,
  taskId: string,
  root: string,
  run: ToolRunner,
): Promise<ChatDeploy | null> {
  const effects = host.effects.list(taskId);
  const merge = effects.findLast(
    (effect) =>
      effect.kind === 'merge' && effect.state === 'applied' && effect.observed?.created?.sha,
  );
  const commit = merge?.observed?.created?.sha;
  if (!merge || !commit) return null;
  // The pull request's own record names the base. A merge may not carry it.
  const base =
    merge.target.baseRef ??
    effects.find(
      (effect) => effect.kind === 'pr-open' && effect.observed?.created?.pr === merge.target.pr,
    )?.target.baseRef;
  if (!base) return null;
  const key = `${taskId}:${commit}`;
  const kept = finishedDeploys.get(key);
  if (kept) return kept;
  const { host: hostname, owner, name } = merge.target.repo;
  const repo = `${owner}/${name}`;
  const since = Date.parse(host.now()) - Date.parse(merge.observed?.at ?? host.now());
  const expired = since > FOLLOW_MS;
  const read = (
    reason: string | null,
    runs: ChatDeploy['runs'],
    deployments: ChatDeploy['deployments'],
  ) => {
    // Two empty lists right after the merge may only be early. Later they mean nothing ran, which
    // is an answer, so it ends the follow and never reads as still running.
    const none = runs !== null && deployments !== null && runs.length + deployments.length === 0;
    const quiet = none && since > NOTHING_RAN_MS;
    const unfinished =
      !quiet &&
      (runs === null ||
        deployments === null ||
        none ||
        runs.some((entry) => entry.status !== 'completed') ||
        deployments.some((entry) => RUNNING_STATES.has(entry.state)));
    const following = unfinished && !expired;
    const deploy: ChatDeploy = {
      commit,
      base,
      runs,
      deployments,
      following,
      reason: quiet ? NOTHING_RAN : expired && unfinished ? STILL_RUNNING : reason,
    };
    // Unreadable lists are tried again. Everything else that ended is final.
    if (!following && runs && deployments) finishedDeploys.set(key, deploy);
    return deploy;
  };
  const listed = await run(
    'gh',
    [
      'run',
      'list',
      '--repo',
      `${hostname}/${repo}`,
      '--commit',
      commit,
      '--branch',
      base,
      '--json',
      'databaseId,name,status,conclusion,url,createdAt,headSha',
      '--limit',
      '10',
    ],
    root,
  );
  let runs: ChatDeploy['runs'] = null;
  let reason: string | null = null;
  if (!listed) reason = 'Install gh to see what ran for the merge.';
  else if (listed.code !== 0)
    reason = lastLine(listed.stderr) ?? 'gh could not read the runs for the merge.';
  else {
    try {
      const rows = GhRunsSchema.parse(JSON.parse(listed.stdout));
      runs = rows.flatMap((row) => {
        if (row.headSha && row.headSha !== commit) return [];
        const entry = DeployRunSchema.safeParse({
          id: String(row.databaseId),
          name: row.name || row.workflowName || 'Workflow run',
          status: statuses.has(row.status) ? row.status : 'pending',
          conclusion: row.conclusion || null,
          url: row.url,
          createdAt: row.createdAt,
        });
        return entry.success ? [entry.data] : [];
      });
    } catch {
      reason = 'gh returned runs for the merge in a form CrewKite cannot read.';
    }
  }
  const api = (path: string) =>
    run('gh', ['api', '--hostname', hostname, `repos/${repo}/${path}`], root);
  const sent = await api(`deployments?sha=${commit}&per_page=10`);
  let deployments: ChatDeploy['deployments'] = null;
  if (sent?.code !== 0)
    reason ??=
      (sent && lastLine(sent.stderr)) || 'gh could not read the deployments for the merge.';
  else {
    try {
      const rows = GhDeploymentsSchema.parse(JSON.parse(sent.stdout)).filter(
        (row) => !row.sha || row.sha === commit,
      );
      deployments = await Promise.all(
        rows.map(async (row) => {
          // The newest status comes first. A deployment with no status has not started.
          const answer = await api(`deployments/${row.id}/statuses?per_page=1`);
          let state = 'unknown';
          let url: string | null = null;
          try {
            if (answer?.code === 0) {
              const latest = GhDeploymentStatusesSchema.parse(JSON.parse(answer.stdout))[0];
              state = latest?.state ?? 'pending';
              url = latest?.environment_url || latest?.target_url || latest?.log_url || null;
            }
          } catch {}
          const entry = DeploymentSchema.safeParse({
            id: String(row.id),
            environment: row.environment,
            state,
            url,
            createdAt: row.created_at,
          });
          // A row CrewKite cannot place still shows, as unknown.
          return entry.success
            ? entry.data
            : DeploymentSchema.parse({
                id: String(row.id),
                environment: row.environment.slice(0, 256),
                state: 'unknown',
                url: null,
                createdAt: host.now(),
              });
        }),
      );
    } catch {
      reason ??= 'gh returned deployments for the merge in a form CrewKite cannot read.';
    }
  }
  return read(reason, runs, deployments);
}
