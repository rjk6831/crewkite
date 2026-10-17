import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, readlink, realpath, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

export type CopyBudget = {
  deadline: number;
  now: () => number;
  maximumEntries: number;
  maximumBytes: number;
  signal?: AbortSignal;
};
type FileEntry = Readonly<{
  path: string;
  kind: 'file';
  mode: number;
  bytes: number;
  hash: string;
}>;
export type TreeEntry =
  | FileEntry
  | Readonly<{ path: string; kind: 'directory'; mode: number }>
  | Readonly<{ path: string; kind: 'link'; target: string; resolved: string }>;
export type TreeInventory = Readonly<{
  version: 1;
  entries: readonly TreeEntry[];
  files: number;
  bytes: number;
  hash: string;
}>;
export type DependencyInventory = Readonly<{
  version: 1;
  workspaces: readonly string[];
  projectFiles: readonly FileEntry[];
  buildDependencies: readonly Readonly<{ name: string; version: string; manifest: string }>[];
  tree: TreeInventory;
  hash: string;
}>;

const chunkBytes = 256 * 1024;
const excluded = new Set(['.pnpm-store', '.pnpm-cache', '.pnpm-state']);
async function digest(records: Iterable<unknown>, budget: CopyBudget) {
  const hash = createHash('sha256');
  let count = 0;
  for (const record of records) {
    check(budget);
    hash.update(`${JSON.stringify(record)}\n`);
    if (++count % 64 === 0) await setImmediate();
  }
  check(budget);
  return hash.digest('hex');
}
const same = (actual: unknown, expected: unknown) => {
  if (!isDeepStrictEqual(actual, expected)) throw new Error('Toolchain identity changed.');
};
function check(budget: CopyBudget) {
  if (
    !Number.isFinite(budget.deadline) ||
    !Number.isSafeInteger(budget.maximumEntries) ||
    budget.maximumEntries < 1 ||
    !Number.isSafeInteger(budget.maximumBytes) ||
    budget.maximumBytes < 0 ||
    budget.signal?.aborted ||
    budget.now() >= budget.deadline
  )
    throw new Error('Toolchain copy cancelled or bounded deadline/limits exceeded.');
}
function inside(root: string, path: string) {
  const result = relative(root, path);
  if (result === '..' || result.startsWith(`..${sep}`) || isAbsolute(result))
    throw new Error('Toolchain path escapes its root.');
  return result || '.';
}
function roots(workspaces: readonly string[]) {
  if (
    new Set(workspaces).size !== workspaces.length ||
    workspaces.some(
      (path) =>
        !path ||
        isAbsolute(path) ||
        path
          .split('/')
          .some((part) => !part || part === '.' || part === '..' || part === 'node_modules') ||
        /[\\\p{Cc}]/u.test(path),
    )
  )
    throw new Error('Invalid toolchain workspace paths.');
  return ['node_modules', ...workspaces.map((path) => `${path}/node_modules`)];
}
async function file(root: string, path: string, budget: CopyBudget): Promise<FileEntry> {
  check(budget);
  inside(root, await realpath(join(root, path)));
  if (!(await lstat(join(root, path))).isFile())
    throw new Error('Toolchain requires regular files.');
  const handle = await open(
    join(root, path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    inside(root, await realpath(join(root, path)));
    const before = await handle.stat();
    if (!before.isFile() || before.size > budget.maximumBytes)
      throw new Error('Toolchain requires bounded regular files.');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(chunkBytes);
    let bytes = 0;
    while (true) {
      check(budget);
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > before.size) throw new Error('Toolchain file changed while reading.');
      hash.update(buffer.subarray(0, read.bytesRead));
      await setImmediate();
    }
    const after = await handle.stat();
    if (
      bytes !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('Toolchain file changed while reading.');
    check(budget);
    return Object.freeze({
      path,
      kind: 'file',
      mode: before.mode & 0o7777,
      bytes,
      hash: hash.digest('hex'),
    });
  } finally {
    await handle.close();
  }
}
async function scan(
  root: string,
  paths: readonly string[],
  budget: CopyBudget,
  workspaces?: readonly string[],
): Promise<TreeInventory> {
  const entries: TreeEntry[] = [];
  let bytes = 0;
  let files = 0;
  async function visit(path: string) {
    check(budget);
    if (workspaces && path.startsWith('node_modules/') && excluded.has(basename(path))) return;
    if (entries.length >= budget.maximumEntries) throw new Error('Toolchain entry limit exceeded.');
    const absolute = join(root, path);
    const state = await lstat(absolute);
    if (workspaces && path === 'node_modules/.pnpm-task-run-state-v1' && state.isDirectory())
      return;
    if (state.isSymbolicLink()) {
      const target = await readlink(absolute);
      if (isAbsolute(target)) throw new Error('Toolchain links must be relative.');
      const destination = inside(root, await realpath(absolute));
      if (
        workspaces &&
        !paths.some((base) => destination === base || destination.startsWith(`${base}/`)) &&
        !workspaces.includes(destination)
      )
        throw new Error('Toolchain link is not a dependency or declared workspace alias.');
      entries.push(Object.freeze({ path, kind: 'link', target, resolved: destination }));
    } else if (state.isDirectory()) {
      inside(root, await realpath(absolute));
      entries.push(Object.freeze({ path, kind: 'directory', mode: state.mode & 0o7777 }));
      const directory = await opendir(absolute);
      for await (const entry of directory)
        await visit(path === '.' ? entry.name : `${path}/${entry.name}`);
    } else if (state.isFile()) {
      const entry = await file(root, path, {
        ...budget,
        maximumBytes: budget.maximumBytes - bytes,
      });
      bytes += entry.bytes;
      files++;
      entries.push(entry);
    } else throw new Error('Unsupported toolchain file type.');
    check(budget);
    await setImmediate();
  }
  for (const path of paths) await visit(path);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const result = { version: 1 as const, entries: Object.freeze(entries), files, bytes };
  check(budget);
  return Object.freeze({
    ...result,
    hash: await digest([{ version: 1, files, bytes }, ...entries], budget),
  });
}

export async function inventoryTree(root: string, budget: CopyBudget): Promise<TreeInventory> {
  check(budget);
  return scan(await realpath(root), ['.'], budget);
}

export async function inspectInstalledDependencies(
  root: string,
  workspaces: readonly string[],
  budget: CopyBudget,
): Promise<DependencyInventory> {
  check(budget);
  root = await realpath(root);
  if (workspaces.length > budget.maximumEntries) throw new Error('Toolchain entry limit exceeded.');
  const paths = roots(workspaces);
  const projectFiles: FileEntry[] = [];
  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.npmrc',
    ...workspaces.map((path) => `${path}/package.json`),
  ])
    projectFiles.push(await file(root, path, budget));
  const buildDependencies: { name: string; version: string; manifest: string }[] = [];
  const manifests: FileEntry[] = [];
  for (const workspace of ['.', ...workspaces]) {
    const read = await text(root, join(workspace, 'package.json'), budget);
    const manifest = JSON.parse(read.value);
    manifests.push(read.entry);
    for (const [name, version] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      if (version === 'workspace:*') continue;
      if (typeof version !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name))
        throw new Error('Invalid installed dependency identity.');
      const path = inside(
        root,
        await realpath(join(root, workspace, 'node_modules', name, 'package.json')),
      );
      const read = await text(root, path, budget);
      const installed = JSON.parse(read.value);
      manifests.push(read.entry);
      if (installed.name !== name || installed.version !== version)
        throw new Error(`Installed dependency identity changed: ${name}.`);
      buildDependencies.push(Object.freeze({ name, version, manifest: read.entry.hash }));
    }
  }
  const result = {
    version: 1 as const,
    workspaces: Object.freeze([...workspaces]),
    projectFiles: Object.freeze(projectFiles),
    buildDependencies: Object.freeze(buildDependencies),
    tree: await scan(root, paths, budget, workspaces),
  };
  // Metadata reads must describe the same files as the final dependency inventory.
  for (const entry of [...projectFiles, ...manifests])
    same(await file(root, entry.path, budget), entry);
  return Object.freeze({
    ...result,
    hash: await digest(
      [
        { version: 1, workspaces: result.workspaces },
        ...projectFiles,
        ...buildDependencies,
        { tree: result.tree.hash },
      ],
      budget,
    ),
  });
}
async function text(root: string, path: string, budget: CopyBudget) {
  const entry = await file(root, path, {
    ...budget,
    maximumBytes: Math.min(budget.maximumBytes, 1024 * 1024),
  });
  const handle = await open(
    join(root, path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    inside(root, await realpath(join(root, path)));
    if (!(await handle.stat()).isFile()) throw new Error('Toolchain requires regular files.');
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      check(budget);
      const chunk = Buffer.allocUnsafe(chunkBytes);
      const read = await handle.read(chunk, 0, chunk.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > entry.bytes) throw new Error('Toolchain manifest changed while reading.');
      chunks.push(chunk.subarray(0, read.bytesRead));
      await setImmediate();
    }
    const value = Buffer.concat(chunks);
    check(budget);
    if (createHash('sha256').update(value).digest('hex') !== entry.hash)
      throw new Error('Toolchain manifest changed while reading.');
    return { value: value.toString('utf8'), entry };
  } finally {
    await handle.close();
  }
}

export async function copyInstalledDependencies(
  donor: string,
  candidate: string,
  expected: DependencyInventory,
  budget: CopyBudget,
): Promise<DependencyInventory> {
  check(budget);
  donor = await realpath(donor);
  candidate = await realpath(candidate);
  const paths = roots(expected.workspaces);
  const contains = (root: string, path: string) => {
    const child = relative(root, path);
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
  };
  if (
    donor === candidate ||
    paths.some(
      (path) => contains(join(donor, path), candidate) || contains(join(candidate, path), donor),
    )
  )
    throw new Error('Toolchain copy roots overlap dependency trees.');
  const pinned = await inspectInstalledDependencies(donor, expected.workspaces, budget);
  same(
    { ...pinned, projectFiles: [], buildDependencies: [], tree: { ...pinned.tree, entries: [] } },
    {
      ...expected,
      projectFiles: [],
      buildDependencies: [],
      tree: { ...expected.tree, entries: [] },
    },
  );
  for (const [actual, saved] of [
    [pinned.projectFiles, expected.projectFiles],
    [pinned.buildDependencies, expected.buildDependencies],
    [pinned.tree.entries, expected.tree.entries],
  ] as const) {
    same(actual.length, saved.length);
    for (let index = 0; index < actual.length; index++) {
      check(budget);
      same(actual[index], saved[index]);
      if (index % 64 === 0) await setImmediate();
    }
  }
  expected = pinned;
  for (const entry of expected.projectFiles) same(await file(candidate, entry.path, budget), entry);
  // Exclusive roots prevent a partial copy from being reused after refusal.
  for (const path of paths) {
    check(budget);
    inside(candidate, await realpath(dirname(join(candidate, path))));
    await mkdir(join(candidate, path));
  }
  for (const entry of expected.tree.entries) {
    check(budget);
    const destination = join(candidate, entry.path);
    inside(candidate, await realpath(dirname(destination)));
    if (entry.kind === 'directory') {
      if (!paths.includes(entry.path)) await mkdir(destination);
    } else if (entry.kind === 'link') {
      await symlink(entry.target, destination);
    } else {
      const input = await open(
        join(donor, entry.path),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        inside(donor, await realpath(join(donor, entry.path)));
        if (!(await input.stat()).isFile()) throw new Error('Toolchain requires regular files.');
        const output = await open(destination, 'wx', entry.mode);
        try {
          const buffer = Buffer.allocUnsafe(chunkBytes);
          let bytes = 0;
          while (true) {
            check(budget);
            const read = await input.read(buffer, 0, buffer.length, null);
            if (!read.bytesRead) break;
            bytes += read.bytesRead;
            if (bytes > entry.bytes) throw new Error('Toolchain file changed while copying.');
            let written = 0;
            while (written < read.bytesRead) {
              check(budget);
              const result = await output.write(buffer, written, read.bytesRead - written);
              if (!result.bytesWritten) throw new Error('Incomplete toolchain copy.');
              written += result.bytesWritten;
            }
            await setImmediate();
          }
          if (bytes !== entry.bytes) throw new Error('Toolchain file changed while copying.');
          await output.chmod(entry.mode);
        } finally {
          await output.close();
        }
      } finally {
        await input.close();
      }
    }
    await setImmediate();
  }
  for (const entry of [...expected.tree.entries].reverse()) {
    check(budget);
    if (entry.kind === 'directory') await chmod(join(candidate, entry.path), entry.mode);
  }
  same(
    (await inspectInstalledDependencies(donor, expected.workspaces, budget)).hash,
    expected.hash,
  );
  const copied = await inspectInstalledDependencies(candidate, expected.workspaces, budget);
  same(copied.hash, expected.hash);
  return copied;
}
