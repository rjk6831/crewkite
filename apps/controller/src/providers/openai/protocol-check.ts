import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  accountReadParams,
  approvalReply,
  configReadParams,
  confirmSettings,
  features,
  initializeParams,
  type LaunchSettings,
  launchArguments,
  launchSettings,
  modelListParams,
  permissionsReply,
  READ_ONLY_SANDBOX,
  READ_PROFILE,
  rateLimitsParams,
  readProfileConfig,
  refusedShape,
  threadResumeParams,
  threadStartParams,
  turnInterruptParams,
  turnStartParams,
  writableSandbox,
} from './protocol.ts';

// The Codex section of scripts/protocol-check.mjs. It runs a published build with no account and
// no model call: deserialization happens before sign-in and thread lookup, so a request whose
// shape the build refuses comes back as "Invalid request", and an accepted shape sent against a
// thread that does not exist comes back as thread-not-found. The schema the build generates and
// the refusal strings compiled into it cover what the live replies do not.

export const name = 'Codex';
export const npmPackage = '@openai/codex';
// The npm package's script picks a native binary from a platform package beside it. CrewKite runs
// that binary, so the check does too, and scans it for removed fields.
export function executable(prefix: string) {
  const scope = join(prefix, 'node_modules', '@openai');
  for (const entry of readdirSync(scope).filter((name) => name.startsWith('codex-'))) {
    const vendor = join(scope, entry, 'vendor');
    for (const target of existsSync(vendor) ? readdirSync(vendor) : []) {
      const binary = join(vendor, target, 'bin', 'codex');
      if (existsSync(binary)) return binary;
    }
  }
  return join(prefix, 'node_modules', '.bin', 'codex');
}

export type Row = {
  request: string;
  shape: string;
  result: 'accepted' | 'refused' | 'warning';
  detail: string;
};
export type Validate = (schema: unknown, value: unknown) => string[];

// A thread id the build has never seen, in the format it expects.
const NO_THREAD = '00000000-0000-7000-8000-000000000000';
const MISSING_THREAD = /thread not found|no rollout found/i;

type Reply = { result?: unknown; error?: { code?: number; message?: string } };

function server(binary: string, settings: LaunchSettings, home: string, cwd: string) {
  const child: ChildProcessWithoutNullStreams = spawn(binary, launchArguments(settings), {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: join(home, 'codex'),
      LANG: 'C',
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const waiting = new Map<number, (reply: Reply) => void>();
  let next = 1;
  createInterface({ input: child.stdout }).on('line', (line) => {
    let value: { id?: number; method?: string } & Reply;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (value.method !== undefined && value.id !== undefined)
      child.stdin.write(
        `${JSON.stringify({ id: value.id, error: { code: -32601, message: 'no' } })}\n`,
      );
    else if (value.id !== undefined) waiting.get(value.id)?.(value);
  });
  const exited = new Promise<Reply>((resolve) =>
    child.once('close', (code) =>
      resolve({ error: { message: `the client exited with ${code}` } }),
    ),
  );
  return {
    call(method: string, params: unknown): Promise<Reply> {
      const id = next++;
      const answer = new Promise<Reply>((resolve) => waiting.set(id, resolve));
      const timeout = new Promise<Reply>((resolve) =>
        setTimeout(
          () => resolve({ error: { message: 'no answer within 20 seconds' } }),
          20_000,
        ).unref(),
      );
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      return Promise.race([answer, exited, timeout]);
    },
    notify(method: string) {
      child.stdin.write(`${JSON.stringify({ method })}\n`);
    },
    close() {
      child.stdin.end();
      child.kill('SIGTERM');
    },
  };
}

const said = (reply: Reply) => reply.error?.message?.replace(/\s+/g, ' ').slice(0, 200) ?? 'result';

/** A request sent against a missing thread: the shape passed when the thread lookup failed. */
function shapeRow(request: string, shape: string, reply: Reply): Row {
  const accepted = 'result' in reply || MISSING_THREAD.test(reply.error?.message ?? '');
  return { request, shape, result: accepted ? 'accepted' : 'refused', detail: said(reply) };
}

/** A request whose reply may be a refusal for a reason other than its shape, such as no sign-in. */
function optionalRow(request: string, shape: string, reply: Reply): Row {
  const refused = !('result' in reply) && (refusedShape(reply.error) || !reply.error?.code);
  return { request, shape, result: refused ? 'refused' : 'accepted', detail: said(reply) };
}

function confirmRow(shape: string, settings: LaunchSettings, reply: Reply): Row {
  if (!('result' in reply))
    return { request: 'config/read', shape, result: 'refused', detail: said(reply) };
  const { missing, different } = confirmSettings(settings, reply.result);
  return {
    request: 'config/read',
    shape,
    result: different.length ? 'refused' : missing.length ? 'warning' : 'accepted',
    detail:
      [
        ...different.map(({ key, value }) => `${key} is ${value}`),
        ...missing.map((key) => `${key} not reported`),
      ].join(', ') || 'every confirmed key matches',
  };
}

type Removed = { name: string; parent?: string; field: string; value?: string };

/**
 * What the build names as no longer supported: a field such as `permissionProfile`, a tagged
 * field such as readOnly.access, or a setting with a value such as approval_policy = "untrusted".
 * Compiled strings sit next to each other with no separator, so only the part next to the words
 * counts.
 */
function removedFields(binary: string): Removed[] {
  const needle = Buffer.from(' is no longer supported');
  const found = new Map<string, Removed>();
  const keep = (entry: Removed) => {
    const key = `${entry.parent ?? ''}.${entry.field}=${entry.value ?? ''}`;
    const known = found.get(key);
    if (!known || entry.name.length < known.name.length) found.set(key, entry);
  };
  const fd = openSync(realpathSync(binary), 'r');
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  let carry = Buffer.alloc(0);
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      const window = Buffer.concat([carry, chunk.subarray(0, read)]);
      for (let at = window.indexOf(needle); at >= 0; at = window.indexOf(needle, at + 1)) {
        const before = window.subarray(Math.max(0, at - 80), at).toString('latin1');
        const setting = /`?([a-z_][a-z0-9_]*) = "([^"]*)"`?$/.exec(before);
        const quoted = /`([A-Za-z_][A-Za-z0-9_]*)`$/.exec(before);
        const tagged = /([A-Za-z]+)\.([a-z][A-Za-z0-9]*)$/.exec(before);
        if (setting)
          keep({ name: `${setting[1]} = "${setting[2]}"`, field: setting[1], value: setting[2] });
        else if (quoted) keep({ name: quoted[1], field: quoted[1] });
        else if (tagged)
          keep({ name: `${tagged[1]}.${tagged[2]}`, parent: tagged[1], field: tagged[2] });
      }
      carry = window.subarray(Math.max(0, window.length - 128));
    }
  } finally {
    closeSync(fd);
  }
  // A name that only adds another string's tail in front of a shorter one is the same entry.
  const entries = [...found.values()];
  return entries
    .filter(
      (entry) =>
        !entries.some(
          (other) =>
            other !== entry &&
            other.value === entry.value &&
            other.name.length < entry.name.length &&
            entry.name.endsWith(other.name),
        ),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every key CrewKite sends as parent.key, where the parent is the enclosing key and, for a tagged
 * shape such as a sandbox policy, also its type.
 */
function sentKeys(value: unknown, parents: readonly string[], keys: Set<string>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return keys;
  const record = value as Record<string, unknown>;
  const tags = typeof record.type === 'string' ? [...parents, record.type] : parents;
  for (const [key, inner] of Object.entries(record)) {
    keys.add(`.${key}`);
    for (const parent of tags) keys.add(`${parent}.${key}`);
    sentKeys(inner, [key], keys);
  }
  return keys;
}

/** A removed name matches a sent key, or a launch setting with the value it names. */
function stillSent(removed: Removed, keys: Set<string>, settings: LaunchSettings[]) {
  if (removed.value !== undefined)
    return settings.some((launch) =>
      Object.entries(launch).some(
        ([key, value]) => removed.field.endsWith(key) && value === removed.value,
      ),
    );
  if (removed.parent === undefined) return keys.has(`.${removed.field}`);
  // The compiled string may carry another string's tail in front of the parent's name.
  const parent = removed.parent;
  return [...keys].some((key) => {
    const dot = key.lastIndexOf('.');
    return key.slice(dot + 1) === removed.field && dot > 0 && parent.endsWith(key.slice(0, dot));
  });
}

export async function check(context: { binary: string; work: string; validate: Validate }) {
  const { binary, work, validate } = context;
  const rows: Row[] = [];
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim();
  const codex = features(version);
  const home = join(work, 'home');
  const scratch = join(work, 'scratch');
  const logs = join(work, 'logs');
  for (const path of [home, join(home, 'codex'), scratch, logs])
    mkdirSync(path, { recursive: true });

  const sent: Array<{ method: string; shape: string; params: unknown }> = [];
  const send = async (
    client: ReturnType<typeof server>,
    method: string,
    shape: string,
    params: unknown,
  ) => {
    sent.push({ method, shape, params });
    return client.call(method, params);
  };

  // A read-only chat turn: its launch, its metadata reads and its thread under the profile.
  const readSettings = launchSettings(logs, { approvalPolicy: 'never', subagents: false });
  const reader = server(binary, readSettings, home, scratch);
  try {
    const hello = await send(reader, 'initialize', 'chat', initializeParams());
    rows.push(optionalRow('initialize', 'chat', hello));
    reader.notify('initialized');
    rows.push(
      optionalRow(
        'account/read',
        'chat',
        await send(reader, 'account/read', 'chat', accountReadParams()),
      ),
    );
    rows.push(
      optionalRow(
        'account/rateLimits/read',
        codex.rateLimitsParams ? 'with params' : 'no params',
        await send(reader, 'account/rateLimits/read', 'chat', rateLimitsParams(codex) ?? undefined),
      ),
    );
    rows.push(
      confirmRow(
        'read-only launch',
        readSettings,
        await send(reader, 'config/read', 'chat', configReadParams(scratch)),
      ),
    );
    rows.push(
      optionalRow(
        'model/list',
        'chat',
        await send(reader, 'model/list', 'chat', modelListParams(100, true)),
      ),
    );
    const settings = {
      model: 'probe',
      cwd: scratch,
      approvalPolicy: 'never' as const,
      developerInstructions: 'probe',
      config: readProfileConfig([scratch]),
    };
    const opened = await send(
      reader,
      'thread/start',
      'read-only',
      threadStartParams(settings, true),
    );
    const thread = opened.result as {
      activePermissionProfile?: { id?: string };
      sandbox?: { type?: string };
    } | null;
    const proven =
      thread?.activePermissionProfile?.id === READ_PROFILE && thread?.sandbox?.type === 'readOnly';
    rows.push({
      request: 'thread/start',
      shape: 'read-only profile',
      result: proven ? 'accepted' : 'refused',
      detail: opened.result
        ? `profile ${thread?.activePermissionProfile?.id ?? 'none'}, sandbox ${thread?.sandbox?.type ?? 'none'}`
        : said(opened),
    });
    rows.push(
      shapeRow(
        'thread/resume',
        'read-only profile',
        await send(
          reader,
          'thread/resume',
          'read-only',
          threadResumeParams(NO_THREAD, settings, codex),
        ),
      ),
    );
    const input = [{ type: 'text', text: 'probe' }];
    rows.push(
      shapeRow(
        'turn/start',
        'read-only profile',
        await send(
          reader,
          'turn/start',
          'read-only',
          turnStartParams({ threadId: NO_THREAD, input, effort: 'low' }),
        ),
      ),
    );
    rows.push(
      shapeRow(
        'turn/start',
        'read-only fallback',
        await send(
          reader,
          'turn/start',
          'fallback',
          turnStartParams({
            threadId: NO_THREAD,
            input,
            sandboxPolicy: READ_ONLY_SANDBOX,
            approvalPolicy: 'untrusted',
          }),
        ),
      ),
    );
    rows.push(
      shapeRow(
        'turn/interrupt',
        'chat',
        await send(reader, 'turn/interrupt', 'chat', turnInterruptParams(NO_THREAD, NO_THREAD)),
      ),
    );
    rows.push(
      shapeRow(
        'thread/name/set',
        'title',
        await send(reader, 'thread/name/set', 'title', { threadId: NO_THREAD, name: 'probe' }),
      ),
    );
  } finally {
    reader.close();
  }

  // A turn that edits, and the repository writer's turn shape.
  const writeSettings = launchSettings(logs, {
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    subagents: false,
  });
  const writer = server(binary, writeSettings, home, scratch);
  try {
    await writer.call('initialize', initializeParams());
    writer.notify('initialized');
    rows.push(
      confirmRow(
        'writer launch',
        writeSettings,
        await send(writer, 'config/read', 'writer', configReadParams(scratch)),
      ),
    );
    const opened = await send(
      writer,
      'thread/start',
      'writer',
      threadStartParams(
        { model: 'probe', cwd: scratch, approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
        true,
      ),
    );
    const sandbox = (opened.result as { sandbox?: { type?: string } } | null)?.sandbox?.type;
    rows.push({
      request: 'thread/start',
      shape: 'writer',
      result: sandbox === 'workspaceWrite' ? 'accepted' : 'refused',
      detail: opened.result ? `sandbox ${sandbox ?? 'none'}` : said(opened),
    });
    const input = [{ type: 'text', text: 'probe' }];
    rows.push(
      shapeRow(
        'turn/start',
        'writer',
        await send(
          writer,
          'turn/start',
          'writer',
          turnStartParams({ threadId: NO_THREAD, input, effort: 'low' }),
        ),
      ),
    );
    rows.push(
      shapeRow(
        'turn/start',
        'repository writer',
        await send(writer, 'turn/start', 'repository', {
          ...turnStartParams({ threadId: NO_THREAD, input }),
          sandboxPolicy: writableSandbox(scratch),
        }),
      ),
    );
  } finally {
    writer.close();
  }

  // Discovery keeps the read-only sandbox mode, which its own config/read check expects.
  const discoverySettings = launchSettings(logs, {
    approvalPolicy: 'on-request',
    sandboxMode: 'read-only',
    subagents: false,
  });
  const discovery = server(binary, discoverySettings, home, scratch);
  try {
    await discovery.call('initialize', initializeParams());
    discovery.notify('initialized');
    rows.push(
      confirmRow(
        'discovery launch',
        discoverySettings,
        await discovery.call('config/read', configReadParams(scratch)),
      ),
    );
  } finally {
    discovery.close();
  }

  // The schema the build generates, for every request above and both approval replies.
  const schemas = join(work, 'schema');
  const generated = spawnSync(binary, ['app-server', 'generate-json-schema', '--out', schemas], {
    encoding: 'utf8',
  });
  if (generated.status !== 0)
    rows.push({
      request: 'schema',
      shape: 'generate',
      result: 'warning',
      detail: 'the build did not generate its schema',
    });
  else {
    const requests = JSON.parse(readFileSync(join(schemas, 'ClientRequest.json'), 'utf8'));
    for (const { method, shape, params } of sent) {
      const variant = requests.oneOf?.find(
        (entry: { properties?: { method?: { enum?: string[] } } }) =>
          entry.properties?.method?.enum?.[0] === method,
      );
      const problems = variant
        ? validate(
            { ...variant.properties.params, definitions: requests.definitions },
            // A request with no params goes out without the key, which the client reads as null.
            params ?? null,
          )
        : ['the schema has no such method'];
      rows.push({
        request: method,
        shape: `${shape} schema`,
        result: problems.length ? 'refused' : 'accepted',
        detail: problems.join('; ') || 'matches the schema',
      });
    }
    for (const [file, reply] of [
      ['CommandExecutionRequestApprovalResponse.json', approvalReply('accept')],
      ['FileChangeRequestApprovalResponse.json', approvalReply('decline')],
      ['PermissionsRequestApprovalResponse.json', permissionsReply({ network: { enabled: true } })],
      ['PermissionsRequestApprovalResponse.json', permissionsReply(null)],
    ] as const) {
      const problems = validate(JSON.parse(readFileSync(join(schemas, file), 'utf8')), reply);
      rows.push({
        request: file.replace('Response.json', ' reply'),
        shape: JSON.stringify(reply).slice(0, 60),
        result: problems.length ? 'refused' : 'accepted',
        detail: problems.join('; ') || 'matches the schema',
      });
    }
  }

  // A removed field the build still names, against every key CrewKite sends.
  const keys = new Set<string>();
  for (const { params } of sent) sentKeys(params, [], keys);
  const launches = [readSettings, writeSettings, discoverySettings];
  for (const removed of removedFields(binary)) {
    const still = stillSent(removed, keys, launches);
    rows.push({
      request: 'removed field',
      shape: removed.name,
      result: still ? 'refused' : 'accepted',
      detail: still ? 'CrewKite still sends it' : 'CrewKite does not send it',
    });
  }
  return { version, rows };
}
