import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, open, realpath, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type CopyBudget, inventoryTree } from '../apps/controller/src/host/toolchain.ts';

export type RuntimePackage = {
  name: string;
  version: string;
  edges: string[];
  optionalPeers?: string[];
  license: string;
};

const inside = (root: string, path: string) => {
  const child = relative(root, path);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new Error('Runtime package escapes its source.');
};

/** One private dependency realm keeps its versions separate from the application. */
export async function copyRuntimePackages(options: {
  source: string;
  from: string;
  destination: string;
  root: string;
  packages: RuntimePackage[];
  budget: CopyBudget;
}) {
  const source = await realpath(options.source);
  const destination = await realpath(options.destination);
  if (destination === source || destination.startsWith(`${source}${sep}`))
    throw new Error('Runtime package copy overlaps its source.');
  const qualified = new Map(options.packages.map((pin) => [pin.name, pin]));
  if (qualified.size !== options.packages.length || !qualified.has(options.root))
    throw new Error('Runtime package qualification is ambiguous.');
  for (const pin of qualified.values())
    if (
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(pin.name) ||
      !/^\d+\.\d+\.\d+$/.test(pin.version) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(pin.license)
    )
      throw new Error('Runtime package qualification is invalid.');
  const queue = [{ name: options.root, from: resolve(source, options.from) }];
  const found = new Map<
    string,
    { pin: RuntimePackage; path: string; inventory: Awaited<ReturnType<typeof inventoryTree>> }
  >();
  let entries = 0;
  let bytes = 0;
  while (queue.length) {
    const request = queue.shift();
    if (!request) break;
    const pin = qualified.get(request.name);
    if (!pin) throw new Error('Runtime dependency is not qualified.');
    inside(source, request.from);
    const entry = await realpath(createRequire(request.from).resolve(request.name));
    inside(source, entry);
    let path = dirname(entry);
    let manifestHash = '';
    let manifest: {
      name?: string;
      version?: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    // Package exports can hide package.json. Resolve the entry without evaluating it.
    while (true) {
      inside(source, path);
      const file = join(path, 'package.json');
      const state = await lstat(file).catch(() => null);
      if (state) {
        if (!state.isFile() || state.size > 65536)
          throw new Error('Runtime package manifest must be a bounded regular file.');
        const handle = await open(
          file,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const buffer = Buffer.alloc(65537);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (!(await handle.stat()).isFile() || bytesRead > 65536)
            throw new Error('Runtime package manifest exceeds its bound.');
          const content = buffer.subarray(0, bytesRead);
          manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
          manifestHash = createHash('sha256').update(content).digest('hex');
        } finally {
          await handle.close();
        }
        if (manifest.name === pin.name) break;
      }
      if (path === source) throw new Error('Runtime package identity is missing.');
      path = dirname(path);
    }
    if (manifest.version !== pin.version) throw new Error('Runtime package version changed.');
    const previous = found.get(pin.name);
    if (previous) {
      if (previous.path !== path) throw new Error('Runtime dependency resolution conflicts.');
      continue;
    }
    const peers = Object.keys(manifest.peerDependencies ?? {});
    const optional = peers.filter((name) => manifest.peerDependenciesMeta?.[name]?.optional);
    const edges = [
      ...new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...peers.filter((name) => !optional.includes(name)),
      ]),
    ].sort();
    assert.deepEqual(edges, [...pin.edges].sort(), 'Runtime dependency edges changed.');
    assert.deepEqual(optional.sort(), [...(pin.optionalPeers ?? [])].sort());
    assert.equal(Object.keys(manifest.optionalDependencies ?? {}).length, 0);
    const inventory = await inventoryTree(path, {
      ...options.budget,
      maximumEntries: options.budget.maximumEntries - entries,
      maximumBytes: options.budget.maximumBytes - bytes,
    });
    const manifestEntry = inventory.entries.find((item) => item.path === 'package.json');
    if (manifestEntry?.kind !== 'file' || manifestEntry.hash !== manifestHash)
      throw new Error('Runtime package manifest changed during inspection.');
    if (inventory.entries.some((item) => item.path.split('/').includes('node_modules')))
      throw new Error('Runtime package contains an unqualified nested installation.');
    if (
      !inventory.entries.some(
        (item) => item.path === pin.license && item.kind === 'file' && item.bytes > 0,
      )
    )
      throw new Error('Runtime package license text is missing.');
    entries += inventory.entries.length;
    bytes += inventory.bytes;
    found.set(pin.name, { pin, path, inventory });
    for (const name of edges) queue.push({ name, from: join(path, 'package.json') });
  }
  if (found.size !== qualified.size) throw new Error('Runtime package closure is incomplete.');
  const realm = join(destination, 'node_modules/.runtime/node_modules');
  await mkdir(join(destination, 'node_modules'), { recursive: true });
  inside(destination, await realpath(join(destination, 'node_modules')));
  await mkdir(dirname(realm));
  await mkdir(realm);
  const copied = [];
  for (const { pin, path, inventory } of found.values()) {
    assert.equal((await inventoryTree(path, options.budget)).hash, inventory.hash);
    const target = join(realm, pin.name);
    await mkdir(dirname(target), { recursive: true });
    await cp(path, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    assert.equal((await inventoryTree(target, options.budget)).hash, inventory.hash);
    copied.push({ name: pin.name, version: pin.version, license: join(target, pin.license) });
  }
  for (const { pin, path, inventory } of found.values()) {
    assert.equal((await inventoryTree(path, options.budget)).hash, inventory.hash);
    assert.equal((await inventoryTree(join(realm, pin.name), options.budget)).hash, inventory.hash);
  }
  const alias = join(destination, 'node_modules', options.root);
  await mkdir(dirname(alias), { recursive: true });
  inside(destination, await realpath(dirname(alias)));
  await symlink(relative(dirname(alias), join(realm, options.root)), alias);
  return copied;
}
