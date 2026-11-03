import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const required = [
  'CrewKite-macOS-arm64.dmg',
  'crewkite_amd64.deb',
  'crewkite_arm64.deb',
  'crewkite.x86_64.rpm',
  'crewkite.aarch64.rpm',
];
const images = ['CrewKite-linux-x86_64.AppImage', 'CrewKite-linux-arm64.AppImage'];
const filename = 'SHA256SUMS';
const identityKeys = ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'];

function digest(path) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(file, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size === 0n)
      throw new Error('Release assets must be nonempty regular files without links.');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const length = readSync(file, buffer);
      if (!length) break;
      hash.update(buffer.subarray(0, length));
    }
    const after = fstatSync(file, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (identityKeys.some((key) => before[key] !== after[key] || after[key] !== current[key]))
      throw new Error('A release asset changed while hashing.');
    return { hash: hash.digest('hex'), identity: after };
  } finally {
    closeSync(file);
  }
}

/** The publication folder holds five required binaries and either both portable images or neither. */
export function releaseChecksums(directory, { check = false } = {}) {
  const root = realpathSync(resolve(directory));
  const entries = readdirSync(root).sort();
  const withImages = images.every((name) => entries.includes(name));
  if (images.some((name) => entries.includes(name)) && !withImages)
    throw new Error('Publish both AppImage architectures or omit both.');
  const assets = [...required, ...(withImages ? images : [])].sort();
  const actual = entries.filter((name) => name !== filename);
  if (JSON.stringify(actual) !== JSON.stringify(assets))
    throw new Error('The publication folder must contain exactly the required release assets.');
  const rows = assets.map((name) => ({ name, ...digest(join(root, name)) }));
  const contents = rows.map(({ name, hash }) => `${hash}  ${name}\n`).join('');
  for (const { name, identity } of rows) {
    const current = lstatSync(join(root, name), { bigint: true });
    if (identityKeys.some((key) => identity[key] !== current[key]))
      throw new Error('A release asset changed before checksum publication.');
  }
  if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify(entries))
    throw new Error('The publication folder changed while hashing.');
  const sums = join(root, filename);
  if (check) {
    const file = openSync(sums, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const state = fstatSync(file, { bigint: true });
      if (!state.isFile() || state.nlink !== 1n || state.size > 16384n)
        throw new Error('SHA256SUMS must be a small regular file.');
      if (readFileSync(file, 'utf8') !== contents)
        throw new Error('SHA256SUMS differs from the final release assets.');
      const current = lstatSync(sums, { bigint: true });
      if (identityKeys.some((key) => state[key] !== current[key]))
        throw new Error('SHA256SUMS changed during verification.');
    } finally {
      closeSync(file);
    }
  } else writeFileSync(sums, contents, { flag: 'wx', mode: 0o644 });
  return { assets, sha256sums: sums };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: { directory: { type: 'string' }, check: { type: 'boolean', default: false } },
    });
    if (!values.directory) throw new Error('Supply --directory with the publication folder.');
    const result = releaseChecksums(values.directory, { check: values.check });
    console.log(
      `${values.check ? 'Verified' : 'Wrote'} checksums for ${result.assets.length} release assets.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Release checksum verification failed.');
    process.exitCode = 1;
  }
}
