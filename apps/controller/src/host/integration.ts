import { createHash } from 'node:crypto';
import { type FileContent, safePath } from './source.ts';

export type AssemblyMember = {
  base: string;
  scope: readonly string[];
  dependencies: readonly string[];
  files: readonly FileContent[];
};
export type AssemblyChange = {
  path: string;
  before: FileContent | null;
  after: FileContent | null;
};
export type AssemblyStep = { files: FileContent[]; changes: AssemblyChange[] };

const MAX_FILES = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;
const copy = (file: FileContent): FileContent => ({
  path: file.path,
  mode: file.mode,
  hash: file.hash,
  bytes: file.bytes,
  content: Buffer.from(file.content),
});
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const same = (left: FileContent | undefined, right: FileContent | undefined) =>
  left === undefined || right === undefined
    ? left === right
    : left.mode === right.mode && left.hash === right.hash && left.bytes === right.bytes;

function inventory(files: readonly FileContent[]): Map<string, FileContent> {
  if (!Array.isArray(files) || files.length > MAX_FILES)
    throw Error('Assembly exceeds the file limit.');
  const seen = new Set<string>();
  const prefixes = new Map<string, string>();
  const result = new Map<string, FileContent>();
  let bytes = 0;
  for (const file of files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      !['100644', '100755'].includes(file.mode) ||
      !Buffer.isBuffer(file.content) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes !== file.content.length ||
      createHash('sha256').update(file.content).digest('hex') !== file.hash
    )
      throw Error('Assembly file identity changed.');
    safePath(file.path, seen, prefixes);
    bytes += file.bytes;
    if (bytes > MAX_BYTES) throw Error('Assembly exceeds the byte limit.');
    result.set(file.path, copy(file));
  }
  return result;
}

// The controller attests writer provenance before supplying these inventories.
export function assembleSlices(input: {
  base: string;
  files: readonly FileContent[];
  members: readonly [AssemblyMember, AssemblyMember];
}): [AssemblyStep, AssemblyStep] {
  if (typeof input.base !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.base))
    throw Error('Assembly needs a committed base.');
  if (!Array.isArray(input.members) || input.members.length !== 2)
    throw Error('Assembly needs exactly two members.');
  const original = inventory(input.files);
  const seen = new Set<string>();
  const prefixes = new Map<string, string>();
  for (const member of input.members) {
    if (!member || member.base !== input.base) throw Error('Assembly member base changed.');
    if (!Array.isArray(member.dependencies) || member.dependencies.length !== 0)
      throw Error('Assembly members must have no dependencies.');
    if (!Array.isArray(member.scope) || !member.scope.length || member.scope.length > MAX_FILES)
      throw Error('Assembly needs a bounded exact scope.');
    for (const path of member.scope) {
      if (typeof path !== 'string') throw Error('Assembly scope contains an invalid path.');
      safePath(path, seen, prefixes);
    }
  }
  const staging = new Map(original);
  const steps = input.members.map((member) => {
    const current = inventory(member.files);
    const scope = new Set(member.scope);
    const changes: AssemblyChange[] = [];
    const paths = [...new Set([...original.keys(), ...current.keys()])].sort(compare);
    for (const path of paths) {
      const before = original.get(path);
      const after = current.get(path);
      if (same(before, after)) continue;
      if (!scope.has(path)) throw Error('Assembly member changed a path outside its scope.');
      if (!same(staging.get(path), before)) throw Error('Assembly preimage changed.');
      if (after) staging.set(path, after);
      else staging.delete(path);
      changes.push({
        path,
        before: before ? copy(before) : null,
        after: after ? copy(after) : null,
      });
    }
    // Separate snapshots keep later replay from changing an earlier integration step.
    const files = [...inventory([...staging.values()]).values()].sort((left, right) =>
      compare(left.path, right.path),
    );
    return { files, changes };
  });
  return [steps[0], steps[1]];
}
