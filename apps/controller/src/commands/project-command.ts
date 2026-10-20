import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const recipeNames = ['lint', 'test', 'build'] as const;
const environmentNames = new Set([
  'CI',
  'HOME',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
  'PATH',
  'TMPDIR',
  'TZ',
]);
const shellNames = new Set([
  'bash',
  'cmd',
  'cmd.exe',
  'dash',
  'fish',
  'ksh',
  'powershell',
  'pwsh',
  'sh',
  'zsh',
]);
const maximumArgumentBytes = 64 * 1024;
const maximumEnvironmentBytes = 16 * 1024;
export const PROJECT_COMMAND_CHUNK_BYTES = 64 * 1024;

export type ProjectCommandRecipeName = (typeof recipeNames)[number];
export type ProjectCommandDefinition = Readonly<{
  version: 1;
  operationId: string;
  recipe: ProjectCommandRecipeName;
  source: Readonly<{
    projectId: string;
    repositoryRoot: string;
    baseRevision: string;
  }>;
  scratchRoot: string;
  cwd: string;
  executable: string;
  executableSha256: string;
  argv: readonly string[];
  environment: Readonly<Record<string, string>>;
  output: Readonly<{
    stdout: 'artifact';
    stderr: 'artifact';
    chunkBytes: typeof PROJECT_COMMAND_CHUNK_BYTES;
  }>;
}>;

export type OwnedProjectCommandRequest = Readonly<{
  operationId: string;
  executable: string;
  executableSha256: string;
  argv: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  shell: false;
}>;
export type OwnedProjectCommandTerminal = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  quiescent: boolean;
  reason: 'exit' | 'stopped' | 'deadline' | 'launch' | 'ownership';
}>;
export type OwnedProjectCommandLifecycle = Readonly<{
  intent: (request: OwnedProjectCommandRequest) => void;
  owned: (group: number) => void;
  quiescent: (group: number) => void;
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
export type ProjectCommandArtifact = Readonly<{ hash: string; bytes: number }>;
export type ProjectCommandPublisher = (
  source: AsyncIterable<Uint8Array>,
  options?: { signal?: AbortSignal },
) => Promise<ProjectCommandArtifact>;
export type ProjectCommandResult = Readonly<{
  status: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  reason:
    | 'exit-zero'
    | 'nonzero-exit'
    | 'signal'
    | 'stopped'
    | 'deadline'
    | 'launch'
    | 'ownership'
    | 'output';
  code: number | null;
  signal: NodeJS.Signals | null;
  quiescent: boolean;
  stdout: ProjectCommandArtifact | null;
  stderr: ProjectCommandArtifact | null;
}>;
export type ProjectCommandOperation = Readonly<{
  result: Promise<ProjectCommandResult>;
  stop: () => void;
}>;

function canonicalDirectory(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw Error(`${label} must be absolute.`);
  const state = lstatSync(path);
  if (!state.isDirectory() || state.isSymbolicLink() || realpathSync(path) !== path)
    throw Error(`${label} must be a canonical directory.`);
  return path;
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function boundedText(value: unknown, label: string, maximum: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    Buffer.byteLength(value) > maximum
  )
    throw Error(`${label} is invalid.`);
}

function identifier(value: unknown, prefix: 'cmd' | 'prj', label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`).test(value)
  )
    throw Error(`${label} is invalid.`);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function hashExecutable(path: string): string {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > 256n * 1024n * 1024n)
      throw Error('Project command executable identity is invalid.');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(PROJECT_COMMAND_CHUNK_BYTES);
    let bytes = 0n;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      bytes += BigInt(count);
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      bytes !== before.size ||
      (['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'mtimeNs', 'ctimeNs'] as const).some(
        (key) => before[key] !== after[key],
      )
    )
      throw Error('Project command executable changed while reading.');
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

export function validateProjectCommandDefinition(value: unknown): ProjectCommandDefinition {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'version',
      'operationId',
      'recipe',
      'source',
      'scratchRoot',
      'cwd',
      'executable',
      'executableSha256',
      'argv',
      'environment',
      'output',
    ])
  )
    throw Error('Project command definition is invalid.');
  const command = value as ProjectCommandDefinition;
  if (command.version !== 1 || !recipeNames.includes(command.recipe))
    throw Error('Project command recipe is invalid.');
  if (
    !command.source ||
    typeof command.source !== 'object' ||
    Array.isArray(command.source) ||
    !exactKeys(command.source, ['projectId', 'repositoryRoot', 'baseRevision'])
  )
    throw Error('Project command source is invalid.');
  identifier(command.operationId, 'cmd', 'Project command operation');
  identifier(command.source.projectId, 'prj', 'Project command project');
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(command.source.baseRevision))
    throw Error('Project command source revision is invalid.');

  const repositoryRoot = canonicalDirectory(command.source.repositoryRoot, 'Repository root');
  const scratchRoot = canonicalDirectory(command.scratchRoot, 'Scratch root');
  const cwd = canonicalDirectory(command.cwd, 'Command working directory');
  if (inside(repositoryRoot, scratchRoot) || inside(scratchRoot, repositoryRoot))
    throw Error('Project command scratch must be separate from the source repository.');
  if (!inside(scratchRoot, cwd))
    throw Error('Project command working directory must stay inside scratch.');

  boundedText(command.executable, 'Project command executable', 4096);
  if (!isAbsolute(command.executable) || resolve(command.executable) !== command.executable)
    throw Error('Project command executable must be absolute.');
  const executable = lstatSync(command.executable);
  if (
    !executable.isFile() ||
    executable.isSymbolicLink() ||
    realpathSync(command.executable) !== command.executable ||
    (executable.mode & 0o111) === 0
  )
    throw Error('Project command executable identity is invalid.');
  if (
    !/^[a-f0-9]{64}$/.test(command.executableSha256) ||
    hashExecutable(command.executable) !== command.executableSha256
  )
    throw Error('Project command executable identity changed.');
  const executableName = command.executable
    .slice(command.executable.lastIndexOf('/') + 1)
    .toLowerCase();
  if (shellNames.has(executableName))
    throw Error('Project command recipes do not grant shell authority.');

  if (!Array.isArray(command.argv) || command.argv.length > 128)
    throw Error('Project command arguments are invalid.');
  let argumentBytes = 0;
  for (const argument of command.argv) {
    if (
      typeof argument !== 'string' ||
      argument.includes('\0') ||
      Buffer.byteLength(argument) > 8192
    )
      throw Error('Project command argument is invalid.');
    argumentBytes += Buffer.byteLength(argument);
  }
  if (argumentBytes > maximumArgumentBytes)
    throw Error('Project command arguments exceed their bound.');

  if (
    !command.environment ||
    typeof command.environment !== 'object' ||
    Array.isArray(command.environment)
  )
    throw Error('Project command environment is invalid.');
  const entries = Object.entries(command.environment);
  if (entries.length > environmentNames.size)
    throw Error('Project command environment exceeds its bound.');
  let environmentBytes = 0;
  for (const [name, environmentValue] of entries) {
    if (!environmentNames.has(name))
      throw Error('Project command environment variable is not allowed.');
    if (typeof environmentValue !== 'string' || environmentValue.includes('\0'))
      throw Error('Project command environment value is invalid.');
    environmentBytes += Buffer.byteLength(name) + Buffer.byteLength(environmentValue);
  }
  if (environmentBytes > maximumEnvironmentBytes)
    throw Error('Project command environment exceeds its bound.');
  if (
    !command.output ||
    typeof command.output !== 'object' ||
    Array.isArray(command.output) ||
    !exactKeys(command.output, ['stdout', 'stderr', 'chunkBytes']) ||
    command.output.stdout !== 'artifact' ||
    command.output.stderr !== 'artifact' ||
    command.output.chunkBytes !== PROJECT_COMMAND_CHUNK_BYTES
  )
    throw Error('Project command output definition is invalid.');
  return command;
}

function reasonFor(terminal: OwnedProjectCommandTerminal): ProjectCommandResult['reason'] {
  if (terminal.reason !== 'exit') return terminal.reason;
  if (terminal.signal !== null) return 'signal';
  return terminal.code === 0 ? 'exit-zero' : 'nonzero-exit';
}

export function startProjectCommand(
  definition: ProjectCommandDefinition,
  dependencies: Readonly<{
    runner: OwnedProjectCommandRunner;
    lifecycle: OwnedProjectCommandLifecycle;
    publishStream: ProjectCommandPublisher;
  }>,
): ProjectCommandOperation {
  const command = validateProjectCommandDefinition(definition);
  const request: OwnedProjectCommandRequest = {
    operationId: command.operationId,
    executable: command.executable,
    executableSha256: command.executableSha256,
    argv: [...command.argv],
    cwd: command.cwd,
    environment: { ...command.environment },
    shell: false,
  };
  const execution = dependencies.runner.launch(request, dependencies.lifecycle);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    execution.stop();
  };
  const publish = (source: AsyncIterable<Uint8Array>) =>
    dependencies.publishStream(source).catch((error: unknown) => {
      stop();
      throw error;
    });
  const stdout = publish(execution.stdout);
  const stderr = publish(execution.stderr);
  const result = (async (): Promise<ProjectCommandResult> => {
    const [terminal, stdoutResult, stderrResult] = await Promise.all([
      execution.terminal,
      stdout.then(
        (artifact) => ({ artifact, failed: false as const }),
        () => ({ artifact: null, failed: true as const }),
      ),
      stderr.then(
        (artifact) => ({ artifact, failed: false as const }),
        () => ({ artifact: null, failed: true as const }),
      ),
    ]);
    const outputFailed = stdoutResult.failed || stderrResult.failed;
    const reason = outputFailed ? 'output' : reasonFor(terminal);
    const status =
      !terminal.quiescent || terminal.reason === 'ownership'
        ? 'unknown'
        : outputFailed
          ? 'failed'
          : terminal.reason === 'stopped'
            ? 'cancelled'
            : terminal.reason === 'exit' && terminal.code === 0 && terminal.signal === null
              ? 'succeeded'
              : 'failed';
    return {
      status,
      reason,
      code: terminal.code,
      signal: terminal.signal,
      quiescent: terminal.quiescent,
      stdout: stdoutResult.artifact,
      stderr: stderrResult.artifact,
    };
  })();
  return { result, stop };
}
