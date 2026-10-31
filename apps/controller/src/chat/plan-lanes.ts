import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import {
  type ChatFamily,
  type ChatPlanState,
  MAX_PLAN_CONFLICTS,
  planOrder,
} from '@crewkite/contracts';
import {
  blobToFile,
  type CandidateHash,
  hashCandidateFiles,
  type PlannedFile,
  readPlannedBlobs,
  scratchPlan,
} from '../host/source.ts';
import { changedPaths } from './changes.ts';
import { copyScratch } from './scratch-copy.ts';

// Parallel plan slices (ADR 0045, amendment of 2026-10-28). Each slice runs in its own scratch
// copy, and a finished slice replays onto the thread's copy in plan order. Files compare by blob
// oid and mode, the way the Changes tab compares a copy with its base.

type Slice = ChatPlanState['slices'][number];
type State = { oid: string; mode: string } | null;

/**
 * The slices that may open their builder turn now, in plan order: queued, every dependency done,
 * and assigned to a family with no open turn. Two ready slices on one family run one after the other, so
 * at most one of them is picked. Nothing starts while a slice is blocked, since its resolve turn
 * edits the thread copy that a new slice would copy.
 */
export function readySlices(
  plan: Pick<ChatPlanState, 'slices'>,
  busy: ReadonlySet<ChatFamily>,
): Slice[] {
  if (plan.slices.some((slice) => slice.status === 'blocked')) return [];
  const done = new Set(plan.slices.filter((s) => s.status === 'done').map((s) => s.id));
  const taken = new Set(busy);
  const ready: Slice[] = [];
  for (const id of order(plan)) {
    const slice = plan.slices.find((value) => value.id === id) as Slice;
    const family = slice.assignment?.family;
    if (slice.status !== 'queued' || !slice.depends.every((dep) => done.has(dep))) continue;
    // A slice with no family has nothing to run on. The runner stops the plan over it.
    if (!family || taken.has(family)) continue;
    taken.add(family);
    ready.push(slice);
  }
  return ready;
}

/** Slice IDs in plan order: each after the slices it depends on, ties in the order written. */
export function order(plan: Pick<ChatPlanState, 'slices'>): number[] {
  return planOrder(plan.slices) ?? plan.slices.map((slice) => slice.id);
}

/** The folder of one slice's lane: its copy and the record of where the copy started. */
export function laneFolder(threadScratch: string, sliceId: number): string {
  return join(dirname(threadScratch), 'slices', String(sliceId));
}

export const laneCopy = (folder: string) => join(folder, 'copy');
const startFile = (folder: string) => join(folder, 'start.json');
const ownFile = (folder: string) => join(folder, 'own.json');

/**
 * Make a slice's scratch copy: the thread's base through `copyScratch`, then every file the
 * thread copy changed since the base, so a slice that depends on another starts from its merged
 * work. The paths that differ from the base are recorded, so the replay knows where the copy
 * started. Any earlier copy of the slice goes first.
 */
export function prepareLaneCopy(input: {
  root: string;
  base: string;
  threadScratch: string;
  folder: string;
}): void {
  const { root, base, threadScratch, folder } = input;
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const plan = scratchPlan(root, base);
  const copy = laneCopy(folder);
  copyScratch(copy, plan.files, plan.links, {
    read: (files) => readPlannedBlobs(root, files as PlannedFile[]),
    stream: (file, target) => blobToFile(root, (file as PlannedFile).oid, target),
    checkout: { root, base },
    name: basename(root),
  });
  const moved = changedPaths(plan, hashCandidateFiles(threadScratch, root, plan));
  const start: Record<string, State> = {};
  for (const { path, next } of moved) {
    start[path] = next ? { oid: next.oid, mode: next.mode } : null;
    put(copy, path, next ? join(threadScratch, path) : null, next?.mode);
  }
  writeFileSync(startFile(folder), JSON.stringify(start), { mode: 0o600 });
}

type Owned = { own: string[]; seen: Record<string, State> };

/**
 * Record what one step of a slice's review chain changed in the lane copy. A path the builder or
 * a fixer changed is the slice's own. A path only a review changed is not, and the replay leaves
 * it out, so a reviewer cannot change other slices' merged work or any other path.
 */
export function recordStep(input: {
  root: string;
  base: string;
  folder: string;
  writer: boolean;
}): void {
  const { folder } = input;
  const { lane, startOf, changed } = laneState(input.root, input.base, folder);
  const owned: Owned = existsSync(ownFile(folder))
    ? (JSON.parse(readFileSync(ownFile(folder), 'utf8')) as Owned)
    : { own: [], seen: {} };
  const was = (path: string) => (path in owned.seen ? owned.seen[path] : startOf(path));
  const moved = [...new Set([...changed, ...Object.keys(owned.seen)])].filter(
    (path) => !same(stateOf(lane.get(path)), was(path)),
  );
  // A writer that puts a path back where the slice started gives it up, so a later review edit
  // there stays out of the replay.
  const differs = new Set(changed);
  const own = input.writer
    ? [...new Set([...owned.own, ...moved])].filter((path) => differs.has(path)).sort()
    : owned.own;
  const seen = Object.fromEntries(changed.map((path) => [path, stateOf(lane.get(path))]));
  writeFileSync(ownFile(folder), JSON.stringify({ own, seen } satisfies Owned), { mode: 0o600 });
}

/**
 * `dropped` holds the paths only a review changed, outside the slice's own changes. `skipped`
 * holds the paths the replay after a resolve turn left out because they lead out of the thread
 * copy through a link.
 */
export type Replay = {
  applied: string[];
  conflicts: string[];
  dropped: string[];
  skipped: string[];
};

/**
 * Put a slice's changes on the thread copy. A path the slice changed is written when the thread
 * copy still holds what the slice started from, skipped when the thread copy already matches the
 * slice, and a conflict otherwise. A path that would lead out of the thread copy through a link
 * counts as a conflict. A slice with any conflict writes nothing, so a resolve turn that fails
 * leaves the thread copy as the finished slices left it. After the resolve turn, `resolved`
 * writes the clean paths and leaves each path the thread copy changed as the orchestrator left
 * it. A path only a review changed, outside the slice's own changes, is dropped.
 */
export function replayLane(input: {
  root: string;
  base: string;
  threadScratch: string;
  folder: string;
  resolved?: boolean;
}): Replay {
  const { root, base, threadScratch, folder } = input;
  const { plan, lane, startOf, changed } = laneState(root, base, folder);
  // A lane with no review chain records nothing, and all it changed is its own.
  const own = existsSync(ownFile(folder))
    ? new Set((JSON.parse(readFileSync(ownFile(folder), 'utf8')) as Owned).own)
    : null;
  const thread = byPath(hashCandidateFiles(threadScratch, root, plan));
  const clean: string[] = [];
  const conflicts: string[] = [];
  const dropped: string[] = [];
  const skipped: string[] = [];
  for (const path of changed) {
    const mine = stateOf(lane.get(path));
    const theirs = stateOf(thread.get(path));
    if (same(theirs, mine)) continue;
    if (own && !own.has(path)) {
      dropped.push(path);
      continue;
    }
    const linked = !inside(threadScratch, path);
    if (!same(theirs, startOf(path)) || linked) {
      // After the resolve turn, a path the thread copy changed stays as the orchestrator left it.
      if (!input.resolved) conflicts.push(path);
      else if (linked) skipped.push(path);
      continue;
    }
    clean.push(path);
  }
  if (conflicts.length) return { applied: [], conflicts, dropped, skipped };
  const copy = laneCopy(folder);
  for (const path of clean) {
    const mine = lane.get(path);
    put(threadScratch, path, mine ? join(copy, path) : null, mine?.mode);
  }
  return { applied: clean, conflicts, dropped, skipped };
}

/** The lane copy by path, where it started, and the paths it changed since, sorted. */
function laneState(root: string, base: string, folder: string) {
  const plan = scratchPlan(root, base);
  const start = new Map(
    Object.entries(JSON.parse(readFileSync(startFile(folder), 'utf8')) as Record<string, State>),
  );
  const baseOf = new Map(plan.files.map((file) => [file.path, file]));
  const startOf = (path: string): State => {
    if (start.has(path)) return start.get(path) ?? null;
    const file = baseOf.get(path);
    return file ? { oid: file.oid, mode: file.mode } : null;
  };
  const lane = byPath(hashCandidateFiles(laneCopy(folder), root, plan));
  const paths = new Set([
    ...changedPaths(plan, [...lane.values()]).map((entry) => entry.path),
    ...start.keys(),
  ]);
  const changed = [...paths].sort().filter((path) => !same(stateOf(lane.get(path)), startOf(path)));
  return { plan, lane, startOf, changed };
}

const FILE_CHARACTERS = 16_000;
const TOTAL_CHARACTERS = 48_000;

/**
 * The message of the orchestrator's one turn on a blocked slice. It runs in the thread copy and
 * gets the slice's version of each conflicting path, so it never reads the slice's own copy.
 */
export function resolveBrief(input: {
  slice: { id: number; title: string };
  brief: string | null;
  folder: string;
  conflicts: readonly string[];
}): string {
  const copy = laneCopy(input.folder);
  let room = TOTAL_CHARACTERS;
  const files = input.conflicts.map((path) => {
    const text = readText(join(copy, path));
    if (text === null) return `${path}: the slice deleted this file, or it is not text.`;
    if (typeof text === 'number' || text.length > FILE_CHARACTERS || text.length > room)
      return `${path}: too large to quote here. Name it in your reply as not merged.`;
    room -= text.length;
    return `${path}, as the slice left it:\n\n\`\`\`\n${text.replace(/\n$/, '')}\n\`\`\``;
  });
  return [
    `Slice ${input.slice.id} (${input.slice.title}) finished, and the thread copy changed the same files after the slice started. Its other files merge into the scratch copy when your turn ends.`,
    'Merge these files by hand in the scratch copy. Keep what the scratch copy holds now and add what the slice changed. Read each file before you change it.',
    input.brief ? `The slice's brief:\n\n${input.brief}` : '',
    files.join('\n\n'),
    'When you are done, say what you merged in each file.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The first conflicts the card lists. The line names the total. */
export const listedConflicts = (paths: readonly string[]) => paths.slice(0, MAX_PLAN_CONFLICTS);

function byPath(files: readonly CandidateHash[]) {
  return new Map(files.map((file) => [file.path, file]));
}

const stateOf = (file: CandidateHash | undefined): State =>
  file ? { oid: file.oid, mode: file.mode } : null;

const same = (a: State, b: State) => a?.oid === b?.oid && a?.mode === b?.mode;

/** Whether the folder that would hold a path resolves inside the copy, through any links. */
function inside(root: string, path: string): boolean {
  const top = realpathSync(root);
  let folder = dirname(join(root, path));
  while (true) {
    try {
      const real = realpathSync(folder);
      return real === top || real.startsWith(`${top}${sep}`);
    } catch {
      // A folder that does not exist yet is made below the nearest one that does.
      const up = dirname(folder);
      if (up === folder) return false;
      folder = up;
    }
  }
}

/** Write one regular file from `from` at `path` under `root`, or remove it when `from` is null. */
function put(root: string, path: string, from: string | null, mode?: string) {
  const target = join(root, path);
  rmSync(target, { recursive: true, force: true });
  if (from === null) return;
  const state = lstatSync(from);
  if (!state.isFile()) throw new Error(`${path} is not a regular file.`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(from, target);
  chmodSync(target, mode === '100755' ? 0o755 : 0o644);
}

/** A file's text, its size in bytes when it is too large to quote, or null for no text file. */
function readText(path: string): string | number | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const state = fstatSync(fd);
    if (!state.isFile()) return null;
    if (state.size > FILE_CHARACTERS * 4) return state.size;
    const bytes = readFileSync(fd);
    if (bytes.includes(0)) return null;
    return bytes.toString('utf8');
  } finally {
    closeSync(fd);
  }
}
