import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, open, realpath, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type CopyBudget,
  inventoryTree,
  type TreeInventory,
} from '../apps/controller/src/host/toolchain.ts';

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

export type StorePackage = RuntimePackage & {
  /**
   * A license text from the package's upstream repository, relative to the source checkout, for
   * a package whose published files carry none. The package's own file wins when it has one.
   */
  notice?: string;
};

/** Reads a bounded package manifest without following a link at its last step. */
async function readManifest(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (!(await handle.stat()).isFile() || bytesRead > 65536)
      throw new Error('Runtime package manifest exceeds its bound.');
    const content = buffer.subarray(0, bytesRead);
    return {
      manifest: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)) as {
        name?: string;
        version?: string;
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      },
      hash: createHash('sha256').update(content).digest('hex'),
    };
  } finally {
    await handle.close();
  }
}

/**
 * The installed folder of `name` as seen from the package manifest `from`. Packages whose exports
 * hide package.json, or that export types only, are found the way Node walks node_modules.
 */
async function packageFolder(source: string, name: string, from: string): Promise<string> {
  try {
    let path = dirname(await realpath(createRequire(from).resolve(name)));
    while (true) {
      inside(source, path);
      const file = join(path, 'package.json');
      if ((await lstat(file).catch(() => null))?.isFile()) {
        const { manifest } = await readManifest(file);
        if (manifest.name === name) return path;
      }
      if (path === source) break;
      path = dirname(path);
    }
  } catch {}
  for (let directory = dirname(from); ; directory = dirname(directory)) {
    inside(source, directory);
    const candidate = join(directory, 'node_modules', name);
    if ((await lstat(join(candidate, 'package.json')).catch(() => null)) !== null)
      return realpath(candidate);
    if (directory === source) throw new Error(`Runtime package ${name} is not installed.`);
  }
}

const storeName = (pin: RuntimePackage) => `${pin.name.replace('/', '+')}@${pin.version}`;

/**
 * One private store for a workspace's dependency closure, laid out the way pnpm lays it out: each
 * pinned version in its own folder, its dependencies beside it as relative links. Two versions of
 * one package can live in the closure, each reached only by the packages that asked for it. `roots`
 * get a link in `destination/node_modules`. Every package is pinned by name, version, dependency
 * edges and license text, and its bytes are checked before and after the copy.
 */
/** The folder pnpm writes for a package's command shims, which a runtime copy leaves out. */
const binShim = (path: string) =>
  path === 'node_modules' || /^node_modules\/\.bin(?:\/|$)/.test(path);
/** A package's files as copied: every entry but the command shims. */
const payload = (inventory: TreeInventory) =>
  JSON.stringify(inventory.entries.filter((entry) => !binShim(entry.path)));

export async function copyRuntimeStore(options: {
  source: string;
  from: string;
  destination: string;
  realm: string;
  roots: string[];
  packages: StorePackage[];
  budget: CopyBudget;
}) {
  const source = await realpath(options.source);
  const destination = await realpath(options.destination);
  if (!/^\.[a-z0-9-]+$/.test(options.realm)) throw new Error('Runtime store name is invalid.');
  const key = (pin: RuntimePackage) => `${pin.name}@${pin.version}`;
  const pins = new Map(options.packages.map((pin) => [key(pin), pin]));
  if (pins.size !== options.packages.length)
    throw new Error('Runtime package qualification is ambiguous.');
  for (const pin of pins.values())
    if (
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(pin.name) ||
      !/^\d+\.\d+\.\d+$/.test(pin.version) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(pin.license) ||
      (pin.notice !== undefined &&
        (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(pin.notice) || pin.notice.split('/').includes('..')))
    )
      throw new Error('Runtime package qualification is invalid.');
  type Found = {
    pin: StorePackage;
    path: string;
    inventory: TreeInventory;
    links: Map<string, string>;
    license: string;
  };
  const found = new Map<string, Found>();
  const byPath = new Map<string, string>();
  const rootKeys = new Map<string, string>();
  const from = resolve(source, options.from);
  inside(source, from);
  const queue: { name: string; from: string; parent: string | null }[] = options.roots.map(
    (name) => ({ name, from, parent: null }),
  );
  let entries = 0;
  let bytes = 0;
  while (queue.length) {
    const request = queue.shift();
    if (!request) break;
    const path = await packageFolder(source, request.name, request.from);
    inside(source, path);
    const { manifest, hash } = await readManifest(join(path, 'package.json'));
    if (manifest.name !== request.name) throw new Error('Runtime package identity is missing.');
    const pin = pins.get(`${request.name}@${manifest.version}`);
    if (!pin)
      throw new Error(`Runtime dependency ${request.name}@${manifest.version} is not qualified.`);
    const id = key(pin);
    if (request.parent) found.get(request.parent)?.links.set(request.name, id);
    else rootKeys.set(request.name, id);
    const previous = byPath.get(path);
    if (previous !== undefined && previous !== id)
      throw new Error('Runtime dependency resolution conflicts.');
    if (found.has(id)) {
      if (found.get(id)?.path !== path) throw new Error('Runtime dependency resolution conflicts.');
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
    assert.deepEqual(edges, [...pin.edges].sort(), `Runtime dependency edges changed: ${id}.`);
    assert.deepEqual(optional.sort(), [...(pin.optionalPeers ?? [])].sort());
    assert.equal(Object.keys(manifest.optionalDependencies ?? {}).length, 0);
    const inventory = await inventoryTree(path, {
      ...options.budget,
      maximumEntries: options.budget.maximumEntries - entries,
      maximumBytes: options.budget.maximumBytes - bytes,
    });
    const manifestEntry = inventory.entries.find((item) => item.path === 'package.json');
    if (manifestEntry?.kind !== 'file' || manifestEntry.hash !== hash)
      throw new Error('Runtime package manifest changed during inspection.');
    if (
      inventory.entries.some(
        (item) => item.path.split('/').includes('node_modules') && !binShim(item.path),
      )
    )
      throw new Error('Runtime package contains an unqualified nested installation.');
    const own = inventory.entries.some(
      (item) => item.path === pin.license && item.kind === 'file' && item.bytes > 0,
    );
    let license = join(path, pin.license);
    if (!own) {
      if (!pin.notice) throw new Error(`Runtime package license text is missing: ${id}.`);
      license = resolve(source, pin.notice);
      inside(source, license);
      if (!(await lstat(license)).isFile())
        throw new Error(`Runtime package notice is missing: ${id}.`);
    }
    entries += inventory.entries.length;
    bytes += inventory.bytes;
    found.set(id, { pin, path, inventory, links: new Map(), license });
    byPath.set(path, id);
    for (const name of edges) queue.push({ name, from: join(path, 'package.json'), parent: id });
  }
  if (found.size !== pins.size) throw new Error('Runtime package closure is incomplete.');
  const store = join(destination, 'node_modules', options.realm);
  await mkdir(join(destination, 'node_modules'), { recursive: true });
  inside(destination, await realpath(join(destination, 'node_modules')));
  await mkdir(store);
  const target = (id: string) => {
    const pin = found.get(id)?.pin;
    if (!pin) throw new Error('Runtime store entry is missing.');
    return join(store, storeName(pin), 'node_modules', pin.name);
  };
  const copied = [];
  for (const [id, { pin, path, inventory, license }] of found) {
    assert.equal((await inventoryTree(path, options.budget)).hash, inventory.hash);
    await mkdir(dirname(target(id)), { recursive: true });
    // The installer's own command shims stay behind; nothing in the package needs them.
    await cp(path, target(id), {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
      filter: (entry) => !binShim(relative(path, entry)),
    });
    assert.equal(payload(await inventoryTree(target(id), options.budget)), payload(inventory));
    copied.push({ name: pin.name, version: pin.version, license });
  }
  // Each package finds its dependencies beside it, as relative links that move with the store.
  for (const { pin, links } of found.values())
    for (const [name, dependency] of links) {
      const link = join(store, storeName(pin), 'node_modules', name);
      await mkdir(dirname(link), { recursive: true });
      await symlink(relative(dirname(link), target(dependency)), link);
    }
  for (const [name, id] of rootKeys) {
    const alias = join(destination, 'node_modules', name);
    await mkdir(dirname(alias), { recursive: true });
    inside(destination, await realpath(dirname(alias)));
    await symlink(relative(dirname(alias), target(id)), alias);
  }
  for (const [id, { path, inventory }] of found) {
    assert.equal((await inventoryTree(path, options.budget)).hash, inventory.hash);
    assert.equal(payload(await inventoryTree(target(id), options.budget)), payload(inventory));
  }
  return copied;
}
