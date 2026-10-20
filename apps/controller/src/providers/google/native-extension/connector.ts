import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  type ControllerClient,
  connectController,
  createCommandKey,
  readControllerEndpoint,
} from '@crewkite/client/node';
import {
  type Artifact,
  ArtifactSchema,
  AttemptIdSchema,
  CandidateSchema,
  CommandSchema,
  canonicalJson,
  GoogleAcpSelectionSchema,
  HashSchema,
  RevisionSchema,
  RouteIdSchema,
  RunIdSchema,
  RunSchema,
  type Snapshot,
  TaskIdSchema,
  TaskSchema,
} from '@crewkite/contracts';
import { z } from 'zod';

export const MAX_CONTEXT_BYTES = 65536;
export const MAX_MESSAGE_BYTES = 131072;
const MAX_RESULT_BYTES = 32768;
const actor = { id: 'google-native-context', kind: 'cli' as const };
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const BindingSchema = z.strictObject({
  task: TaskSchema,
  run: RunSchema.pick({ id: true, revision: true, source: true }),
  candidate: CandidateSchema.nullable(),
  patch: ArtifactSchema.nullable(),
});
export const BundleSchema = z
  .strictObject({
    version: z.literal(1),
    workspace: z.string().min(1).max(4096),
    home: z.string().min(1).max(4096),
    expiresAt: z.iso.datetime(),
    binding: BindingSchema,
    patch: z.string().max(MAX_CONTEXT_BYTES),
  })
  .superRefine((value, context) => {
    if (
      Buffer.byteLength(canonicalJson(value.binding)) + Buffer.byteLength(value.patch) >
        MAX_CONTEXT_BYTES ||
      value.patch.includes('\0')
    )
      context.addIssue({
        code: 'custom',
        message: 'Task context exceeds the shared 64 KiB limit.',
      });
    if (
      value.binding.patch &&
      (Buffer.byteLength(value.patch) !== value.binding.patch.bytes ||
        hash(value.patch) !== value.binding.patch.hash)
    )
      context.addIssue({ code: 'custom', message: 'Retained patch identity does not match.' });
    if (!value.binding.patch && value.patch !== '')
      context.addIssue({
        code: 'custom',
        message: 'A patch requires its saved artifact identity.',
      });
    if (
      value.binding.task.runId !== value.binding.run.id ||
      value.binding.task.projectId !== value.binding.run.source.projectId ||
      (value.binding.candidate && value.binding.candidate.taskId !== value.binding.task.id)
    )
      context.addIssue({
        code: 'custom',
        message: 'The task, run and candidate lineage must match.',
      });
  });
export type Bundle = z.infer<typeof BundleSchema>;
export type CapturedContext = Pick<Bundle, 'binding' | 'patch'>;
export type ContextClient = Pick<ControllerClient, 'snapshot' | 'command'>;
export const OwnedContextOwnerSchema = z.strictObject({
  taskId: TaskIdSchema,
  runId: RunIdSchema,
  attemptId: AttemptIdSchema,
  generation: RevisionSchema,
  routeId: RouteIdSchema,
  policyHash: HashSchema,
  profileId: z.literal('google-acp-v1'),
  selection: GoogleAcpSelectionSchema,
});
export type OwnedContextOwner = z.infer<typeof OwnedContextOwnerSchema>;
export const OwnedBundleSchema = z
  .strictObject({
    version: z.literal(2),
    context: BundleSchema,
    directory: z.string().min(1).max(4096),
    nativeExpiresAt: z.iso.datetime(),
    owner: OwnedContextOwnerSchema,
  })
  .refine(
    (bundle) =>
      bundle.owner.taskId === bundle.context.binding.task.id &&
      bundle.owner.runId === bundle.context.binding.run.id &&
      Date.parse(bundle.context.expiresAt) <= Date.parse(bundle.nativeExpiresAt),
    'Owned context must match the frozen task, run and expiry.',
  );
export type OwnedBundle = z.infer<typeof OwnedBundleSchema>;

function selected(snapshot: Snapshot, taskId: string) {
  const task = snapshot.tasks.find((value) => value.id === taskId);
  const run = snapshot.runs.find((value) => value.id === task?.runId && value.taskId === taskId);
  if (!task || !run) throw new Error('Select a task with a saved run and source identity.');
  const candidate = snapshot.candidates.filter((value) => value.taskId === taskId).at(-1) ?? null;
  return { task, run: { id: run.id, revision: run.revision, source: run.source }, candidate };
}

async function request(
  client: ContextClient,
  command: 'GetChanges' | 'GetArtifact',
  payload: Record<string, unknown>,
) {
  const result = await client.command(
    CommandSchema.parse({ protocol: 1, key: createCommandKey(), actor, command, payload }),
  );
  if (result.outcome !== 'applied' && result.outcome !== 'already-applied')
    throw new Error('The selected task data is unavailable.');
  return result.data;
}

async function artifactBytes(client: ContextClient, artifact: Artifact) {
  if (artifact.bytes > MAX_CONTEXT_BYTES) throw new Error('The retained patch exceeds 64 KiB.');
  let offset = 0;
  const chunks: Buffer[] = [];
  do {
    const data = await request(client, 'GetArtifact', {
      artifactId: artifact.id,
      offset,
      limit: MAX_CONTEXT_BYTES,
    });
    if (
      data?.kind !== 'artifact' ||
      canonicalJson(data.artifact) !== canonicalJson(artifact) ||
      data.offset !== offset ||
      data.encoding !== 'base64'
    )
      throw new Error('The retained artifact identity changed.');
    const bytes = Buffer.from(data.content, 'base64');
    if (
      bytes.toString('base64') !== data.content ||
      bytes.length > MAX_CONTEXT_BYTES ||
      (!bytes.length && offset !== artifact.bytes)
    )
      throw new Error('The retained artifact chunk is invalid.');
    chunks.push(bytes);
    offset += bytes.length;
    if (offset > artifact.bytes || data.eof !== (offset === artifact.bytes))
      throw new Error('The retained artifact length changed.');
    if (data.eof) break;
  } while (offset < artifact.bytes);
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== artifact.bytes || hash(bytes) !== artifact.hash)
    throw new Error('The retained artifact checksum changed.');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes) || text.includes('\0'))
    throw new Error('The retained patch must be complete UTF-8 text.');
  return text;
}

export async function captureContext(
  client: ContextClient,
  taskId: string,
): Promise<CapturedContext> {
  const snapshot = await client.snapshot();
  const binding = { ...selected(snapshot, taskId), patch: null as Artifact | null };
  let patch = '';
  if (binding.candidate) {
    const data = await request(client, 'GetChanges', { taskId });
    if (
      data?.kind !== 'changes' ||
      data.taskId !== taskId ||
      data.candidateId !== binding.candidate.id ||
      data.truncated
    )
      throw new Error('The complete retained patch is unavailable.');
    const artifact = snapshot.artifacts.find((value) => value.id === data.artifactId);
    if (artifact?.mediaType !== 'text/x-patch')
      throw new Error('The retained patch artifact is unavailable.');
    binding.patch = artifact;
    patch = await artifactBytes(client, artifact);
    if (patch !== data.diff)
      throw new Error('The retained patch preview does not match its artifact.');
  }
  await current(client, binding);
  if (Buffer.byteLength(canonicalJson(binding)) + Buffer.byteLength(patch) > MAX_CONTEXT_BYTES)
    throw new Error('The task and retained patch exceed 64 KiB.');
  return { binding, patch };
}

async function current(client: ContextClient, binding: Bundle['binding']) {
  const snapshot = await client.snapshot();
  const actual = selected(snapshot, binding.task.id);
  if (
    canonicalJson(actual) !==
      canonicalJson({ task: binding.task, run: binding.run, candidate: binding.candidate }) ||
    (binding.patch &&
      !snapshot.artifacts.some((value) => canonicalJson(value) === canonicalJson(binding.patch)))
  )
    throw new Error('The task changed. Prepare a fresh workspace context.');
}

async function currentOwned(client: ContextClient, bundle: OwnedBundle) {
  const snapshot = await client.snapshot();
  const { owner, context } = bundle;
  const actual = selected(snapshot, owner.taskId);
  const run = snapshot.runs.find((value) => value.id === owner.runId);
  const attempt = snapshot.attempts.find((value) => value.id === owner.attemptId);
  const native = snapshot.nativeRuns.find((value) => value.runId === owner.runId);
  const taskContext = ({
    id,
    projectId,
    title,
    outcome,
    criteria,
    runId,
  }: Bundle['binding']['task']) => ({ id, projectId, title, outcome, criteria, runId });
  const approval = snapshot.approvals.some(
    (value) =>
      value.taskId === owner.taskId &&
      value.attemptId === owner.attemptId &&
      value.generation === owner.generation &&
      value.status === 'pending',
  );
  if (
    !run ||
    run.taskId !== owner.taskId ||
    canonicalJson(taskContext(actual.task)) !== canonicalJson(taskContext(context.binding.task)) ||
    canonicalJson(run.source) !== canonicalJson(context.binding.run.source) ||
    run.policy.hash !== owner.policyHash ||
    hash(canonicalJson(run.policy.policy)) !== owner.policyHash ||
    !attempt ||
    attempt.runId !== owner.runId ||
    attempt.routeId !== owner.routeId ||
    attempt.generation !== owner.generation ||
    !['intent', 'running'].includes(attempt.state) ||
    !(
      actual.task.state === 'running' ||
      (actual.task.state === 'waiting' && actual.task.waitingReason === 'approval' && approval)
    ) ||
    native?.profileId !== owner.profileId ||
    canonicalJson(native.acp) !== canonicalJson(owner.selection) ||
    native.expiresAt !== bundle.nativeExpiresAt ||
    canonicalJson(actual.candidate) !== canonicalJson(context.binding.candidate) ||
    (context.binding.patch &&
      !snapshot.artifacts.some(
        (value) => canonicalJson(value) === canonicalJson(context.binding.patch),
      ))
  )
    throw Error('The owned task context is no longer current.');
}

const contains = (parent: string, path: string) => {
  const part = relative(parent, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('../'));
};

function privateDirectory(path: string, home: string) {
  if (!isAbsolute(path) || !contains(home, path) || realpathSync(path) !== path)
    throw Error('Owned context needs canonical controller directories.');
  for (let current = path; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      throw Error('Owned context directories must remain private.');
    if (current === home) break;
  }
}

export async function prepareOwnedContext(input: {
  client: ContextClient;
  context: CapturedContext;
  home: string;
  scratch: string;
  directory: string;
  expiresAt: string;
  owner: OwnedContextOwner;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  privateDirectory(input.home, input.home);
  privateDirectory(input.scratch, input.home);
  privateDirectory(dirname(input.directory), input.home);
  if (
    !isAbsolute(input.directory) ||
    contains(input.scratch, input.directory) ||
    contains(input.directory, input.scratch)
  )
    throw Error('Owned connector state must stay outside scratch.');
  const snapshot = await input.client.snapshot();
  const native = snapshot.nativeRuns.find((value) => value.runId === input.owner.runId);
  const bundle = OwnedBundleSchema.parse({
    version: 2,
    context: {
      version: 1,
      ...input.context,
      home: input.home,
      workspace: input.scratch,
      expiresAt: input.expiresAt,
    },
    directory: join(realpathSync(dirname(input.directory)), basename(input.directory)),
    nativeExpiresAt: native?.expiresAt,
    owner: input.owner,
  });
  await currentOwned(input.client, bundle);
  if (now() >= Date.parse(bundle.context.expiresAt)) throw Error('Owned context expired.');
  mkdirSync(bundle.directory, { mode: 0o700 });
  privateDirectory(bundle.directory, input.home);
  const bytes = `${canonicalJson(bundle)}\n`;
  if (Buffer.byteLength(bytes) > MAX_MESSAGE_BYTES) throw Error('Owned context exceeds its bound.');
  const path = join(bundle.directory, 'capability.json');
  writePrivate(path, bytes);
  const sha256 = hash(bytes);
  return {
    server: {
      name: 'crewkite-context',
      command: realpathSync(process.execPath),
      args: [fileURLToPath(import.meta.url), '--owned-mcp', path, sha256],
      env: [] as { name: string; value: string }[],
    },
    capability: { path, sha256 },
  };
}

export function privateFile(path: string, maximum: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > maximum
    )
      throw new Error('Connector state must be a bounded private file.');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writePrivate(path: string, bytes: string) {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const versions = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MessageSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string().max(128), z.number().int().safe()]).optional(),
  method: z.string().min(1).max(128),
  params: z.record(z.string(), z.unknown()).optional(),
});
const ResultSchema = z.strictObject({
  text: z.string().min(1).max(MAX_RESULT_BYTES),
  conversationId: z.string().min(1).max(128).optional(),
});
const empty = { type: 'object', properties: {}, additionalProperties: false };
const tools = [
  {
    name: 'task_context',
    description:
      'Read the explicitly shared task context. This grants no execution or acceptance authority.',
    inputSchema: empty,
  },
  {
    name: 'retained_patch',
    description: 'Read the complete bounded retained patch, labelled unverified.',
    inputSchema: empty,
  },
  {
    name: 'submit_unverified_result',
    description:
      'Save one unverified result in this connector sidecar. It creates no CrewKite candidate or check evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: MAX_RESULT_BYTES },
        conversationId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description: 'Optional correlation only, never authentication.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

export function createSession(
  bundle: Bundle | OwnedBundle,
  options: { client: ContextClient; now: () => number; save: (text: string) => void },
) {
  const context = 'context' in bundle ? bundle.context : bundle;
  const availableTools =
    'context' in bundle
      ? tools.filter(
          (tool) =>
            tool.name !== 'task_context' &&
            (tool.name !== 'retained_patch' || context.binding.patch !== null),
        )
      : tools;
  let initialized = false,
    ready = false,
    closed = false,
    submitted = false;
  const seen = new Set<string | number>(),
    cancelled = new Set<string | number>();
  const live = () => {
    if (closed || options.now() >= Date.parse(context.expiresAt))
      throw new Error('Connector access ended. Native inference may still be running.');
  };
  const text = (value: unknown) => ({ content: [{ type: 'text', text: canonicalJson(value) }] });
  return {
    close() {
      closed = true;
    },
    cancel(id: string | number) {
      cancelled.add(id);
    },
    async receive(line: string): Promise<unknown | undefined> {
      let raw: unknown;
      try {
        if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) throw Error();
        raw = JSON.parse(line);
      } catch {
        return {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Invalid bounded JSON message.' },
        };
      }
      const parsed = MessageSchema.safeParse(raw);
      if (!parsed.success)
        return {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid JSON-RPC request.' },
        };
      const message = parsed.data;
      if (message.id === undefined) {
        if (message.method === 'notifications/initialized' && initialized) ready = true;
        if (message.method === 'notifications/cancelled') {
          const id = message.params?.requestId;
          if (typeof id === 'string' || typeof id === 'number') cancelled.add(id);
        }
        return;
      }
      const id = message.id;
      const error = (code: number, value: string) => ({
        jsonrpc: '2.0',
        id,
        error: { code, message: value },
      });
      if (seen.has(id) || seen.size >= 256)
        return error(-32600, 'Request IDs must be unique within this bounded session.');
      seen.add(id);
      try {
        live();
        if (message.method === 'initialize') {
          if (initialized || typeof message.params?.protocolVersion !== 'string')
            return error(-32602, 'Initialize once with a protocol version.');
          initialized = true;
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: versions.includes(message.params.protocolVersion)
                ? message.params.protocolVersion
                : versions[0],
              capabilities: { tools: {} },
              serverInfo: { name: 'crewkite-task-context', version: '0.1.0' },
              instructions:
                'context' in bundle
                  ? 'Only the shared task is available. Results are unverified. Use CrewKite for approvals and Stop.'
                  : 'Only the shared task is available. Results are unverified. Use the native app for model selection, approvals and Stop.',
            },
          };
        }
        if (!ready) return error(-32002, 'Complete initialization first.');
        if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
        if (message.method === 'tools/list')
          return { jsonrpc: '2.0', id, result: { tools: availableTools } };
        if (message.method !== 'tools/call') return error(-32601, 'Method is unavailable.');
        const call = z
          .strictObject({
            name: z.enum(['task_context', 'retained_patch', 'submit_unverified_result']),
            arguments: z.record(z.string(), z.unknown()).default({}),
            _meta: z.record(z.string(), z.unknown()).optional(),
          })
          .safeParse(message.params);
        if (!call.success) return error(-32602, 'Unknown tool or invalid parameters.');
        const { name, arguments: args } = call.data;
        if ('context' in bundle && name === 'task_context')
          return error(-32601, 'Method is unavailable.');
        const result =
          name === 'submit_unverified_result'
            ? ResultSchema.safeParse(args)
            : z.strictObject({}).safeParse(args);
        if (!result.success) return error(-32602, 'Tool arguments exceed the selected capability.');
        if ('context' in bundle) await currentOwned(options.client, bundle);
        else await current(options.client, context.binding);
        live();
        if (cancelled.has(id))
          return error(-32800, 'Request cancelled. Native inference may still be running.');
        let value: unknown;
        if (name === 'task_context') value = { status: 'UNVERIFIED CONTEXT', ...context.binding };
        else if (name === 'retained_patch')
          value = {
            status: 'UNVERIFIED RETAINED PATCH',
            artifact: context.binding.patch,
            patch: context.patch,
          };
        else {
          if (submitted) throw new Error('One unverified result has already been submitted.');
          const proposal = ResultSchema.parse(args);
          if (Buffer.byteLength(proposal.text) > MAX_RESULT_BYTES || proposal.text.includes('\0'))
            throw new Error('Result exceeds 32 KiB of NUL-free UTF-8 text.');
          options.save(
            `${canonicalJson({
              version: 1,
              status: 'UNVERIFIED',
              binding: context.binding,
              ...('context' in bundle ? { owner: bundle.owner } : {}),
              submittedAt: new Date(options.now()).toISOString(),
              text: proposal.text,
              textHash: hash(proposal.text),
              ...(proposal.conversationId
                ? { conversationId: proposal.conversationId, conversationIdentityVerified: false }
                : {}),
            })}\n`,
          );
          submitted = true;
          value = { status: 'UNVERIFIED', saved: true, controllerIngestion: false };
        }
        return { jsonrpc: '2.0', id, result: text(value) };
      } catch {
        if (message.method !== 'tools/call')
          return error(-32000, 'Connector access is unavailable.');
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            ...text({
              error:
                'The selected context is stale, expired, cancelled, unavailable or already used. Prepare a fresh context when needed. No CrewKite work was admitted.',
            }),
          },
        };
      }
    },
  };
}

export async function serve(
  input: Readable,
  output: Writable,
  session: ReturnType<typeof createSession>,
) {
  let pending = Buffer.alloc(0),
    chain = Promise.resolve(),
    ended = false,
    received = 0;
  input.on('data', (chunk: Buffer) => {
    if (ended) return;
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    if (pending.length > MAX_MESSAGE_BYTES && !pending.includes(10)) {
      ended = true;
      session.close();
      input.destroy();
      return;
    }
    for (;;) {
      const newline = pending.indexOf(10);
      if (newline === -1) break;
      const frame = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (
        ++received > 256 ||
        frame.length > MAX_MESSAGE_BYTES ||
        !Buffer.from(frame.toString('utf8')).equals(frame)
      ) {
        ended = true;
        session.close();
        input.destroy();
        return;
      }
      // Cancellation notifications must be visible while a local read is pending.
      try {
        const note = JSON.parse(frame.toString('utf8'));
        if (
          note?.method === 'notifications/cancelled' &&
          (typeof note.params?.requestId === 'string' || typeof note.params?.requestId === 'number')
        )
          session.cancel(note.params.requestId);
      } catch {
        /* The request parser returns the bounded protocol error. */
      }
      const line = frame.toString('utf8');
      chain = chain
        .then(async () => {
          if (ended) return;
          const response = await session.receive(line);
          if (!ended && response !== undefined) output.write(`${JSON.stringify(response)}\n`);
        })
        .catch(() => {
          ended = true;
          session.close();
          input.destroy();
        });
    }
    if (pending.length > MAX_MESSAGE_BYTES) {
      ended = true;
      session.close();
      input.destroy();
    }
  });
  output.once('error', () => {
    ended = true;
    session.close();
    input.destroy();
  });
  await new Promise<void>((resolve) => {
    input.once('end', resolve);
    input.once('close', resolve);
    input.once('error', resolve);
  });
  ended = true;
  session.close();
  await chain;
}

async function main() {
  const [flag, path, digest] = process.argv.slice(2);
  if (!['--mcp', '--owned-mcp'].includes(flag) || !path || !/^[a-f0-9]{64}$/.test(digest ?? ''))
    throw new Error('Supply the prepared capability path and checksum.');
  const bytes = privateFile(path, MAX_MESSAGE_BYTES);
  if (hash(bytes) !== digest) throw new Error('The prepared capability changed.');
  const bundle =
    flag === '--owned-mcp'
      ? OwnedBundleSchema.parse(JSON.parse(bytes.toString('utf8')))
      : BundleSchema.parse(JSON.parse(bytes.toString('utf8')));
  const context = 'context' in bundle ? bundle.context : bundle;
  if ('context' in bundle) {
    privateDirectory(context.home, context.home);
    privateDirectory(context.workspace, context.home);
    privateDirectory(bundle.directory, context.home);
    if (
      realpathSync(dirname(path)) !== bundle.directory ||
      contains(context.workspace, bundle.directory) ||
      contains(bundle.directory, context.workspace)
    )
      throw Error('Use the owned connector capability directory.');
  } else if (
    realpathSync(bundle.workspace) !== bundle.workspace ||
    realpathSync(dirname(path)) !== join(bundle.workspace, '.crewkite-context') ||
    realpathSync(process.cwd()) !== bundle.workspace
  )
    throw new Error('Use the explicitly prepared scratch workspace.');
  for (const directory of [context.workspace, dirname(path)]) {
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      throw new Error('The connector workspace must remain private.');
  }
  if (Date.now() >= Date.parse(context.expiresAt))
    throw new Error('The prepared capability expired.');
  writePrivate(
    join(dirname(path), 'session.json'),
    `${JSON.stringify({ status: 'connector-started', nativeInferenceStopped: false })}\n`,
  );
  const client = await connectController({
    ...readControllerEndpoint(context.home),
    actor,
    reconnectDelaysMs: [],
  });
  try {
    await serve(
      process.stdin,
      process.stdout,
      createSession(bundle, {
        client,
        now: Date.now,
        save: (text) => writePrivate(join(dirname(path), 'result.unverified.json'), text),
      }),
    );
  } finally {
    client.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch(() => {
    process.stderr.write('The prepared connector is unavailable. Prepare a fresh task context.\n');
    process.exitCode = 1;
  });
