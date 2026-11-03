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
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type RuntimeManifest, RuntimeManifestSchema } from '@crewkite/contracts';

function runtimeBytes(root: string, path: string, maximum: number) {
  const part = relative(root, path);
  if (
    !part ||
    part === '..' ||
    part.startsWith(`..${sep}`) ||
    isAbsolute(part) ||
    realpathSync(path) !== path
  )
    throw new Error('A bundled runtime entry escapes its package or uses a link.');
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(file, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(maximum) ||
      before.mode & 0o022n
    )
      throw new Error('The runtime entry must be a bounded regular file.');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const length = readSync(file, bytes, count, bytes.length - count, null);
      if (length === 0) break;
      count += length;
    }
    const after = fstatSync(file, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (
      BigInt(count) !== before.size ||
      !current.isFile() ||
      (['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeNs', 'ctimeNs'] as const).some(
        (key) => before[key] !== after[key] || after[key] !== current[key],
      )
    )
      throw new Error('The runtime entry changed while reading.');
    return bytes.subarray(0, count);
  } finally {
    closeSync(file);
  }
}

/** Every declared runtime hash is checked before a packaged client can use its controller. */
export function verifyRuntimeIntegrity(runtimeRoot: string): {
  manifest: RuntimeManifest;
  node: string;
} {
  const root = resolve(runtimeRoot);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory())
    throw new Error('The bundled runtime directory must be real.');
  const manifest = RuntimeManifestSchema.parse(
    JSON.parse(runtimeBytes(root, join(root, 'manifest.json'), 4096).toString('utf8')),
  );
  if (manifest.node.platform !== process.platform || manifest.node.arch !== process.arch)
    throw new Error('The bundled runtime platform or architecture does not match.');
  if (
    manifest.layout === 'installed' &&
    manifest.node.platform === 'darwin' &&
    !manifest.localInput
  )
    throw new Error('The installed macOS runtime needs its Local input identity.');
  const hash = (path: string, maximum: number) =>
    createHash('sha256')
      .update(runtimeBytes(root, join(root, path), maximum))
      .digest('hex');
  if (hash('bin/node', 256 * 1024 * 1024) !== manifest.node.sha256)
    throw new Error('The standalone Node checksum does not match.');
  if (
    manifest.localInput &&
    (hash('bin/local-secure-input', 1024 * 1024) !== manifest.localInput.sha256 ||
      hash('apps/controller/src/providers/local/secure-input.m', 1024 * 1024) !==
        manifest.localInput.sourceHash)
  )
    throw new Error('The packaged Local input identity changed.');
  return { manifest, node: join(root, 'bin/node') };
}
