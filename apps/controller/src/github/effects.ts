import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  type ChatThread,
  ChatThreadSchema,
  type Command,
  type CommandResult,
  canonicalJson,
  type GitHubRepository,
  MAX_MERGE_CHECKS,
  MAX_REVIEW_COMMENTS,
  MAX_THREAD_REMOTE_EFFECTS,
  type MergeReadiness,
  MergeReadinessSchema,
  ProposeRemoteEffectPayloadSchema,
  type RemoteEffect,
  type RemoteEffectChange,
  RemoteEffectSchema,
  RemoteEffectTargetSchema,
  ReviewCommentsReadSchema,
  type Task,
} from '@crewkite/contracts';
import { createOwnedProjectCommandRunner } from '../commands/owned-runner.ts';
import type { OwnedProjectCommandExecution } from '../commands/project-command.ts';
import { executablePin } from '../commands/task-operations.ts';
import { git } from '../host/source.ts';
import { groupAbsent } from '../host/worker.ts';
import type { Store } from '../store/index.ts';
import { attributionViolation, policyBlocked, repositoryPolicy } from './policy.ts';
import {
  collectBounded,
  endpoint,
  githubApiArgv,
  type ReviewCommentFiles,
  redactGitHubOutput,
  reviewCommentsArgv,
  reviewCommentsByFile,
} from './read.ts';
import {
  gitAndGhEnvironment,
  githubHosts,
  type RemoteRead,
  readRemote,
  type SshHost,
  sshHost,
} from './remote.ts';

// Every write CrewKite makes to a GitHub remote goes through here and the remote_effects table.
// A write is a proposal until the person confirms it. It is journaled as sent before its process
// starts. A write whose result CrewKite cannot trust stays unknown until a read of the remote
// settles it, and nothing sends it again on a guess.

type Payload<C extends Command['command']> = Extract<Command, { command: C }>['payload'];
type Tool = 'git' | 'gh';
type Json = Record<string, unknown>;
type Created = NonNullable<NonNullable<RemoteEffect['observed']>['created']>;

// A push over a slow link can take a while. An API call should not.
const SEND_MS: Record<Tool, number> = { git: 120_000, gh: 60_000 };
const READ_MS = 60_000;
// A reply or pull request is matched to a write that was confirmed up to this long before the
// remote stamped it, since this computer's clock and GitHub's can disagree.
const CLOCK_SKEW_MS = 5 * 60_000;
const OUTPUT_BYTES = 1024 * 1024;
const DIAGNOSTIC_BYTES = 8192;
const REASON_CHARS = 300;
const PREVIEW_BYTES = 32_768;
const BODY_BYTES = 16_384;
const LISTED_FILES = 50;

const inFlight: readonly RemoteEffect['state'][] = ['confirmed', 'sent', 'unknown'];
const greenConclusions = new Set(['success', 'neutral', 'skipped']);

/** What one process did. Only a quiescent exit with a code is evidence of a result. */
type Ran =
  | { kind: 'unlaunched' }
  | { kind: 'exited'; code: number; stdout: string; stderr: string }
  | { kind: 'lost'; stderr: string };
/** What a read of the remote showed about one write. */
type Seen =
  | { result: 'applied'; created: Created | null }
  | { result: 'absent'; reason: string }
  | { unreadable: string };
type Read = { ok: true; body: unknown } | { ok: false; reason: string; missing: boolean };
/** What GitHub asks of a merge at one head: why it cannot go, or what was read when it can. */
type Readiness = Pick<MergeReadiness, 'checks' | 'mergeState'> &
  ({ reason: string; line: null } | { reason: null; line: string });

export type RemoteEffectsDeps = {
  store: Store;
  /** The controller home. gh runs in a folder of its own there. */
  home: string;
  now: () => string;
  id: () => string;
  projectPath: (projectId: string) => string | undefined;
  /**
   * HOME, PATH and the few other variables git and gh read to find the person's sign-in. Tests
   * pass a temporary HOME and a PATH with a fake gh first.
   */
  environment?: Readonly<Record<string, string>>;
  /** Hears each change to a write, inside the transaction that made it. */
  changed?: (taskId: string, change: RemoteEffectChange) => void;
  /** Where an ssh remote's name really connects. Tests pass their own ssh configuration. */
  sshHost?: SshHost;
};

const blocked = (reason: string, next: string): CommandResult => ({
  outcome: 'blocked',
  reason,
  next,
});

const object = (value: unknown): Json | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;

const lastLine = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

const clip = (text: string, chars = REASON_CHARS) =>
  text.length > chars ? `${text.slice(0, chars - 3)}...` : text;

const short = (sha: unknown) => (typeof sha === 'string' ? sha.slice(0, 12) : 'an unknown commit');

const sameText = (left: string, right: string) =>
  left.replace(/\r\n/g, '\n').trimEnd() === right.replace(/\r\n/g, '\n').trimEnd();

/** Cuts on a whole character, so a clipped text stays well formed. */
function clipBytes(text: string, bytes: number) {
  if (Buffer.byteLength(text) <= bytes) return text;
  let kept = '';
  let size = 3;
  for (const character of text) {
    size += Buffer.byteLength(character);
    if (size > bytes) break;
    kept += character;
  }
  return `${kept}...`;
}

const repositoryName = (repo: GitHubRepository) => `${repo.host}/${repo.owner}/${repo.name}`;
const sameRepository = (left: GitHubRepository, right: GitHubRepository) =>
  left.host === right.host &&
  left.owner.toLowerCase() === right.owner.toLowerCase() &&
  left.name.toLowerCase() === right.name.toLowerCase();

/**
 * The process one write runs, and the JSON body gh sends from `input` when it has one. These are
 * the exact command lines the preview shows.
 */
export function remoteWriteCommand(
  effect: Pick<RemoteEffect, 'target' | 'request'>,
  input: string,
): { tool: Tool; argv: string[]; body: Json | null } {
  const { target, request } = effect;
  const repo = endpoint('repos', target.repo.owner, target.repo.name);
  const pull = `${repo}${endpoint('pulls', String(target.pr))}`;
  const api = (method: 'POST' | 'PATCH' | 'PUT', path: string, body: Json | null) => ({
    tool: 'gh' as const,
    argv: githubApiArgv(target.repo, method, path, body ? input : undefined),
    body,
  });
  switch (request.kind) {
    case 'push': {
      const ref = `refs/heads/${target.branch}`;
      return {
        tool: 'git',
        argv: [
          'push',
          request.remote,
          `${request.commit}:${ref}`,
          `--force-with-lease=${ref}:${request.expectedRemote ?? ''}`,
        ],
        body: null,
      };
    }
    case 'pr-open':
      return api('POST', `${repo}/pulls`, {
        title: request.title,
        body: request.body,
        head: target.branch,
        base: target.baseRef,
        draft: request.draft,
      });
    case 'pr-update':
      return api('PATCH', pull, {
        ...(request.title === undefined ? {} : { title: request.title }),
        ...(request.body === undefined ? {} : { body: request.body }),
      });
    case 'pr-ready':
    case 'pr-draft':
      // Draft state changes only through GraphQL. gh pr ready does that call and needs no body.
      return {
        tool: 'gh',
        argv: [
          'pr',
          'ready',
          String(target.pr),
          '--repo',
          repositoryName(target.repo),
          ...(request.kind === 'pr-draft' ? ['--undo'] : []),
        ],
        body: null,
      };
    case 'review-reply':
      return api('POST', `${pull}${endpoint('comments', request.commentId, 'replies')}`, {
        body: request.body,
      });
    case 'rerun':
      return api(
        'POST',
        `${repo}${endpoint('actions', 'runs', request.runId, request.failedOnly ? 'rerun-failed-jobs' : 'rerun')}`,
        null,
      );
    case 'merge':
      // The head sha makes GitHub itself refuse a merge of any other head. Nothing here asks for
      // an administrator bypass, and no such flag exists in this call.
      return api('PUT', `${pull}/merge`, {
        merge_method: request.method,
        sha: request.expectedHead,
      });
  }
}

const quoted = (word: string) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word}'`);

/** The exact write in words, as the confirmation shows it. */
export function remoteWritePreview(effect: Pick<RemoteEffect, 'target' | 'request'>): string {
  const { target, request } = effect;
  const where = repositoryName(target.repo);
  const pr = `pull request #${target.pr} on ${where}`;
  const lines: string[] = [];
  switch (request.kind) {
    case 'push':
      lines.push(
        `Push commit ${request.commit} to ${target.branch} on ${request.remote} (${where}) with your own git credentials.`,
        request.expectedRemote
          ? `Git refuses it unless ${target.branch} there is still at ${request.expectedRemote}.`
          : `Git refuses it if ${target.branch} already exists there.`,
      );
      break;
    case 'pr-open':
      lines.push(
        `Open a ${request.draft ? 'draft ' : ''}pull request on ${where} from ${target.branch} into ${target.baseRef}, head ${target.headSha}.`,
        `Title: ${request.title}`,
        'Body:',
        request.body || '(empty)',
      );
      break;
    case 'pr-update':
      lines.push(`Update ${pr}, head ${target.headSha}.`);
      if (request.title !== undefined) lines.push(`New title: ${request.title}`);
      if (request.body !== undefined) lines.push('New body:', request.body || '(empty)');
      break;
    case 'pr-ready':
      lines.push(`Mark ${pr} ready for review, head ${target.headSha}.`);
      break;
    case 'pr-draft':
      lines.push(`Turn ${pr} back into a draft, head ${target.headSha}.`);
      break;
    case 'review-reply':
      lines.push(
        `Reply to review comment ${request.commentId} on ${pr} as your GitHub account.`,
        'Reply:',
        request.body,
      );
      break;
    case 'rerun':
      lines.push(
        `Run ${request.failedOnly ? 'the failed jobs' : 'every job'} of workflow run ${request.runId} on ${where} again. Attempt ${request.attempt} is the newest, for ${target.headSha}.`,
      );
      break;
    case 'merge':
      lines.push(
        `Merge ${pr} by ${request.method}, only while its head is ${request.expectedHead}.`,
        'Branch protection and the required checks for that head are read first. A merge they do not allow is refused here, and nothing asks GitHub to bypass them.',
      );
      break;
  }
  const command = remoteWriteCommand(effect, 'request.json');
  lines.push('', 'Command:', [command.tool, ...command.argv].map(quoted).join(' '));
  if (command.body)
    lines.push(`request.json holds ${Object.keys(command.body).join(', ')} as shown above.`);
  return clipBytes(lines.join('\n'), PREVIEW_BYTES);
}

/**
 * What GitHub said about a failed call. gh prints the response body, with its message and
 * errors, on stdout and its own summary line on stderr.
 */
function githubSaid(stdout: string, stderr: string): string {
  try {
    const body = object(JSON.parse(stdout));
    const errors = Array.isArray(body?.errors)
      ? body.errors
          .map((entry) => object(entry)?.message)
          .filter((text) => typeof text === 'string')
      : [];
    const said = [body?.message, ...errors].filter((text) => typeof text === 'string').join(' ');
    if (said) return said;
  } catch {}
  return lastLine(stderr) ?? '';
}

/**
 * The remote's own refusal in a failed command, or null when the output does not prove the write
 * was turned away. A refused write applied nothing. Anything else may have landed.
 */
function refusal(effect: RemoteEffect, stdout: string, stderr: string): string | null {
  const line = lastLine(stderr) ?? '';
  if (effect.request.kind === 'push') {
    if (/stale info|\[rejected\]|\[remote rejected\]|non-fast-forward/i.test(stderr))
      return `${effect.target.branch} changed on ${effect.request.remote} since you last saw it.`;
    // Each of these stops git before it sends anything.
    return /permission denied|authentication failed|could not read (?:username|password)|repository not found|does not appear to be a git repository|src refspec/i.test(
      stderr,
    )
      ? line
      : null;
  }
  return /\(HTTP 4\d\d\)|^GraphQL:|gh auth login|authentication required|"status":\s*"4\d\d"/im.test(
    `${stdout}\n${stderr}`,
  )
    ? githubSaid(stdout, stderr)
    : null;
}

/** What a write that exited cleanly made, or null when its answer cannot be read. */
function made(
  effect: RemoteEffect,
  stdout: string,
): { created: Created | null; reason: string | null } | null {
  const { request, target } = effect;
  if (request.kind === 'push' || request.kind === 'pr-ready' || request.kind === 'pr-draft')
    return { created: null, reason: null };
  if (request.kind === 'rerun') return { created: null, reason: null };
  let body: Json | null;
  try {
    body = object(JSON.parse(stdout));
  } catch {
    return null;
  }
  if (!body) return null;
  if (request.kind === 'pr-open') {
    const number = body.number;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return null;
    const head = object(body.head)?.sha;
    return {
      created: { pr: number },
      reason:
        head === target.headSha
          ? null
          : `The pull request opened on ${short(head)}, not on ${short(target.headSha)}.`,
    };
  }
  if (request.kind === 'pr-update')
    return body.number === target.pr ? { created: null, reason: null } : null;
  if (request.kind === 'review-reply') {
    const id = body.id;
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0
      ? { created: { id: String(id) }, reason: null }
      : null;
  }
  const sha = body.sha;
  return body.merged === true && typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha)
    ? { created: { sha }, reason: null }
    : null;
}

/** The status checks a base branch requires, from classic protection and from rulesets. */
function requiredChecks(branch: unknown, rules: unknown): string[] {
  const names = new Set<string>();
  const checks = object(object(object(branch)?.protection)?.required_status_checks);
  if (checks && checks.enforcement_level !== 'off') {
    for (const name of Array.isArray(checks.contexts) ? checks.contexts : [])
      if (typeof name === 'string') names.add(name);
    for (const check of Array.isArray(checks.checks) ? checks.checks : []) {
      const name = object(check)?.context;
      if (typeof name === 'string') names.add(name);
    }
  }
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (object(rule)?.type !== 'required_status_checks') continue;
    const listed = object(object(rule)?.parameters)?.required_status_checks;
    for (const check of Array.isArray(listed) ? listed : []) {
      const name = object(check)?.context;
      if (typeof name === 'string') names.add(name);
    }
  }
  return [...names].sort();
}

/** Where one required check stands on one commit: green, or the word that says why not. */
function checkState(name: string, head: string, runs: unknown, statuses: unknown): string {
  const listed = object(runs)?.check_runs;
  const run = (Array.isArray(listed) ? listed : [])
    .map(object)
    .filter((entry): entry is Json => entry?.name === name && entry.head_sha === head)
    .sort((left, right) => Number(right.id) - Number(left.id))[0];
  if (run) {
    if (run.status !== 'completed') return 'pending';
    return greenConclusions.has(String(run.conclusion)) ? 'green' : String(run.conclusion);
  }
  const combined = object(statuses);
  const status =
    combined?.sha === head && Array.isArray(combined.statuses)
      ? combined.statuses.map(object).find((entry) => entry?.context === name)
      : undefined;
  if (status) return status.state === 'success' ? 'green' : String(status.state);
  return 'missing';
}

export class RemoteEffects {
  private readonly deps: RemoteEffectsDeps;
  /** Writes and reads running in this controller, by effect. A second action on one waits. */
  private readonly active = new Map<string, Promise<CommandResult>>();
  private readonly running = new Set<OwnedProjectCommandExecution>();
  /**
   * Unknown writes a reconcile in this controller read and could not settle. Only these may be
   * settled on the person's word, so that word never stands in for a read that was not tried.
   */
  private readonly unproven = new Set<string>();
  private closed = false;

  constructor(deps: RemoteEffectsDeps) {
    this.deps = deps;
  }

  /** The thread's writes, oldest first. A thread with more than the cap shows its newest. */
  read(payload: Payload<'ReadRemoteEffects'>): CommandResult {
    if (!this.task(payload.taskId)) return blocked('task-not-found', 'Choose a registered task.');
    return {
      outcome: 'applied',
      data: {
        kind: 'remote-effects',
        taskId: payload.taskId,
        effects: this.deps.store.remoteEffects(payload.taskId).slice(-MAX_THREAD_REMOTE_EFFECTS),
      },
    };
  }

  /**
   * Records a proposal and answers with its preview. It reads only local Git and sends nothing.
   * Call it inside the command's transaction. A new pull request with an empty body gets one built
   * from the thread's plan and the branch's diff, and the preview shows that body.
   */
  propose(payload: Payload<'ProposeRemoteEffect'>): CommandResult {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found', 'Choose a registered task.');
    const root = this.deps.projectPath(task.projectId);
    if (!root)
      return blocked('project-not-found', 'Add the project again, then propose the write.');
    const { target } = payload;
    let request = payload.request;
    if (!this.remoteOf(root, target.repo, request.kind === 'push' ? request.remote : null))
      return blocked(
        'repository-not-a-remote',
        `${repositoryName(target.repo)} is not ${request.kind === 'push' ? `what ${request.remote} points at` : 'a remote of this project'}. Choose the project's own repository.`,
      );
    const thread = this.thread(task.id);
    if (request.kind === 'push') {
      const accepted = thread?.lastAcceptance;
      if (accepted?.branch !== target.branch || accepted.commit !== request.commit)
        return blocked(
          'branch-not-accepted',
          'Push the commit this thread accepted, to the branch it accepted it on.',
        );
    }
    if (request.kind === 'pr-open') {
      if (!this.pushed(task.id, thread, target.branch, target.headSha))
        return blocked('branch-not-pushed', 'Push the branch, then open a pull request.');
      if (!request.body) request = { ...request, body: this.pullRequestBody(root, thread, target) };
    }
    const policy = repositoryPolicy(this.deps.store, task.projectId);
    // Pull request text follows the same attribution rule as a commit message.
    const text =
      request.kind === 'pr-open' || request.kind === 'pr-update'
        ? [request.title, request.body]
        : request.kind === 'review-reply'
          ? [request.body]
          : [];
    const attributed = attributionViolation(
      policy,
      text.filter((part) => part !== undefined).join('\n'),
      'propose again',
    );
    if (attributed) return policyBlocked(attributed);
    if (request.kind === 'merge') {
      const method = policy.mergeMethod;
      if (request.method !== method)
        return blocked(
          'merge-method',
          `This repository merges by ${method}. Change its policy to merge another way.`,
        );
    }
    const effect = RemoteEffectSchema.parse({
      id: this.deps.id(),
      taskId: task.id,
      kind: request.kind,
      state: 'proposed',
      target,
      request,
      confirmation: null,
      observed: null,
      reason: null,
    });
    this.put(effect);
    return this.answer(effect);
  }

  /**
   * Moves a proposal to confirmed and sends it: confirmed, then sent the moment before the
   * process starts, then applied or refused, or unknown when the result cannot be trusted. A
   * confirmed write that a restart caught before anything was sent may be confirmed again.
   */
  confirm(payload: Payload<'ConfirmRemoteEffect'>): Promise<CommandResult> {
    return this.exclusive(payload.effectId, async () => {
      const effect = this.deps.store.remoteEffect(payload.effectId);
      if (!effect) return blocked('remote-effect-not-found', 'Read the thread again.');
      if (effect.state === 'applied') return { ...this.answer(effect), outcome: 'already-applied' };
      if (effect.state === 'sent' || effect.state === 'unknown') return this.answer(effect);
      if (effect.state !== 'proposed' && effect.state !== 'confirmed')
        return blocked('remote-effect-ended', 'This write already ended. Propose a new one.');
      let confirmed = effect;
      if (effect.state === 'proposed') {
        this.clearLeftover(effect);
        confirmed = {
          ...effect,
          state: 'confirmed',
          confirmation: { at: this.deps.now(), by: 'person' },
        };
        try {
          this.save(confirmed);
        } catch (error) {
          if (!(error instanceof Error) || !/UNIQUE constraint/.test(error.message)) throw error;
          return blocked(
            'remote-write-in-flight',
            `Another ${effect.kind} for this thread has no settled result yet. Reconcile or cancel it first.`,
          );
        }
      }
      return this.send(confirmed);
    });
  }

  /** Proposes and confirms in one step, for the push and pull request buttons that confirm. */
  async submit(payload: Payload<'ProposeRemoteEffect'>): Promise<CommandResult> {
    const parsed = ProposeRemoteEffectPayloadSchema.safeParse(payload);
    if (!parsed.success)
      return blocked('invalid-remote-write', 'The write does not name its target.');
    this.clearLeftover({ id: '', taskId: payload.taskId, kind: payload.request.kind });
    const held = this.deps.store
      .remoteEffects(payload.taskId)
      .find((effect) => effect.kind === payload.request.kind && inFlight.includes(effect.state));
    if (held)
      return {
        ...this.answer(held),
        outcome: 'blocked',
        reason: 'remote-write-in-flight',
        next: `The last ${held.kind} for this thread has no settled result yet. Reconcile it first.`,
      };
    const proposed = this.deps.store.transaction(() => this.propose(parsed.data));
    if (proposed.data?.kind !== 'remote-effect') return proposed;
    return this.confirm({ effectId: proposed.data.effect.id, confirm: 'explicit' });
  }

  /** Records a proposal in a transaction of its own, for a button outside the command path. */
  proposeNow(payload: Payload<'ProposeRemoteEffect'>): CommandResult {
    const parsed = ProposeRemoteEffectPayloadSchema.safeParse(payload);
    if (!parsed.success)
      return blocked('invalid-remote-write', 'The write does not name its target.');
    return this.deps.store.transaction(() => this.propose(parsed.data));
  }

  /**
   * Proposes a write in place of an earlier proposal that never went out. Both happen in one
   * transaction, so the thread never holds two proposals or none.
   */
  proposeInstead(earlier: string, payload: Payload<'ProposeRemoteEffect'>): CommandResult {
    const parsed = ProposeRemoteEffectPayloadSchema.safeParse(payload);
    if (!parsed.success)
      return blocked('invalid-remote-write', 'The write does not name its target.');
    return this.deps.store.transaction(() => {
      const cancelled = this.cancel({ effectId: earlier });
      return cancelled.outcome === 'blocked' ? cancelled : this.propose(parsed.data);
    });
  }

  /** Cancels a proposal, or a confirmed write nothing has started to send. */
  cancel(payload: Payload<'CancelRemoteEffect'>): CommandResult {
    const effect = this.deps.store.remoteEffect(payload.effectId);
    if (!effect) return blocked('remote-effect-not-found', 'Read the thread again.');
    if (effect.state === 'cancelled') return { ...this.answer(effect), outcome: 'already-applied' };
    const unsent =
      effect.state === 'proposed' ||
      (effect.state === 'confirmed' && !this.active.has(payload.effectId));
    if (!unsent)
      return blocked(
        'remote-write-not-cancellable',
        effect.state === 'confirmed' || effect.state === 'sent' || effect.state === 'unknown'
          ? 'This write is being sent or was sent. Reconcile it to learn what happened.'
          : 'This write already ended.',
      );
    const cancelled: RemoteEffect = { ...effect, state: 'cancelled' };
    this.put(cancelled);
    return this.answer(cancelled);
  }

  /**
   * Reads the remote to settle a sent or unknown write. It sends nothing. A read that cannot reach
   * the remote leaves the write unknown, and so does a read that finds nothing while the write
   * could still land.
   */
  reconcile(payload: Payload<'ReconcileRemoteEffect'>): Promise<CommandResult> {
    return this.exclusive(payload.effectId, async () => {
      const effect = this.deps.store.remoteEffect(payload.effectId);
      if (!effect) return blocked('remote-effect-not-found', 'Read the thread again.');
      if (effect.state === 'applied') return { ...this.answer(effect), outcome: 'already-applied' };
      if (effect.state !== 'sent' && effect.state !== 'unknown')
        return blocked(
          'remote-write-settled',
          'Only a write that was sent and has no result needs a read of the remote.',
        );
      const seen = await this.observe(effect);
      const now = this.deps.now();
      if ('unreadable' in seen) {
        // The record changes only from sent to unknown, so a read that fails while offline does
        // not move the time the write could still land.
        const unknown: RemoteEffect = { ...effect, state: 'unknown' };
        if (effect.state === 'sent') this.save(unknown);
        this.unproven.add(effect.id);
        return {
          ...this.answer(unknown),
          reason: 'remote-unreadable',
          next: clip(
            `The remote could not be read, so the write stays unknown. ${seen.unreadable}`,
          ),
        };
      }
      // Nothing on the remote settles the write only once its process is proven gone. A process
      // that still runs can land it later. remote-write-may-land says this look found it running,
      // so a settle by hand can warn that it may still reach GitHub. A crash before its group was
      // known leaves nothing to look at.
      if (seen.result === 'absent' && !this.ended(effect.id)) {
        if (effect.state === 'unknown') this.unproven.add(effect.id);
        const unseen = this.deps.store.remoteEffectProcess(effect.id) === 0;
        return {
          ...this.answer(effect),
          outcome: 'blocked',
          reason: unseen ? 'remote-write-process-unknown' : 'remote-write-may-land',
          next: unseen
            ? 'The remote shows nothing, and CrewKite cannot tell whether the process that sent this write is gone. Check the remote yourself.'
            : 'The remote shows nothing yet, and the process that sent this write still runs. Reconcile again once it has ended.',
        };
      }
      const settled: RemoteEffect =
        seen.result === 'applied'
          ? {
              ...effect,
              state: 'applied',
              observed: { at: now, result: 'applied', created: seen.created },
              reason: null,
            }
          : {
              ...effect,
              state: 'refused',
              observed: { at: now, result: 'absent', created: null },
              reason: clip(seen.reason),
            };
      this.save(settled);
      this.unproven.delete(effect.id);
      return this.answer(settled);
    });
  }

  /**
   * Settles an unknown write on the person's word after they checked GitHub: applied when they
   * saw it there, refused when they saw it was not sent. A reconcile here must have read the
   * remote first and found nothing it could prove. The record keeps who settled it, when and
   * their note, and the write's kind and the thread delete are free again. It reads and sends
   * nothing. Call it inside the command's transaction.
   */
  settle(payload: Payload<'SettleRemoteEffect'>): CommandResult {
    const effect = this.deps.store.remoteEffect(payload.effectId);
    if (!effect) return blocked('remote-effect-not-found', 'Read the thread again.');
    if (effect.state !== 'unknown')
      return blocked(
        'remote-write-not-unknown',
        'Only a write whose result is unknown can be settled by hand.',
      );
    if (this.active.has(effect.id))
      return blocked(
        'remote-write-running',
        'CrewKite is still working on this write. Wait for it to end.',
      );
    if (!this.unproven.has(effect.id))
      return blocked(
        'remote-write-not-checked',
        'Check it first. CrewKite reads GitHub before you settle a write by hand.',
      );
    const applied = payload.outcome === 'applied';
    const settled: RemoteEffect = {
      ...effect,
      state: applied ? 'applied' : 'refused',
      reason: applied
        ? 'You checked GitHub and marked this as done.'
        : 'You checked GitHub and marked this as not sent.',
      settled: { at: this.deps.now(), by: 'person', note: payload.note.trim() },
    };
    this.put(settled);
    this.unproven.delete(effect.id);
    // The settle itself applied, whichever way the person settled the write.
    return {
      outcome: 'applied',
      data: { kind: 'remote-effect', effect: settled, preview: remoteWritePreview(settled) },
    };
  }

  /**
   * A pull request's review comments grouped by file, read for that pull request and head. A
   * null head reads whatever head the pull request has now.
   */
  async reviewComments(
    repo: GitHubRepository,
    pullRequest: number,
    headSha: string | null,
  ): Promise<ReviewCommentFiles | { reason: string }> {
    const argv = reviewCommentsArgv(repo, String(pullRequest));
    const pull = await this.get(repo, argv.pull);
    if (!pull.ok) return { reason: pull.reason };
    const comments = await this.get(repo, argv.comments);
    if (!comments.ok) return { reason: comments.reason };
    return (
      reviewCommentsByFile(pull.body, comments.body, {
        host: repo.host,
        pullRequest: String(pullRequest),
        headSha,
      }) ?? {
        reason:
          headSha === null
            ? 'GitHub answered in a form CrewKite cannot read.'
            : `The pull request head is no longer ${short(headSha)}.`,
      }
    );
  }

  /** The read behind ReadReviewComments. It sends nothing. */
  async readReviewComments(payload: Payload<'ReadReviewComments'>): Promise<CommandResult> {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found', 'Choose a registered task.');
    const root = this.deps.projectPath(task.projectId);
    if (!root || !this.remoteOf(root, payload.repo, null))
      return blocked(
        'repository-not-a-remote',
        `${repositoryName(payload.repo)} is not a remote of this project. Choose the project's own repository.`,
      );
    const read = await this.reviewComments(payload.repo, payload.pr, payload.headSha);
    const parsed =
      'reason' in read
        ? null
        : ReviewCommentsReadSchema.safeParse({
            taskId: task.id,
            repo: payload.repo,
            pr: payload.pr,
            headSha: read.headSha,
            readAt: this.deps.now(),
            files: read.files,
            truncated: read.truncated,
          });
    if (!parsed?.success)
      return blocked(
        'review-comments-unreadable',
        'reason' in read ? read.reason : 'GitHub answered in a form CrewKite cannot read.',
      );
    return { outcome: 'applied', data: { kind: 'review-comments', ...parsed.data } };
  }

  /**
   * What GitHub asks of a merge of the pull request this thread opened, at the head the thread
   * last pushed to its branch, so Merge can show the required checks and GitHub's merge state
   * before the click. It sends nothing. The proposal and the send read it all again.
   */
  async readMergeReadiness(payload: Payload<'ReadMergeReadiness'>): Promise<CommandResult> {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found', 'Choose a registered task.');
    const target = this.pullRequestTarget(task.id);
    if (!target)
      return blocked(
        'pull-request-not-open',
        'Open a pull request from this thread, then read what its merge needs.',
      );
    const read = await this.mergeReadiness(target);
    const parsed = MergeReadinessSchema.safeParse({
      taskId: task.id,
      repo: target.repo,
      pr: target.pr,
      headSha: target.headSha,
      readAt: this.deps.now(),
      ...read,
    });
    if (!parsed.success)
      return blocked(
        'merge-readiness-unreadable',
        'GitHub answered in a form CrewKite cannot read.',
      );
    return { outcome: 'applied', data: { kind: 'merge-readiness', ...parsed.data } };
  }

  /**
   * One write's record and the preview it was proposed with, from the journal. A proposal a
   * restart left waiting is confirmed from this. Nothing is proposed again.
   */
  preview(payload: Payload<'ReadRemoteEffectPreview'>): CommandResult {
    const effect = this.deps.store.remoteEffect(payload.effectId);
    if (!effect) return blocked('remote-effect-not-found', 'Read the thread again.');
    return {
      outcome: 'applied',
      data: { kind: 'remote-effect', effect, preview: remoteWritePreview(effect) },
    };
  }

  /**
   * The project remote that points at `repo`: the one the thread pushed to when it does, else the
   * first one configured. Null when none does.
   */
  remoteFor(taskId: string, repo: GitHubRepository): string | null {
    const root = this.root(taskId);
    if (!root) return null;
    const names = this.remotes(root)
      .filter(({ url }) => {
        const named = this.readUrl(url);
        return named.kind === 'github' && sameRepository(named.repo, repo);
      })
      .map(({ name }) => name);
    const pushed = this.thread(taskId)?.lastPush?.remote;
    return pushed && names.includes(pushed) ? pushed : (names[0] ?? null);
  }

  /** The GitHub repository a remote of the thread's project points at, or null for any other. */
  repository(taskId: string, remote: string): GitHubRepository | null {
    const read = this.remote(taskId, remote);
    return read?.kind === 'github' ? read.repo : null;
  }

  /** What a remote of the thread's project is, or null when the project has no such remote. */
  remote(taskId: string, remote: string): RemoteRead | null {
    const root = this.root(taskId);
    const url = root ? this.remoteUrl(root, remote) : null;
    return url ? this.readUrl(url) : null;
  }

  private readUrl(url: string): RemoteRead {
    return readRemote(
      url,
      this.deps.sshHost ?? sshHost,
      githubHosts(this.deps.environment ?? process.env),
    );
  }

  /** The branch a pull request merges into when none is named: the remote's default branch. */
  async defaultBranch(taskId: string, remote: string, repo: GitHubRepository) {
    const root = this.root(taskId);
    let name: unknown = null;
    if (root)
      try {
        name = git(root, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`])
          .toString('utf8')
          .trim()
          .slice(`refs/remotes/${remote}/`.length);
      } catch {}
    if (!name) {
      const read = await this.get(
        repo,
        githubApiArgv(repo, 'GET', endpoint('repos', repo.owner, repo.name)),
      );
      name = read.ok ? object(read.body)?.default_branch : null;
    }
    const parsed = RemoteEffectTargetSchema.shape.baseRef.safeParse(name);
    return parsed.success ? parsed.data : null;
  }

  /** Whether gh can be found and pinned on this computer. */
  hasGh(): boolean {
    try {
      this.pin('gh');
      return true;
    } catch {
      return false;
    }
  }

  /** The thread's writes, oldest first. */
  list(taskId: string): RemoteEffect[] {
    return this.deps.store.remoteEffects(taskId);
  }

  /**
   * At startup no write of this controller is running yet, so a sent write has no process here.
   * Its result is unknown until a read of the remote settles it. It is never sent again. The group
   * an earlier controller recorded is only checked, never signalled: the number may belong to
   * another process by now.
   */
  recover() {
    const ids = this.deps.store.db
      .prepare("SELECT id FROM remote_effects WHERE state='sent'")
      .all()
      .map((row) => row.id as string);
    if (!ids.length) return;
    this.deps.store.transaction(() => {
      for (const id of ids) {
        const effect = this.deps.store.remoteEffect(id);
        if (!effect || this.active.has(id)) continue;
        // A group that is already gone is cleared, so the proof outlives this start.
        if (this.deps.store.remoteEffectProcess(id) !== null && this.ended(id))
          this.deps.store.setRemoteEffectProcess(id, null);
        this.put({
          ...effect,
          state: 'unknown',
          reason:
            'CrewKite stopped while this write was running. Reconcile it to read what the remote holds.',
        });
      }
    });
  }

  /** Stops the running processes. Each write they belong to ends unknown and stays journaled. */
  close(): Promise<void> | undefined {
    this.closed = true;
    for (const execution of this.running) execution.stop();
    if (!this.active.size) return;
    return Promise.allSettled([...this.active.values()]).then(() => {});
  }

  /**
   * A confirmed write that nothing here is sending was left by a restart before it was sent. It
   * holds its kind's slot, so a new write of that kind cancels it and goes ahead.
   */
  private clearLeftover(next: Pick<RemoteEffect, 'id' | 'taskId' | 'kind'>) {
    for (const effect of this.deps.store.remoteEffects(next.taskId))
      if (
        effect.id !== next.id &&
        effect.kind === next.kind &&
        effect.state === 'confirmed' &&
        !this.active.has(effect.id)
      )
        this.save({
          ...effect,
          state: 'cancelled',
          reason: 'A newer write of this kind replaced it before anything was sent.',
        });
  }

  /** Whether the write's process is gone: none is recorded, or its group no longer exists. */
  private ended(effectId: string): boolean {
    const group = this.deps.store.remoteEffectProcess(effectId);
    return group === null || (group > 0 && groupAbsent(group));
  }

  private process(effectId: string, group: number | null) {
    this.deps.store.transaction(() => this.deps.store.setRemoteEffectProcess(effectId, group));
  }

  private async exclusive(effectId: string, work: () => Promise<CommandResult>) {
    if (this.closed) return blocked('controller-closing', 'Try again after CrewKite restarts.');
    if (this.active.has(effectId))
      return blocked(
        'remote-write-running',
        'CrewKite is still working on this write. Wait for it to end.',
      );
    const promise = work();
    this.active.set(effectId, promise);
    try {
      return await promise;
    } finally {
      this.active.delete(effectId);
    }
  }

  private async send(effect: RemoteEffect): Promise<CommandResult> {
    const end = (patch: Partial<RemoteEffect>) => {
      const ended = { ...effect, ...patch };
      this.save(ended);
      return this.answer(ended);
    };
    const root = this.root(effect.taskId);
    if (!root) return end({ state: 'refused', reason: 'The project is gone. Nothing was sent.' });
    const stop = await this.preflight(effect);
    if (stop) return end({ state: 'refused', reason: clip(stop) });
    const folder = this.folder();
    const input = join(folder, `${effect.id}.json`);
    const command = remoteWriteCommand(effect, input);
    if (command.body) writeFileSync(input, canonicalJson(command.body), { mode: 0o600 });
    let ran: Ran;
    try {
      ran = await this.run(
        command.tool,
        command.argv,
        command.tool === 'git' ? realpathSync(root) : folder,
        effect.target.repo,
        SEND_MS[command.tool],
        {
          sent: () =>
            this.deps.store.transaction(() => {
              this.put({ ...effect, state: 'sent' });
              this.deps.store.setRemoteEffectProcess(effect.id, 0);
            }),
          owned: (group) => this.process(effect.id, group),
          ended: () => this.process(effect.id, null),
        },
      );
    } finally {
      rmSync(input, { force: true });
    }
    const now = this.deps.now();
    if (ran.kind === 'unlaunched')
      return end({
        state: 'refused',
        reason: `${command.tool} could not start, so nothing was sent.`,
      });
    if (ran.kind === 'exited' && ran.code === 0) {
      const answer = made(effect, ran.stdout);
      if (answer) {
        let created = answer.created;
        // A rerun answers with no body. The run itself says which attempt it started.
        if (effect.request.kind === 'rerun') {
          const seen = await this.observe(effect);
          if ('result' in seen && seen.result === 'applied') created = seen.created;
        }
        return end({
          state: 'applied',
          observed: { at: now, result: 'applied', created },
          reason: answer.reason && clip(answer.reason),
        });
      }
    }
    if (ran.kind === 'exited' && ran.code !== 0) {
      // GitHub keeps one open pull request per branch. The one there is adopted by a read.
      if (
        effect.request.kind === 'pr-open' &&
        /already exists/i.test(`${ran.stdout}\n${ran.stderr}`)
      ) {
        const seen = await this.observe(effect);
        return 'result' in seen && seen.result === 'applied'
          ? end({
              state: 'applied',
              observed: { at: now, result: 'applied', created: seen.created },
              reason: 'A pull request from this branch was already open.',
            })
          : end({
              state: 'unknown',
              reason:
                'GitHub says a pull request from this branch is open, and it could not be read.',
            });
      }
      const refused = refusal(effect, ran.stdout, ran.stderr);
      if (refused)
        return end({
          state: 'refused',
          observed: { at: now, result: 'refused', created: null },
          reason: clip(refused),
        });
    }
    const said = lastLine(ran.stderr);
    return end({
      state: 'unknown',
      reason: clip(
        `${command.tool} ended without a result CrewKite can trust${said ? `: ${said}` : '.'}`,
      ),
    });
  }

  /**
   * Reads that must hold before a write is sent. Each names the head the person saw, so a write
   * never lands on a pull request or run that moved. A merge also reads branch protection and the
   * head's checks. The reason comes back when the write must not be sent.
   */
  private async preflight(effect: RemoteEffect): Promise<string | null> {
    const { target, request } = effect;
    if (request.kind === 'push' || request.kind === 'pr-open') return null;
    if (request.kind === 'merge') return (await this.mergeReadiness(target)).reason;
    const repo = endpoint('repos', target.repo.owner, target.repo.name);
    const get = (path: string) => this.get(target.repo, githubApiArgv(target.repo, 'GET', path));
    if (request.kind === 'rerun') {
      const read = await get(`${repo}${endpoint('actions', 'runs', request.runId)}`);
      if (!read.ok)
        return `Run ${request.runId} could not be read, so nothing was sent. ${read.reason}`;
      const run = object(read.body);
      if (run?.head_sha !== target.headSha) return `Run ${request.runId} is for another commit.`;
      if (run.run_attempt !== request.attempt)
        return `Run ${request.runId} is on attempt ${run.run_attempt} now. Read it again, then propose the rerun again.`;
      if (run.status !== 'completed')
        return `Run ${request.runId} is still going. Rerun it when it ends.`;
      return null;
    }
    const pull = await this.openAt(target);
    return 'reason' in pull ? pull.reason : null;
  }

  /** The pull request when it is open at the head the person saw, or why it is not. */
  private async openAt(
    target: RemoteEffect['target'],
  ): Promise<{ pull: Json } | { reason: string }> {
    const path = `${endpoint('repos', target.repo.owner, target.repo.name)}${endpoint('pulls', String(target.pr))}`;
    const read = await this.get(target.repo, githubApiArgv(target.repo, 'GET', path));
    if (!read.ok)
      return {
        reason: `Pull request #${target.pr} could not be read, so nothing was sent. ${read.reason}`,
      };
    const pull = object(read.body);
    const seenHead = object(pull?.head)?.sha;
    if (pull?.state !== 'open' || pull.merged === true)
      return { reason: `Pull request #${target.pr} is not open.` };
    if (seenHead !== target.headSha || !target.headSha)
      return {
        reason: `The head of pull request #${target.pr} moved to ${short(seenHead)} after you saw ${short(target.headSha)}. Read it again, then propose again.`,
      };
    return { pull };
  }

  /**
   * What GitHub asks of a merge at the head the person saw: the pull request open at that head,
   * every required check on it green and a merge state that lets it through. It sends nothing. A
   * merge proposal reads it to show the person, and the send reads it again. `reason` says why the
   * merge cannot go now. `line` names what was read when it can. `checks` holds each required
   * check read so far and where it stands, and `mergeState` is GitHub's own word for the merge.
   */
  async mergeReadiness(target: RemoteEffect['target']): Promise<Readiness> {
    let checks: Readiness['checks'] = [];
    let mergeState: string | null = null;
    const no = (reason: string): Readiness => ({
      reason: clip(reason, 1000),
      line: null,
      checks,
      mergeState,
    });
    const open = await this.openAt(target);
    if ('reason' in open) return no(open.reason);
    const { pull } = open;
    if (typeof pull.mergeable_state === 'string' && pull.mergeable_state)
      mergeState = clip(pull.mergeable_state, 64);
    const repo = endpoint('repos', target.repo.owner, target.repo.name);
    const get = (path: string) => this.get(target.repo, githubApiArgv(target.repo, 'GET', path));
    const head = target.headSha as string;
    const base = object(pull.base)?.ref;
    if (typeof base !== 'string')
      return no('GitHub did not say which branch the pull request merges into.');
    if (target.baseRef && base !== target.baseRef)
      return no(`Pull request #${target.pr} merges into ${base} now, not ${target.baseRef}.`);
    const protection = await get(`${repo}${endpoint('branches', base)}`);
    if (!protection.ok)
      return no(
        `Branch protection on ${base} could not be read, so nothing was merged. ${protection.reason}`,
      );
    const rules = await get(`${repo}${endpoint('rules', 'branches', base)}?per_page=100`);
    if (!rules.ok && !rules.missing)
      return no(`The rules on ${base} could not be read, so nothing was merged. ${rules.reason}`);
    const required = requiredChecks(protection.body, rules.ok ? rules.body : []);
    if (required.length) {
      const runs = await get(`${repo}${endpoint('commits', head, 'check-runs')}?per_page=100`);
      const statuses = await get(`${repo}${endpoint('commits', head, 'status')}?per_page=100`);
      if (!runs.ok || !statuses.ok)
        return no(`The checks on ${short(head)} could not be read, so nothing was merged.`);
      const states = required.map(
        (name) => [name, checkState(name, head, runs.body, statuses.body)] as const,
      );
      checks = states
        .slice(0, MAX_MERGE_CHECKS)
        .map(([name, state]) => ({ name: clip(name, 256), state: clip(state, 64) }));
      const red = states.filter(([, state]) => state !== 'green');
      if (red.length)
        return no(
          `Required checks are not green on ${short(head)}: ${red.map(([name, state]) => `${name} (${state})`).join(', ')}.`,
        );
    }
    const passed = required.length
      ? `Required checks green on ${short(head)}: ${required.join(', ')}.`
      : `${base} requires no checks.`;
    switch (pull.mergeable_state) {
      case 'clean':
      case 'unstable':
      case 'has_hooks':
        return {
          reason: null,
          line: clip(`${passed} No review or rule GitHub enforces blocks it.`, 1000),
          checks,
          mergeState,
        };
      case 'blocked':
        return no(
          'Branch protection blocks this merge. Get the reviews or checks it asks for, then merge.',
        );
      case 'behind':
        return no(
          `The branch is behind ${base}, and protection wants it up to date. Update it, then merge.`,
        );
      case 'dirty':
        return no(`The branch conflicts with ${base}. Resolve the conflict, then merge.`);
      case 'draft':
        return no('The pull request is a draft. Mark it ready, then merge.');
      default:
        return no(
          'GitHub has not finished checking whether this can merge. Try again in a minute.',
        );
    }
  }

  /** Reads what the remote holds for one write. It sends nothing. */
  private async observe(effect: RemoteEffect): Promise<Seen> {
    const { target, request } = effect;
    const repo = endpoint('repos', target.repo.owner, target.repo.name);
    const pullPath = `${repo}${endpoint('pulls', String(target.pr))}`;
    const get = (path: string) => this.get(target.repo, githubApiArgv(target.repo, 'GET', path));
    const absent = (reason: string): Seen => ({ result: 'absent', reason });
    const applied = (created: Created | null = null): Seen => ({ result: 'applied', created });
    switch (request.kind) {
      case 'push': {
        // The push went to the push URL, so that is where it is read back.
        const root = this.root(effect.taskId);
        let url: string;
        try {
          if (!root) throw Error('missing');
          url = git(root, ['remote', 'get-url', '--push', request.remote]).toString('utf8').trim();
        } catch {
          return { unreadable: `${request.remote} is no longer a remote of the project.` };
        }
        const ran = await this.run(
          'git',
          ['ls-remote', url, `refs/heads/${target.branch}`],
          realpathSync(root),
          target.repo,
          READ_MS,
        );
        if (ran.kind !== 'exited' || ran.code !== 0)
          return {
            unreadable:
              (ran.kind === 'unlaunched' ? '' : lastLine(ran.stderr)) || 'git ls-remote failed.',
          };
        const sha = ran.stdout.trim().split(/\s+/)[0] ?? '';
        if (sha === request.commit) return applied();
        return absent(
          sha
            ? `${target.branch} on ${request.remote} holds ${short(sha)}, not the commit this write sent.`
            : `${target.branch} does not exist on ${request.remote}.`,
        );
      }
      case 'pr-open': {
        const head = encodeURIComponent(`${target.repo.owner}:${target.branch}`);
        const read = await get(`${repo}/pulls?head=${head}&state=all&per_page=30`);
        if (!read.ok) return { unreadable: read.reason };
        if (!Array.isArray(read.body))
          return { unreadable: 'GitHub answered in a form CrewKite cannot read.' };
        // An open pull request at the pushed head, or one GitHub opened after the person
        // confirmed that is still open or was merged. One closed without a merge is never
        // adopted, even when it is new: the thread could not go on with it. An older one from the
        // same branch name is not this write.
        const since = Date.parse(effect.confirmation?.at ?? '') - CLOCK_SKEW_MS;
        const found = read.body
          .map(object)
          .filter((pull): pull is Json => {
            const head = object(pull?.head);
            const live = pull?.state === 'open' || typeof pull?.merged_at === 'string';
            return (
              head?.ref === target.branch &&
              ((pull?.state === 'open' && head.sha === target.headSha) ||
                (live && Date.parse(String(pull?.created_at)) >= since))
            );
          })
          .map((pull) => pull.number)
          .filter((number): number is number => typeof number === 'number' && number > 0)
          .sort((left, right) => right - left)[0];
        return found
          ? applied({ pr: found })
          : absent(`No pull request from ${target.branch} exists.`);
      }
      case 'pr-update':
      case 'pr-ready':
      case 'pr-draft':
      case 'merge': {
        const read = await get(pullPath);
        const pull = read.ok ? object(read.body) : null;
        if (!read.ok || !pull)
          return {
            unreadable: read.ok ? 'GitHub answered in a form CrewKite cannot read.' : read.reason,
          };
        if (request.kind === 'merge') {
          const sha = pull.merge_commit_sha;
          return pull.merged === true &&
            object(pull.head)?.sha === request.expectedHead &&
            typeof sha === 'string' &&
            /^[a-f0-9]{40}$/.test(sha)
            ? applied({ sha })
            : absent(`Pull request #${target.pr} is not merged at ${short(request.expectedHead)}.`);
        }
        if (request.kind === 'pr-update') {
          const shows =
            (request.title === undefined || pull.title === request.title) &&
            (request.body === undefined || sameText(String(pull.body ?? ''), request.body));
          return shows
            ? applied()
            : absent(`The remote does not show it on pull request #${target.pr}.`);
        }
        return pull.draft === (request.kind === 'pr-draft')
          ? applied()
          : absent(`The remote does not show it on pull request #${target.pr}.`);
      }
      case 'review-reply': {
        const user = await get('/user');
        const login = user.ok ? object(user.body)?.login : null;
        if (typeof login !== 'string')
          return { unreadable: user.ok ? 'GitHub did not name your account.' : user.reason };
        const read = await this.get(
          target.repo,
          reviewCommentsArgv(target.repo, String(target.pr)).comments,
        );
        if (!read.ok) return { unreadable: read.reason };
        if (!Array.isArray(read.body))
          return { unreadable: 'GitHub answered in a form CrewKite cannot read.' };
        // Whole bodies are compared, so a reply longer than the thread shows still matches. The
        // comment it answers, the account and the text identify it; the time only rules out a
        // reply from long before.
        const since = Date.parse(effect.confirmation?.at ?? '') - CLOCK_SKEW_MS;
        const reply = read.body
          .map(object)
          .find(
            (comment) =>
              String(comment?.in_reply_to_id) === request.commentId &&
              object(comment?.user)?.login === login &&
              typeof comment?.body === 'string' &&
              sameText(comment.body, request.body) &&
              Date.parse(String(comment.created_at)) >= since,
          );
        const id = reply?.id;
        if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
          return applied({ id: String(id) });
        // Only the newest page was read, so a reply older than it may still be there.
        if (read.body.length >= MAX_REVIEW_COMMENTS)
          return {
            unreadable: `The newest ${MAX_REVIEW_COMMENTS} review comments do not hold the reply, and older ones were not read.`,
          };
        return absent('No reply with this text from your account is on the pull request.');
      }
      case 'rerun': {
        const read = await get(`${repo}${endpoint('actions', 'runs', request.runId)}`);
        const attempt = read.ok ? object(read.body)?.run_attempt : null;
        if (typeof attempt !== 'number')
          return { unreadable: read.ok ? 'GitHub did not name the attempt.' : read.reason };
        return attempt > request.attempt
          ? applied({ attempt })
          : absent(`Run ${request.runId} has no attempt after ${request.attempt}.`);
      }
    }
  }

  private async get(repo: GitHubRepository, argv: string[]): Promise<Read> {
    const ran = await this.run('gh', argv, this.folder(), repo, READ_MS);
    if (ran.kind === 'unlaunched')
      return { ok: false, reason: 'gh could not start.', missing: false };
    if (ran.kind === 'lost')
      return { ok: false, reason: 'gh did not finish the read.', missing: false };
    if (ran.code !== 0)
      return {
        ok: false,
        reason: clip(lastLine(ran.stderr) ?? 'gh could not read it.'),
        missing: /\(HTTP 404\)/.test(ran.stderr),
      };
    try {
      return { ok: true, body: JSON.parse(ran.stdout) };
    } catch {
      return {
        ok: false,
        reason: 'GitHub answered in a form CrewKite cannot read.',
        missing: false,
      };
    }
  }

  /**
   * Runs git or gh through the process owner. `sent` journals the write the moment before the
   * process starts. When no process was created the write was never sent.
   */
  private async run(
    tool: Tool,
    argv: string[],
    cwd: string,
    repo: GitHubRepository,
    deadlineMs: number,
    journal?: { sent: () => void; owned: (group: number) => void; ended: () => void },
  ): Promise<Ran> {
    // Close stops the processes it can see, so none starts after it.
    if (this.closed) return { kind: 'unlaunched' };
    let pin: { path: string; sha256: string };
    try {
      pin = this.pin(tool);
    } catch {
      return { kind: 'unlaunched' };
    }
    let intended = false;
    let unlaunched = false;
    let execution: OwnedProjectCommandExecution;
    try {
      execution = createOwnedProjectCommandRunner({ deadlineMs }).launch(
        {
          operationId: `remote-${randomUUID()}`,
          executable: pin.path,
          executableIdentity: 'verified-prelaunch-sha256',
          executableSha256: pin.sha256,
          argv,
          cwd,
          environment: {
            ...this.environment(),
            LANG: 'C',
            LC_ALL: 'C',
            NO_COLOR: '1',
            GH_HOST: repo.host,
            GH_PROMPT_DISABLED: '1',
            GH_PAGER: 'cat',
          },
          shell: false,
        },
        {
          intent: () => {
            journal?.sent();
            intended = true;
          },
          // The group is journaled before anything can block, so a restart finds it.
          owned: (group) => journal?.owned(group),
          quiescent: () => journal?.ended(),
          unlaunched: () => {
            unlaunched = true;
            journal?.ended();
          },
        },
      );
    } catch {
      // A launch that threw before its intent, or that created no process, sent nothing.
      return !intended || unlaunched ? { kind: 'unlaunched' } : { kind: 'lost', stderr: '' };
    }
    this.running.add(execution);
    const [stdout, stderr, terminal] = await Promise.allSettled([
      collectBounded(execution.stdout, OUTPUT_BYTES),
      collectBounded(redactGitHubOutput(execution.stderr), DIAGNOSTIC_BYTES),
      execution.terminal,
    ]);
    this.running.delete(execution);
    const said = stderr.status === 'fulfilled' ? stderr.value.bytes.toString('utf8') : '';
    if (unlaunched) return { kind: 'unlaunched' };
    if (
      terminal.status === 'rejected' ||
      !terminal.value.quiescent ||
      terminal.value.reason !== 'exit' ||
      terminal.value.code === null ||
      stdout.status === 'rejected' ||
      stdout.value.exceeded
    )
      return { kind: 'lost', stderr: said };
    return {
      kind: 'exited',
      code: terminal.value.code,
      stdout: stdout.value.bytes.toString('utf8'),
      stderr: said,
    };
  }

  private environment(): Record<string, string> {
    if (this.deps.environment) return { ...this.deps.environment };
    return {
      ...gitAndGhEnvironment(process.env),
      HOME: homedir(),
      PATH: this.searchPath().join(delimiter),
    };
  }

  /** A packaged app starts with a short PATH, so the Homebrew folders are searched as well. */
  private searchPath() {
    const path = this.deps.environment?.PATH ?? process.env.PATH ?? '';
    return [
      ...new Set([
        ...path.split(delimiter).filter(isAbsolute),
        ...(this.deps.environment ? [] : ['/opt/homebrew/bin', '/usr/local/bin']),
      ]),
    ];
  }

  private pin(tool: Tool) {
    for (const directory of this.searchPath()) {
      const candidate = join(directory, tool);
      try {
        accessSync(candidate, constants.X_OK);
      } catch {
        continue;
      }
      return executablePin(candidate);
    }
    throw Error(`${tool} is not installed.`);
  }

  /** gh runs here, with nothing of the project around it. */
  private folder() {
    const folder = join(this.deps.home, 'remote-effects');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    return realpathSync(folder);
  }

  private save(effect: RemoteEffect) {
    this.deps.store.transaction(() => this.put(effect));
  }

  /** Writes the record and tells the thread, inside the caller's transaction. */
  private put(effect: RemoteEffect) {
    this.deps.store.putRemoteEffect(effect, this.deps.now());
    const { id, kind, state, reason } = effect;
    this.deps.changed?.(effect.taskId, { id, kind, state, reason });
  }

  private answer(effect: RemoteEffect): CommandResult {
    const data = { kind: 'remote-effect' as const, effect, preview: remoteWritePreview(effect) };
    if (effect.state === 'refused')
      return {
        outcome: 'blocked',
        reason: 'remote-write-refused',
        next: effect.reason ?? 'The write was refused. Nothing was applied.',
        data,
      };
    if (effect.state === 'unknown' || effect.state === 'sent')
      return {
        outcome: 'blocked',
        reason: 'remote-result-unknown',
        next: `${effect.reason ? `${effect.reason} ` : ''}Reconcile it to read what the remote holds. CrewKite never sends it again on its own.`,
        data,
      };
    return { outcome: 'applied', data };
  }

  private task(taskId: string) {
    return this.deps.store.get<Task>('task', taskId);
  }

  private root(taskId: string) {
    const task = this.task(taskId);
    return task ? this.deps.projectPath(task.projectId) : undefined;
  }

  private thread(taskId: string): ChatThread | null {
    const row = this.deps.store.db
      .prepare('SELECT body FROM chat_threads WHERE task_id=?')
      .get(taskId);
    if (!row) return null;
    try {
      return ChatThreadSchema.parse(JSON.parse(row.body as string));
    } catch {
      return null;
    }
  }

  private remoteUrl(root: string, remote: string): string | null {
    try {
      return git(root, ['remote', 'get-url', remote]).toString('utf8').trim() || null;
    } catch {
      return null;
    }
  }

  /** Whether `repo` is what `remote` points at, or with no remote named, any project remote. */
  private remoteOf(root: string, repo: GitHubRepository, remote: string | null) {
    const urls = remote ? [this.remoteUrl(root, remote)] : this.remotes(root).map(({ url }) => url);
    return urls.some((url) => {
      const named = url ? this.readUrl(url) : null;
      return named?.kind === 'github' && sameRepository(named.repo, repo);
    });
  }

  /** Each configured remote and its fetch URL as written in the project's config. */
  private remotes(root: string): { name: string; url: string }[] {
    try {
      return git(root, ['config', '--get-regexp', '^remote\\..*\\.url$'])
        .toString('utf8')
        .split('\n')
        .flatMap((line) => {
          const [key = '', url] = line.split(' ');
          return url ? [{ name: key.slice('remote.'.length, -'.url'.length), url }] : [];
        });
    } catch {
      return [];
    }
  }

  /** Whether this thread pushed `commit` to `branch`, by the push journal or the thread's record. */
  private pushed(
    taskId: string,
    thread: ChatThread | null,
    branch: string | null,
    commit: string | null,
  ) {
    if (thread?.lastPush?.branch === branch && thread.lastPush.commit === commit) return true;
    return this.deps.store
      .remoteEffects(taskId)
      .some(
        (effect) =>
          effect.kind === 'push' &&
          effect.state === 'applied' &&
          effect.target.branch === branch &&
          effect.target.headSha === commit,
      );
  }

  /**
   * The pull request this thread opened, as a merge would name it: the newest one GitHub gave a
   * number, at the head the thread last pushed to its branch.
   */
  private pullRequestTarget(taskId: string): RemoteEffect['target'] | null {
    const opened = this.deps.store
      .remoteEffects(taskId)
      .findLast(
        (effect) =>
          effect.kind === 'pr-open' && effect.state === 'applied' && !!effect.observed?.created?.pr,
      );
    const pr = opened?.observed?.created?.pr;
    if (!opened || !pr) return null;
    const pushed = this.thread(taskId)?.lastPush;
    const headSha = pushed?.branch === opened.target.branch ? pushed.commit : opened.target.headSha;
    return { ...opened.target, pr, headSha };
  }

  /**
   * The pull request body built from the thread: the plan's goal, each slice with its outcome and
   * the turn that ran it, then the files the branch changes against its base.
   */
  private pullRequestBody(
    root: string,
    thread: ChatThread | null,
    target: Payload<'ProposeRemoteEffect'>['target'],
  ): string {
    const lines: string[] = [];
    const plan = thread?.plan;
    if (plan) {
      lines.push(plan.goal, '', 'Slices:');
      for (const slice of plan.slices)
        lines.push(
          `- ${slice.id}. ${slice.title}: ${slice.status}${slice.turnId ? `, turn ${slice.turnId}` : ''}`,
        );
      lines.push('');
    }
    const files = this.changedFiles(
      root,
      thread?.lastPush?.remote ?? 'origin',
      target.baseRef,
      target.headSha,
    );
    if (files) {
      lines.push(`Changed files (${files.length}):`);
      for (const file of files.slice(0, LISTED_FILES)) lines.push(`- ${file}`);
      if (files.length > LISTED_FILES) lines.push(`- and ${files.length - LISTED_FILES} more`);
    }
    return clipBytes(lines.join('\n').trim(), BODY_BYTES);
  }

  /** `path +added -deleted` for each file the head changes against the base it merges into. */
  private changedFiles(root: string, remote: string, baseRef: string | null, head: string | null) {
    if (!baseRef || !head) return null;
    for (const base of [`refs/remotes/${remote}/${baseRef}`, `refs/heads/${baseRef}`])
      try {
        return git(root, ['diff', '--numstat', '--no-renames', `${base}...${head}`])
          .toString('utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [added, deleted, ...path] = line.split('\t');
            return added === '-'
              ? `${path.join('\t')} (binary)`
              : `${path.join('\t')} +${added} -${deleted}`;
          });
      } catch {}
    return null;
  }
}
