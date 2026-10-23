import { execFileSync, spawn } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, matchesGlob, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ChatFileDiffSchema, ChatToolKind } from '@crewkite/contracts';
import { z } from 'zod';
import { groupAbsent } from '../host/worker.ts';

// The tools CrewKite runs itself for a model that has no agent loop of its own. Every result is
// bounded so a small context window survives a few calls, and the model is told the bounds.
// Paths stay inside the scratch copy; .git is off limits because the controller runs git there.

export const READ_LINES = 120;
export const SEARCH_HITS = 30;
export const RUN_SECONDS = 120;
export const RUN_TAIL_LINES = 60;
export const WRITE_BYTES = 64 * 1024;
const HIT_CHARS = 200;
const LINE_CHARS = 500;
const OUTPUT_BYTES = 64 * 1024;
const READ_BYTES = 8 * 1024 * 1024;
const SEARCH_FILE_BYTES = 1024 * 1024;
const WALK_FILES = 20_000;
const KILL_MS = 1000;

type FileDiff = z.output<typeof ChatFileDiffSchema>;
export type ToolContext = Readonly<{
  scratch: string;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** The person approved this call. `run` refuses without it. */
  permitted?: boolean;
  /** Called with the process group of a command as soon as it exists. */
  onGroup?: (group: number) => void;
  /** Live command output, as it arrives. */
  onOutput?: (chunk: string) => void;
}>;
export type ToolOutcome = Readonly<{
  kind: ChatToolKind;
  title: string;
  status: 'ok' | 'error';
  /** What the model sees. Bounded. */
  output: string;
  diff?: FileDiff;
  changedPath?: string;
}>;
export type PreparedTool = Readonly<{
  name: string;
  kind: ChatToolKind;
  title: string;
  /** Why the call cannot run, written for the model. Null when it can. */
  error: string | null;
  /** What a permission card shows: the command, or the diff an edit would make. */
  detail: string | null;
  execute(): Promise<ToolOutcome>;
}>;

const path = { type: 'string', description: 'Path relative to the project root.' };
/** Tool definitions in the OpenAI function format that local runtimes accept. */
export const LOCAL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_range',
      description: `Read lines start to end of a file, 1-based and inclusive. At most ${READ_LINES} lines per call. Returns numbered lines and the total line count.`,
      parameters: {
        type: 'object',
        properties: {
          path,
          start: { type: 'integer', minimum: 1 },
          end: { type: 'integer', minimum: 1 },
        },
        required: ['path', 'start', 'end'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description: `Search file contents with a regular expression, or as literal text when the pattern is not a valid expression. At most ${SEARCH_HITS} hits, each as path:line: text cut to ${HIT_CHARS} characters.`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          glob: {
            type: 'string',
            description: 'Optional file filter, such as src/**/*.ts or *.py.',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description:
        'Replace one exact occurrence of old with new in an existing file. old must appear exactly once, so include nearby lines to make it unique. Returns a diff with 3 lines of context.',
      parameters: {
        type: 'object',
        properties: { path, old: { type: 'string' }, new: { type: 'string' } },
        required: ['path', 'old', 'new'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: `Create a new file under ${WRITE_BYTES / 1024} KiB. Fails when the file exists; use edit for existing files.`,
      parameters: {
        type: 'object',
        properties: { path, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run',
      description: `Run a shell command in the project directory with a ${RUN_SECONDS} second limit. Returns the exit status and the last ${RUN_TAIL_LINES} lines of output. The person approves each command.`,
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
] as const;
export type LocalToolName = (typeof LOCAL_TOOLS)[number]['function']['name'];

// Small models send numbers as strings now and then. Coercion keeps those calls useful.
const line = z.coerce.number().int().min(1).max(10_000_000);
const ArgumentSchemas = {
  read_range: z.object({ path: z.string(), start: line, end: line }),
  search: z.object({ pattern: z.string().min(1).max(200), glob: z.string().max(200).optional() }),
  edit: z.object({ path: z.string(), old: z.string(), new: z.string() }),
  write: z.object({ path: z.string(), content: z.string() }),
  run: z.object({ command: z.string().min(1).max(4096) }),
};

class ToolError extends Error {}

/** Resolve a model-supplied path inside scratch. Rejects absolute paths, `..`, .git and escaping symlinks. */
export function scratchPath(scratch: string, value: string) {
  const parts = value.split(/[\\/]+/);
  if (
    !value ||
    value.length > 1024 ||
    value.includes('\0') ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.startsWith('~') ||
    parts.includes('..')
  )
    throw new ToolError(
      `${value} is outside the project. Use a path relative to the project root.`,
    );
  if (parts.includes('.git')) throw new ToolError('Paths inside .git are not available.');
  const root = realpathSync(scratch);
  const full = resolve(root, value);
  const outside = () => new ToolError(`${value} leads outside the project through a link.`);
  const inside = (path: string) => path === root || path.startsWith(root + sep);
  // Walk up to the nearest entry that exists without following links. A dangling link counts
  // as present here, so a write through it cannot land wherever the link points.
  let probe = full;
  for (;;) {
    const stat = lstatSync(probe, { throwIfNoEntry: false });
    if (stat) {
      if (stat.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(probe);
        } catch {
          throw outside();
        }
        if (!inside(target)) throw outside();
      }
      break;
    }
    probe = dirname(probe);
  }
  if (!inside(realpathSync(probe))) throw outside();
  return { full, relative: relative(root, full).split(sep).join('/') };
}

/** The longest prefix of `text` within `bytes` bytes. The decoder holds back a split character. */
export const fitBytes = (text: string, bytes: number) =>
  new StringDecoder('utf8').write(Buffer.from(text).subarray(0, Math.max(0, bytes)));

const bound = (text: string, bytes = OUTPUT_BYTES) =>
  Buffer.byteLength(text) <= bytes
    ? text
    : `${fitBytes(text, bytes - 64)}\n[output cut at ${bytes / 1024} KiB]`;

function readText(full: string, shown: string) {
  const stat = lstatSync(full, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new ToolError(`${shown} is not a file.`);
  if (stat.size > READ_BYTES) throw new ToolError(`${shown} is too large to read.`);
  const raw = readFileSync(full);
  const text = raw.toString('utf8');
  if (raw.subarray(0, 8000).includes(0) || !Buffer.from(text).equals(raw))
    throw new ToolError(`${shown} is not UTF-8 text.`);
  return text;
}

const lines = (text: string) => (text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/));

/** One hunk with `context` lines around the changed span. A single replacement makes one span. */
export function unifiedDiff(file: string, before: string, after: string, context = 3): FileDiff {
  const a = lines(before);
  const b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  const start = Math.max(0, head - context);
  const lead = a.slice(start, head);
  const trail = a.slice(a.length - tail, a.length - tail + context);
  const oldCount = lead.length + removed.length + trail.length;
  const newCount = lead.length + added.length + trail.length;
  const patch = [
    `--- ${before === '' ? '/dev/null' : `a/${file}`}`,
    `+++ b/${file}`,
    `@@ -${oldCount ? start + 1 : start},${oldCount} +${newCount ? start + 1 : start},${newCount} @@`,
    ...lead.map((value) => ` ${value}`),
    ...removed.map((value) => `-${value}`),
    ...added.map((value) => `+${value}`),
    ...trail.map((value) => ` ${value}`),
  ].join('\n');
  return {
    path: file,
    additions: added.length,
    deletions: removed.length,
    patch: patch.length < 262_144 ? `${patch}\n` : null,
  };
}

/** Files in scratch, without ignored ones when scratch is a Git checkout. Symlinks are skipped. */
export function listFiles(scratch: string, environment: NodeJS.ProcessEnv) {
  const root = realpathSync(scratch);
  let paths: string[];
  try {
    paths = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate'],
      {
        cwd: root,
        env: environment,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .slice(0, WALK_FILES);
  } catch {
    paths = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
        if (paths.length >= WALK_FILES) return;
        const child = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules')
          walk(child);
        else if (entry.isFile()) paths.push(child);
      }
    };
    walk('');
  }
  const files: { path: string; bytes: number }[] = [];
  for (const file of paths.sort()) {
    const stat = lstatSync(resolve(root, file), { throwIfNoEntry: false });
    if (stat?.isFile()) files.push({ path: file, bytes: stat.size });
  }
  return files;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// shortcut: model patterns run in-process. Nested quantifiers are refused and lines are tested
// up to 500 characters, which stops the usual catastrophic backtracking cases. Upgrade: run the
// search in a worker thread with a deadline.
const nestedQuantifier = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/;

function search(scratch: string, environment: NodeJS.ProcessEnv, pattern: string, glob?: string) {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    regex = new RegExp(escapeRegExp(pattern));
  }
  const root = realpathSync(scratch);
  const hits: string[] = [];
  let more = false;
  for (const file of listFiles(scratch, environment)) {
    if (file.bytes > SEARCH_FILE_BYTES || file.path.split('/').includes('.git')) continue;
    if (
      glob &&
      !matchesGlob(file.path, glob) &&
      !(!glob.includes('/') && matchesGlob(basename(file.path), glob))
    )
      continue;
    let text: string;
    try {
      text = readFileSync(resolve(root, file.path), 'utf8');
    } catch {
      continue;
    }
    if (text.slice(0, 8000).includes('\0')) continue;
    const rows = text.split(/\r?\n/);
    for (let index = 0; index < rows.length; index++) {
      if (!regex.test(rows[index].slice(0, LINE_CHARS))) continue;
      if (hits.length === SEARCH_HITS) {
        more = true;
        break;
      }
      hits.push(`${file.path}:${index + 1}: ${rows[index].trim()}`.slice(0, HIT_CHARS));
    }
    if (more) break;
  }
  if (!hits.length) return 'No matches.';
  return [
    ...hits,
    ...(more ? [`Showing the first ${SEARCH_HITS} hits. Narrow the pattern or add a glob.`] : []),
  ].join('\n');
}

function runCommand(command: string, context: ToolContext) {
  return new Promise<{ status: 'ok' | 'error'; output: string }>((settle) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: realpathSync(context.scratch),
      env: context.environment,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const group = child.pid ?? 0;
    if (group > 0) context.onGroup?.(group);
    let tail = '';
    let ending: string | null = null;
    let exit: string | null = null;
    let done = false;
    const send = (signal: NodeJS.Signals) => {
      if (group > 0 && !groupAbsent(group))
        try {
          process.kill(-group, signal);
        } catch {}
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(limit);
      context.signal?.removeEventListener('abort', abort);
      child.stdout.destroy();
      child.stderr.destroy();
      const shown = tail
        .split(/\r?\n/)
        .slice(-RUN_TAIL_LINES - 1)
        .join('\n')
        .trimEnd();
      const status = ending ?? exit ?? 'ended';
      settle({
        status: !ending && exit === 'exit 0' ? 'ok' : 'error',
        output: bound(shown ? `${status}\n${shown}` : status),
      });
    };
    // The group owns what the command started. Every end terminates the group and kills it a
    // second later if anything is left. A process that left the group can hold the pipes open,
    // so the call finishes two seconds after termination either way.
    const terminate = (reason: string | null) => {
      if (reason) ending ??= reason;
      send('SIGTERM');
      setTimeout(() => send('SIGKILL'), KILL_MS).unref();
      setTimeout(finish, 2 * KILL_MS).unref();
    };
    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      context.onOutput?.(text);
      tail = (tail + text).slice(-OUTPUT_BYTES);
    };
    const abort = () => terminate('stopped');
    const limit = setTimeout(
      () => terminate(`timed out after ${RUN_SECONDS} s`),
      RUN_SECONDS * 1000,
    );
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted) abort();
    child.once('exit', (code, signal) => {
      exit = code !== null ? `exit ${code}` : `ended by ${signal ?? 'a signal'}`;
      terminate(null);
    });
    child.once('error', (error) => {
      ending ??= `could not start: ${error.message}`;
      if (group <= 0) finish();
    });
    child.once('close', finish);
  });
}

const textOf = (value: unknown) => (typeof value === 'string' ? value : '');
function describe(name: string, args: Record<string, unknown>) {
  const target = textOf(args.path) || '(no path)';
  const [kind, title]: [ChatToolKind, string] =
    name === 'read_range'
      ? ['read', `Read ${target}:${String(args.start ?? '?')}-${String(args.end ?? '?')}`]
      : name === 'search'
        ? [
            'search',
            `Search ${JSON.stringify(textOf(args.pattern))}${args.glob ? ` in ${textOf(args.glob)}` : ''}`,
          ]
        : name === 'edit'
          ? ['edit', `Edit ${target}`]
          : name === 'write'
            ? ['edit', `Create ${target}`]
            : name === 'run'
              ? ['command', `Run ${textOf(args.command) || '(no command)'}`]
              : ['other', `Unknown tool ${name || '(no name)'}`];
  return { kind, title: title.slice(0, 1024) };
}

/** Check a call and plan it without side effects, so a permission card can show what it does. */
export function prepareTool(name: string, input: unknown, context: ToolContext): PreparedTool {
  const args =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const { kind, title } = describe(name, args);
  const failed = (error: string): PreparedTool => ({
    name,
    kind,
    title,
    error,
    detail: null,
    execute: async () => ({ kind, title, status: 'error', output: error }),
  });
  const ready = (detail: string | null, work: () => Promise<Omit<ToolOutcome, 'kind' | 'title'>>) =>
    ({
      name,
      kind,
      title,
      error: null,
      detail,
      execute: async () => {
        try {
          return { kind, title, ...(await work()) };
        } catch (error) {
          const output = error instanceof Error ? error.message : 'The tool failed.';
          return { kind, title, status: 'error', output } as const;
        }
      },
    }) satisfies PreparedTool;
  try {
    switch (name) {
      case 'read_range': {
        const call = ArgumentSchemas.read_range.parse(args);
        const file = scratchPath(context.scratch, call.path);
        return ready(null, async () => {
          const rows = lines(readText(file.full, file.relative));
          if (call.start > rows.length)
            throw new ToolError(`${file.relative} has ${rows.length} lines.`);
          const end = Math.min(
            Math.max(call.start, call.end),
            call.start + READ_LINES - 1,
            rows.length,
          );
          const shown = rows.slice(call.start - 1, end).map((row, index) => {
            const cut = row.length > LINE_CHARS ? `${row.slice(0, LINE_CHARS)} [line cut]` : row;
            return `${call.start + index}: ${cut}`;
          });
          const header = `${file.relative} lines ${call.start}-${end} of ${rows.length}`;
          return { status: 'ok', output: bound([header, ...shown].join('\n')) };
        });
      }
      case 'search': {
        const call = ArgumentSchemas.search.parse(args);
        if (nestedQuantifier.test(call.pattern))
          return failed('Patterns with nested repeats are not supported. Simplify the pattern.');
        return ready(null, async () => ({
          status: 'ok',
          output: search(context.scratch, context.environment, call.pattern, call.glob),
        }));
      }
      case 'edit': {
        const call = ArgumentSchemas.edit.parse(args);
        const file = scratchPath(context.scratch, call.path);
        const before = readText(file.full, file.relative);
        // Models write \n. A CRLF file only matches when the edit uses its line endings.
        const crlf = before.includes('\r\n');
        const old = crlf ? call.old.replace(/\r?\n/g, '\r\n') : call.old;
        const next = crlf ? call.new.replace(/\r?\n/g, '\r\n') : call.new;
        if (!old) return failed('old must not be empty.');
        const first = before.indexOf(old);
        if (first < 0)
          return failed(
            `old text was not found in ${file.relative}. Read the lines again and copy them exactly.`,
          );
        let count = 0;
        for (let at = first; at >= 0; at = before.indexOf(old, at + 1)) count++;
        if (count > 1)
          return failed(
            `old text appears ${count} times in ${file.relative}. Include nearby lines so it matches once.`,
          );
        const after = before.slice(0, first) + next + before.slice(first + old.length);
        const diff = unifiedDiff(file.relative, before, after);
        return ready(diff.patch, async () => {
          if (readText(file.full, file.relative) !== before)
            throw new ToolError(`${file.relative} changed before the edit ran. Read it again.`);
          writeFileSync(file.full, after);
          return {
            status: 'ok',
            output: bound(`Edited ${file.relative}.\n${diff.patch ?? ''}`),
            diff,
            changedPath: file.relative,
          };
        });
      }
      case 'write': {
        const call = ArgumentSchemas.write.parse(args);
        const file = scratchPath(context.scratch, call.path);
        if (lstatSync(file.full, { throwIfNoEntry: false }))
          return failed(`${file.relative} exists. Use edit to change it.`);
        if (Buffer.byteLength(call.content) >= WRITE_BYTES)
          return failed(`New files must be under ${WRITE_BYTES / 1024} KiB.`);
        const diff = unifiedDiff(file.relative, '', call.content);
        return ready(diff.patch, async () => {
          mkdirSync(dirname(file.full), { recursive: true });
          writeFileSync(file.full, call.content, { flag: 'wx' });
          return {
            status: 'ok',
            output: `Created ${file.relative} with ${diff.additions} lines.`,
            diff,
            changedPath: file.relative,
          };
        });
      }
      case 'run': {
        const call = ArgumentSchemas.run.parse(args);
        return ready(call.command, async () => {
          if (!context.permitted) throw new ToolError('Commands need the person to approve them.');
          return runCommand(call.command, context);
        });
      }
      default:
        return failed(
          `There is no tool named ${name}. Use ${LOCAL_TOOLS.map((tool) => tool.function.name).join(', ')}.`,
        );
    }
  } catch (error) {
    if (error instanceof z.ZodError)
      return failed(
        `The arguments for ${name} are invalid: ${error.issues.map((issue) => `${issue.path.join('.') || 'input'} ${issue.message}`).join('; ')}.`,
      );
    if (error instanceof ToolError) return failed(error.message);
    return failed(error instanceof Error ? error.message : 'The tool failed.');
  }
}

/** Check and run one call. `run` only runs when the context says the person approved it. */
export function runTool(name: string, input: unknown, context: ToolContext) {
  return prepareTool(name, input, context).execute();
}
