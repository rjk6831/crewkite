const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 8192;
const MAX_ARTIFACT_CHUNK_BYTES = 64 * 1024;

const secretMarkers = [
  'authorization:',
  'gh_token=',
  'github_token=',
  'actions_runtime_token=',
  'actions_id_token_request_token=',
  'github_pat_',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
].map((value) => Buffer.from(value));
const markerOverlap = Math.max(...secretMarkers.map((value) => value.length)) - 1;

export type GitHubRepository = Readonly<{ host: string; owner: string; name: string }>;
export type GitHubExecutable = Readonly<{
  path: string;
  sha256: string;
  cwd: string;
  environment: Readonly<Record<string, string>>;
}>;

type GitHubBinding = Readonly<{
  repository: GitHubRepository;
  headSha: string;
}>;

export type GitHubReadRequest =
  | (GitHubBinding & Readonly<{ kind: 'pull-request'; pullRequest: string }>)
  | (GitHubBinding & Readonly<{ kind: 'workflow-run'; runId: string; attempt: number }>)
  | (GitHubBinding & Readonly<{ kind: 'job-log'; runId: string; attempt: number; jobId: string }>);

export type OwnedProjectCommandRequest = Readonly<{
  operationId: string;
  executable: string;
  executableSha256: string;
  argv: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
}>;

export type OwnedProjectCommandLifecycle = Readonly<{
  intent: (request: OwnedProjectCommandRequest) => void;
  owned: (group: number) => void;
  quiescent: (group: number) => void;
}>;

export type OwnedProjectCommandTerminal = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  quiescent: boolean;
  reason: 'exit' | 'stopped' | 'deadline' | 'launch' | 'ownership';
}>;

export type OwnedProjectCommandExecution = Readonly<{
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  terminal: Promise<OwnedProjectCommandTerminal>;
  stop: () => void;
}>;

export type OwnedProjectCommandRunner = Readonly<{
  launch: (
    request: OwnedProjectCommandRequest,
    lifecycle: OwnedProjectCommandLifecycle,
  ) => OwnedProjectCommandExecution;
}>;

export type GitHubReadDependencies = Readonly<{
  runner: OwnedProjectCommandRunner;
  lifecycle: (phase: 'metadata' | 'content') => OwnedProjectCommandLifecycle;
  publishStream: (
    source: AsyncIterable<Uint8Array>,
    options?: { signal?: AbortSignal },
  ) => Promise<{ hash: string; bytes: number }>;
  now: () => string;
}>;

type GitHubSource = Readonly<{
  repository: GitHubRepository;
  headSha: string;
  executableSha256: string;
  fetchedAt: string;
}>;

type ReadFailure = Readonly<{
  state: 'unavailable' | 'cancelled' | 'unknown';
  reason:
    | 'binding-changed'
    | 'expired'
    | 'launch'
    | 'missing-authentication'
    | 'missing-scope'
    | 'output-limit'
    | 'stopped'
    | 'unavailable'
    | 'ownership';
  diagnostic: string | null;
  source: GitHubSource;
}>;

export type GitHubReadResult =
  | Readonly<{
      state: 'complete';
      kind: 'pull-request';
      source: GitHubSource;
      pullRequest: string;
      status: 'open' | 'draft' | 'closed' | 'merged';
      url: string;
    }>
  | Readonly<{
      state: 'complete';
      kind: 'workflow-run';
      source: GitHubSource;
      runId: string;
      attempt: number;
      status: 'pending' | 'passed' | 'failed' | 'cancelled' | 'neutral' | 'skipped';
      name: string;
      url: string;
    }>
  | Readonly<{
      state: 'complete';
      kind: 'job-log';
      source: GitHubSource;
      runId: string;
      attempt: number;
      jobId: string;
      jobStatus: 'pending' | 'passed' | 'failed' | 'cancelled' | 'neutral' | 'skipped';
      url: string;
      artifact: Readonly<{ hash: string; bytes: number }>;
      complete: true;
    }>
  | ReadFailure;

export type GitHubReadOperation = Readonly<{
  result: Promise<GitHubReadResult>;
  stop: () => void;
}>;

type JsonObject = Record<string, unknown>;
type BoundedRead = Readonly<{ bytes: Buffer; exceeded: boolean }>;

function validSegment(value: string) {
  return /^(?!\.{1,2}$)[a-zA-Z0-9_.-]{1,100}$/.test(value);
}

function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function validateRequest(
  operationId: string,
  client: GitHubExecutable,
  request: GitHubReadRequest,
) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(operationId))
    throw new Error('GitHub read operation identity is invalid.');
  if (
    !isAbsolute(client.path) ||
    !isAbsolute(client.cwd) ||
    hasControlCharacter(client.path) ||
    hasControlCharacter(client.cwd) ||
    !/^[a-f0-9]{64}$/.test(client.sha256)
  )
    throw new Error('GitHub executable identity is invalid.');
  if (
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(request.repository.host) ||
    !validSegment(request.repository.owner) ||
    !validSegment(request.repository.name) ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(request.headSha)
  )
    throw new Error('GitHub source binding is invalid.');
  if ('pullRequest' in request && !/^[1-9][0-9]{0,19}$/.test(request.pullRequest))
    throw new Error('GitHub pull request identity is invalid.');
  if ('runId' in request && !/^[1-9][0-9]{0,19}$/.test(request.runId))
    throw new Error('GitHub run identity is invalid.');
  if ('jobId' in request && !/^[1-9][0-9]{0,19}$/.test(request.jobId))
    throw new Error('GitHub job identity is invalid.');
  if ('attempt' in request && (!Number.isSafeInteger(request.attempt) || request.attempt < 1))
    throw new Error('GitHub run attempt is invalid.');
}

function clientEnvironment(client: GitHubExecutable, repository: GitHubRepository) {
  const allowed = new Set(['HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'PATH', 'LANG', 'LC_ALL']);
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(client.environment)) {
    if (!allowed.has(key) || !value || value.includes('\0'))
      throw new Error('GitHub client environment is invalid.');
    environment[key] = value;
  }
  return {
    ...environment,
    GH_HOST: repository.host,
    GH_PROMPT_DISABLED: '1',
    GH_PAGER: 'cat',
    NO_COLOR: '1',
  };
}

function endpoint(...parts: string[]) {
  return `/${parts.map((part) => encodeURIComponent(part)).join('/')}`;
}

function apiArgv(repository: GitHubRepository, path: string) {
  return [
    'api',
    '--method',
    'GET',
    '--hostname',
    repository.host,
    '--header',
    'Accept: application/vnd.github+json',
    '--header',
    'X-GitHub-Api-Version: 2022-11-28',
    path,
  ] as const;
}

function metadataPath(request: GitHubReadRequest) {
  const repository = endpoint('repos', request.repository.owner, request.repository.name);
  if (request.kind === 'pull-request')
    return `${repository}${endpoint('pulls', request.pullRequest)}`;
  if (request.kind === 'workflow-run')
    return `${repository}${endpoint(
      'actions',
      'runs',
      request.runId,
      'attempts',
      String(request.attempt),
    )}`;
  return `${repository}${endpoint('actions', 'jobs', request.jobId)}`;
}

function logPath(request: Extract<GitHubReadRequest, { kind: 'job-log' }>) {
  return `${endpoint(
    'repos',
    request.repository.owner,
    request.repository.name,
  )}${endpoint('actions', 'jobs', request.jobId, 'logs')}`;
}

function lowerAscii(bytes: Buffer) {
  const copy = Buffer.from(bytes);
  for (let index = 0; index < copy.length; index++) {
    const value = copy[index];
    if (value !== undefined && value >= 65 && value <= 90) copy[index] = value + 32;
  }
  return copy;
}

function firstMarker(bytes: Buffer) {
  const lower = lowerAscii(bytes);
  let first = -1;
  for (const marker of secretMarkers) {
    const index = lower.indexOf(marker);
    if (index >= 0 && (first < 0 || index < first)) first = index;
  }
  return first;
}

async function* boundedChunks(bytes: Buffer) {
  for (let offset = 0; offset < bytes.length; offset += MAX_ARTIFACT_CHUNK_BYTES)
    yield bytes.subarray(offset, offset + MAX_ARTIFACT_CHUNK_BYTES);
}

/** Sensitive markers redact the rest of their line, including matches split across chunks. */
export async function* redactGitHubOutput(source: AsyncIterable<Uint8Array>) {
  let pending = Buffer.alloc(0);
  let redacting = false;
  for await (const incoming of source) {
    let input = Buffer.concat([pending, Buffer.from(incoming)]);
    pending = Buffer.alloc(0);
    while (input.length) {
      if (redacting) {
        const newline = input.indexOf(10);
        if (newline < 0) break;
        yield Buffer.from('\n');
        redacting = false;
        input = input.subarray(newline + 1);
        continue;
      }
      const marker = firstMarker(input);
      const newline = input.indexOf(10);
      if (marker >= 0 && (newline < 0 || marker < newline)) {
        yield* boundedChunks(Buffer.concat([input.subarray(0, marker), Buffer.from('[REDACTED]')]));
        redacting = true;
        input = input.subarray(marker);
        continue;
      }
      if (newline >= 0) {
        yield* boundedChunks(input.subarray(0, newline + 1));
        input = input.subarray(newline + 1);
        continue;
      }
      if (input.length <= markerOverlap) pending = input;
      else {
        const boundary = input.length - markerOverlap;
        yield* boundedChunks(input.subarray(0, boundary));
        pending = input.subarray(boundary);
      }
      break;
    }
  }
  if (!redacting) yield* boundedChunks(pending);
}

async function collectBounded(
  source: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<BoundedRead> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let exceeded = false;
  for await (const chunk of source) {
    if (bytes >= limit) {
      exceeded = true;
      continue;
    }
    const value = Buffer.from(chunk);
    const remaining = limit - bytes;
    chunks.push(value.subarray(0, remaining));
    bytes += Math.min(value.length, remaining);
    if (value.length > remaining) exceeded = true;
  }
  return { bytes: Buffer.concat(chunks), exceeded };
}

function jsonObject(bytes: Buffer): JsonObject {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('GitHub response is invalid.');
  return value as JsonObject;
}

function string(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function numericId(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)) return value;
  return null;
}

function safeUrl(value: unknown, host: string) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === host ? value : null;
  } catch {
    return null;
  }
}

function remoteStatus(status: unknown, conclusion: unknown) {
  if (status !== 'completed') return 'pending' as const;
  if (conclusion === 'success') return 'passed' as const;
  if (conclusion === 'neutral') return 'neutral' as const;
  if (conclusion === 'skipped') return 'skipped' as const;
  if (conclusion === 'cancelled') return 'cancelled' as const;
  return 'failed' as const;
}

function diagnosticReason(text: string): ReadFailure['reason'] {
  const lower = text.toLowerCase();
  if (lower.includes('401') || lower.includes('authentication') || lower.includes('auth login'))
    return 'missing-authentication';
  if (lower.includes('403') || lower.includes('resource not accessible') || lower.includes('scope'))
    return 'missing-scope';
  if (lower.includes('410') || lower.includes('expired')) return 'expired';
  return 'unavailable';
}

function readFailure(
  state: ReadFailure['state'],
  reason: ReadFailure['reason'],
  diagnostic: Buffer | null,
  source: GitHubSource,
): ReadFailure {
  return {
    state,
    reason,
    diagnostic: diagnostic?.toString('utf8').trim().slice(0, MAX_DIAGNOSTIC_BYTES) || null,
    source,
  };
}

function phaseRequest(
  operationId: string,
  suffix: 'metadata' | 'content',
  client: GitHubExecutable,
  request: GitHubReadRequest,
  argv: readonly string[],
): OwnedProjectCommandRequest {
  return {
    operationId: `${operationId}-${suffix}`,
    executable: client.path,
    executableSha256: client.sha256,
    argv,
    cwd: client.cwd,
    environment: clientEnvironment(client, request.repository),
  };
}

export function startGitHubRead(
  operationId: string,
  client: GitHubExecutable,
  request: GitHubReadRequest,
  dependencies: GitHubReadDependencies,
): GitHubReadOperation {
  validateRequest(operationId, client, request);
  const controller = new AbortController();
  const active = new Set<OwnedProjectCommandExecution>();
  const stopped = new Set<OwnedProjectCommandExecution>();
  const source: GitHubSource = {
    repository: request.repository,
    headSha: request.headSha,
    executableSha256: client.sha256,
    fetchedAt: dependencies.now(),
  };
  if (!Number.isFinite(Date.parse(source.fetchedAt)))
    throw new Error('GitHub retrieval time is invalid.');
  const stopExecution = (execution: OwnedProjectCommandExecution) => {
    if (stopped.has(execution)) return;
    stopped.add(execution);
    execution.stop();
  };
  const stop = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    for (const execution of active) stopExecution(execution);
  };

  const launch = (phase: 'metadata' | 'content', argv: readonly string[]) => {
    if (controller.signal.aborted) return null;
    const execution = dependencies.runner.launch(
      phaseRequest(operationId, phase, client, request, argv),
      dependencies.lifecycle(phase),
    );
    active.add(execution);
    if (controller.signal.aborted) stopExecution(execution);
    return execution;
  };

  const result = (async (): Promise<GitHubReadResult> => {
    let metadata: OwnedProjectCommandExecution | null;
    try {
      metadata = launch('metadata', apiArgv(request.repository, metadataPath(request)));
    } catch {
      return readFailure('unavailable', 'launch', null, source);
    }
    if (!metadata) return readFailure('cancelled', 'stopped', null, source);
    const stopMetadataOnFailure = async <T>(work: Promise<T>) =>
      work.catch((error: unknown) => {
        stopExecution(metadata);
        throw error;
      });
    const [stdoutState, stderrState, terminalState] = await Promise.allSettled([
      stopMetadataOnFailure(collectBounded(metadata.stdout, MAX_METADATA_BYTES)),
      stopMetadataOnFailure(
        collectBounded(redactGitHubOutput(metadata.stderr), MAX_DIAGNOSTIC_BYTES),
      ),
      stopMetadataOnFailure(metadata.terminal),
    ]);
    active.delete(metadata);
    const stderr =
      stderrState.status === 'fulfilled'
        ? stderrState.value
        : { bytes: Buffer.alloc(0), exceeded: false };
    if (terminalState.status === 'rejected')
      return readFailure('unknown', 'ownership', stderr.bytes, source);
    const terminal = terminalState.value;
    if (!terminal.quiescent) return readFailure('unknown', 'ownership', stderr.bytes, source);
    if (stdoutState.status === 'rejected' || stderrState.status === 'rejected')
      return readFailure('unavailable', 'unavailable', stderr.bytes, source);
    const stdout = stdoutState.value;
    if (controller.signal.aborted) return readFailure('cancelled', 'stopped', stderr.bytes, source);
    if (stdout.exceeded || stderr.exceeded)
      return readFailure('unavailable', 'output-limit', stderr.bytes, source);
    if (terminal.reason !== 'exit' || terminal.code !== 0)
      return readFailure(
        'unavailable',
        terminal.reason === 'launch' ? 'launch' : diagnosticReason(stderr.bytes.toString('utf8')),
        stderr.bytes,
        source,
      );

    let body: JsonObject;
    try {
      body = jsonObject(stdout.bytes);
    } catch {
      return readFailure('unavailable', 'unavailable', null, source);
    }

    if (request.kind === 'pull-request') {
      const head = body.head;
      const actualHead =
        head && typeof head === 'object' && !Array.isArray(head)
          ? string((head as JsonObject).sha)
          : null;
      if (numericId(body.number) !== request.pullRequest || actualHead !== request.headSha)
        return readFailure('unavailable', 'binding-changed', null, source);
      const url = safeUrl(body.html_url, request.repository.host);
      if (!url || (body.state !== 'open' && body.state !== 'closed'))
        return readFailure('unavailable', 'unavailable', null, source);
      return {
        state: 'complete',
        kind: 'pull-request',
        source,
        pullRequest: request.pullRequest,
        status:
          typeof body.merged_at === 'string'
            ? 'merged'
            : body.draft === true
              ? 'draft'
              : body.state,
        url,
      };
    }

    if (request.kind === 'workflow-run') {
      if (
        numericId(body.id) !== request.runId ||
        body.run_attempt !== request.attempt ||
        body.head_sha !== request.headSha
      )
        return readFailure('unavailable', 'binding-changed', null, source);
      const url = safeUrl(body.html_url, request.repository.host);
      const name = string(body.name);
      if (!url || !name) return readFailure('unavailable', 'unavailable', null, source);
      return {
        state: 'complete',
        kind: 'workflow-run',
        source,
        runId: request.runId,
        attempt: request.attempt,
        status: remoteStatus(body.status, body.conclusion),
        name,
        url,
      };
    }

    if (
      numericId(body.id) !== request.jobId ||
      numericId(body.run_id) !== request.runId ||
      body.run_attempt !== request.attempt ||
      body.head_sha !== request.headSha
    ) {
      return readFailure('unavailable', 'binding-changed', null, source);
    }
    const jobUrl = safeUrl(body.html_url, request.repository.host);
    if (!jobUrl) return readFailure('unavailable', 'unavailable', null, source);

    let content: OwnedProjectCommandExecution | null;
    try {
      content = launch('content', apiArgv(request.repository, logPath(request)));
    } catch {
      return readFailure('unavailable', 'launch', null, source);
    }
    if (!content) return readFailure('cancelled', 'stopped', null, source);
    let published: { hash: string; bytes: number } | undefined;
    let publishFailed = false;
    const publication = Promise.resolve()
      .then(() =>
        dependencies.publishStream(redactGitHubOutput(content.stdout), {
          signal: controller.signal,
        }),
      )
      .then((value) => {
        published = value;
      })
      .catch(() => {
        publishFailed = true;
        if (content) stopExecution(content);
      });
    const stopContentOnFailure = async <T>(work: Promise<T>) =>
      work.catch((error: unknown) => {
        stopExecution(content);
        throw error;
      });
    const [contentStderrState, contentTerminalState, publicationState] = await Promise.allSettled([
      stopContentOnFailure(
        collectBounded(redactGitHubOutput(content.stderr), MAX_DIAGNOSTIC_BYTES),
      ),
      stopContentOnFailure(content.terminal),
      stopContentOnFailure(publication),
    ]);
    active.delete(content);
    const contentStderr =
      contentStderrState.status === 'fulfilled'
        ? contentStderrState.value
        : { bytes: Buffer.alloc(0), exceeded: false };
    if (contentTerminalState.status === 'rejected')
      return readFailure('unknown', 'ownership', contentStderr.bytes, source);
    const contentTerminal = contentTerminalState.value;
    if (!contentTerminal.quiescent)
      return readFailure('unknown', 'ownership', contentStderr.bytes, source);
    if (controller.signal.aborted)
      return readFailure('cancelled', 'stopped', contentStderr.bytes, source);
    if (
      publishFailed ||
      contentStderrState.status === 'rejected' ||
      publicationState.status === 'rejected'
    )
      return readFailure('unavailable', 'unavailable', contentStderr.bytes, source);
    if (contentStderr.exceeded)
      return readFailure('unavailable', 'output-limit', contentStderr.bytes, source);
    if (contentTerminal.reason !== 'exit' || contentTerminal.code !== 0 || !published)
      return readFailure(
        'unavailable',
        contentTerminal.reason === 'launch'
          ? 'launch'
          : diagnosticReason(contentStderr.bytes.toString('utf8')),
        contentStderr.bytes,
        source,
      );
    return {
      state: 'complete',
      kind: 'job-log',
      source,
      runId: request.runId,
      attempt: request.attempt,
      jobId: request.jobId,
      jobStatus: remoteStatus(body.status, body.conclusion),
      url: jobUrl,
      artifact: published,
      complete: true,
    };
  })();

  return { result, stop };
}

import { isAbsolute } from 'node:path';
