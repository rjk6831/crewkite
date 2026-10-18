import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { HashSchema, NativeTargetPathSchema } from '@crewkite/contracts';
import { z } from 'zod';
import { committedFiles, type FileContent } from './source.ts';
import { trustedBiome } from './toolchain.ts';

const MAX_FILES = 200;
const MAX_BINARY_BYTES = 512 * 1024 * 1024;
// shortcut: these are the languages Biome formats by default. Upgrade: read the set from its configuration.
const SUPPORTED = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.json',
  '.jsonc',
  '.css',
]);
const NO_NETWORK = '(version 1)(allow default)(deny network*)';

export const FormattingSchema = z.strictObject({
  version: z.literal(1),
  status: z.enum(['formatted', 'unchanged', 'skipped', 'failed']),
  reason: z.string().max(200).nullable(),
  formatter: z
    .strictObject({
      name: z.literal('biome'),
      version: z.string().min(1).max(100),
      sha256: HashSchema,
      configHash: HashSchema,
    })
    .nullable(),
  files: z
    .array(z.strictObject({ path: NativeTargetPathSchema, before: HashSchema, after: HashSchema }))
    .max(MAX_FILES),
});
export type Formatting = z.infer<typeof FormattingSchema>;
export type FormattingPlan = { receipt: Formatting; outputs: FileContent[] };

export const noFormatting = (
  status: 'skipped' | 'failed',
  reason: string,
  formatter: Formatting['formatter'] = null,
): FormattingPlan => ({
  receipt: { version: 1, status, reason, formatter, files: [] },
  outputs: [],
});

async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function content(path: string, mode: FileContent['mode'], bytes: Buffer): FileContent {
  return {
    path,
    mode,
    hash: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    content: bytes,
  };
}

// The formatter is the controller's own installed Biome with the committed base configuration.
// Nothing from the project tree runs, and the candidate cannot change the configuration it is
// formatted with. Formatting changes layout only, so the frozen check and the review still judge
// the formatted bytes. Any refusal here keeps the writer's bytes and says why.
export async function planFormatting(input: {
  runtime: string;
  project: string;
  base: string;
  files: readonly FileContent[];
  work: string;
  maximumBytes: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<FormattingPlan> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    return noFormatting('skipped', 'The trusted Biome build needs macOS arm64.');
  let biome: ReturnType<typeof trustedBiome>;
  try {
    biome = trustedBiome(input.runtime);
  } catch {
    return noFormatting('skipped', 'No Biome install was found in the controller runtime.');
  }
  const source = committedFiles(input.project, input.base);
  const original = new Map(source.map((file) => [file.path, file]));
  const configs = source.filter((file) => /(?:^|\/)biome\.jsonc?$/.test(file.path));
  const config = configs[0];
  if (configs.length !== 1 || (config.path !== 'biome.json' && config.path !== 'biome.jsonc'))
    return noFormatting('skipped', 'The committed source has no single root Biome configuration.');
  let declared: unknown;
  try {
    const manifest = JSON.parse(original.get('package.json')?.content.toString('utf8') ?? '');
    declared = { ...manifest.dependencies, ...manifest.devDependencies }['@biomejs/biome'];
  } catch {}
  if (declared !== biome.version)
    return noFormatting('skipped', 'The committed Biome version differs from the installed one.');
  const changed = input.files.filter(
    (file) => SUPPORTED.has(extname(file.path)) && original.get(file.path)?.hash !== file.hash,
  );
  if (!changed.length)
    return noFormatting('skipped', 'No changed file is one the formatter supports.');
  if (changed.length > MAX_FILES || changed.some((file) => file.bytes > input.maximumBytes))
    return noFormatting('skipped', 'The changed files exceed the formatting bounds.');

  const binary = join(input.runtime, biome.entrypoint);
  const state = lstatSync(binary);
  if (!state.isFile() || !(state.mode & 0o111) || state.size > MAX_BINARY_BYTES)
    return noFormatting('skipped', 'The installed Biome binary is not a bounded executable.');
  const formatter = {
    name: 'biome' as const,
    version: biome.version,
    sha256: await fileHash(binary),
    configHash: config.hash,
  };
  const timeout = input.timeoutMs ?? 10_000;
  let limit = false;
  mkdirSync(input.work, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(input.work, 'run-'));
  try {
    const tree = join(root, 'tree');
    for (const directory of [tree, join(root, 'home'), join(root, 'tmp')]) mkdirSync(directory);
    // Biome reads the base ignore file beside its configuration, so both sit with the files.
    for (const file of [config, original.get('.gitignore'), ...changed]) {
      if (!file) continue;
      mkdirSync(dirname(join(tree, file.path)), { recursive: true });
      writeFileSync(join(tree, file.path), file.content);
    }
    const run = await new Promise<{ status: number | null; signal: string | null; error?: Error }>(
      (resolve) => {
        const child = spawn(
          '/usr/bin/sandbox-exec',
          [
            '-p',
            NO_NETWORK,
            binary,
            'format',
            '--write',
            '--no-errors-on-unmatched',
            '--files-ignore-unknown=true',
            '--',
            ...changed.map((file) => file.path),
          ],
          {
            cwd: tree,
            env: {
              PATH: '/usr/bin:/bin',
              HOME: join(root, 'home'),
              TMPDIR: join(root, 'tmp'),
              LANG: 'C',
              LC_ALL: 'C',
              NO_COLOR: '1',
            },
            stdio: 'ignore',
          },
        );
        // The kill is the limit. Waiting for close keeps the work directory alive until Biome is gone.
        const timer = setTimeout(() => {
          limit = true;
          child.kill('SIGKILL');
        }, timeout);
        const stop = () => child.kill('SIGKILL');
        input.signal?.addEventListener('abort', stop, { once: true });
        if (input.signal?.aborted) stop();
        const done = (value: { status: number | null; signal: string | null; error?: Error }) => {
          clearTimeout(timer);
          input.signal?.removeEventListener('abort', stop);
          resolve(value);
        };
        child.once('error', (error) => done({ status: null, signal: null, error }));
        child.once('close', (status, signal) => done({ status, signal }));
      },
    );
    if (run.error) return noFormatting('failed', 'The formatter could not run.', formatter);
    if (limit)
      return noFormatting('failed', `Formatting passed its ${timeout} ms limit.`, formatter);
    if (input.signal?.aborted)
      return noFormatting('failed', 'Formatting was cancelled.', formatter);
    if (run.status !== 0)
      return noFormatting(
        'failed',
        `The formatter exited with ${run.status ?? run.signal}.`,
        formatter,
      );
    const outputs: FileContent[] = [];
    for (const file of changed) {
      const path = join(tree, file.path);
      if (!lstatSync(path).isFile())
        return noFormatting('failed', 'The formatter output is not a file.', formatter);
      const bytes = readFileSync(path);
      if (bytes.length > input.maximumBytes)
        return noFormatting('failed', 'The formatted file exceeds its bound.', formatter);
      if (!bytes.equals(file.content)) outputs.push(content(file.path, file.mode, bytes));
    }
    const before = new Map(changed.map((file) => [file.path, file.hash]));
    return {
      receipt: {
        version: 1,
        status: outputs.length ? 'formatted' : 'unchanged',
        reason: null,
        formatter,
        files: outputs.map((file) => ({
          path: file.path,
          before: before.get(file.path) as string,
          after: file.hash,
        })),
      },
      outputs,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function readExact(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Formatting target is not a file.');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function overwrite(path: string, original: FileContent, bytes: Buffer) {
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const state = fstatSync(fd);
    if (
      !state.isFile() ||
      state.nlink !== 1 ||
      state.mode & 0o6000 ||
      state.size !== original.bytes
    )
      throw new Error('Formatting target metadata changed.');
    const current = readFileSync(fd);
    if (createHash('sha256').update(current).digest('hex') !== original.hash)
      throw new Error('Formatting target bytes changed.');
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(fd, bytes, written, bytes.length - written, written);
      if (count === 0) throw new Error('Formatting write made no progress.');
      written += count;
    }
    ftruncateSync(fd, bytes.length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Returns what scratch holds afterwards, so the sealed candidate is always the bytes on disk.
export function applyFormatting(
  scratch: string,
  files: readonly FileContent[],
  outputs: readonly FileContent[],
): FileContent[] {
  const before = new Map(files.map((file) => [file.path, file]));
  return outputs.map((output) => {
    const original = before.get(output.path) as FileContent;
    const path = join(scratch, output.path);
    try {
      overwrite(path, original, output.content);
    } catch {}
    return content(output.path, original.mode, readExact(path));
  });
}
