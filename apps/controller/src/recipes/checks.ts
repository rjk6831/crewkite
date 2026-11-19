import { createHash } from 'node:crypto';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { ChatCheck } from '@crewkite/contracts';
import {
  ADDED_RULE,
  addedProblem,
  commandWords,
  describe,
  detectChecks,
  FILE_BYTES,
} from '../chat/checks.ts';
import { blobToFile, git } from '../host/source.ts';

// What a recipe's check commands run, read the way a thread pins a check it switches on. A
// schedule's approval and a run's copy must agree on the digest, so both come from `resolveCheck`
// over a folder: the run's copy, or the files a check reads taken from the committed HEAD.

export type ResolvedCheck = { command: string; resolved: string | null; digest: string | null };

/** The files `detectChecks` and `sourceDigest` read whatever the command says. */
const DECLARING_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'pyproject.toml',
  'pytest.ini',
  'Makefile',
  'Cargo.toml',
  'go.mod',
];

/**
 * Why a recipe's check command is refused, or null. It follows the rule for a check a person adds
 * to a thread, with the thread's sentence. An absolute path names a place on this computer, and a
 * run's copy lives somewhere else, so a recipe names none.
 */
export function checkCommandProblem(command: string, root: string): string | null {
  const words = commandWords(command);
  if (!words) return ADDED_RULE;
  // The thread's rule reads the value of a name=value word as its path, and so does this one.
  const value = (word: string) => (word.includes('=') ? word.slice(word.indexOf('=') + 1) : word);
  if (words.some((word) => value(word).startsWith('/')))
    return 'A check command cannot name an absolute path. A recipe travels with the project.';
  return addedProblem(words, root);
}

/**
 * What one command runs in a folder and the digest a thread would pin it by. A command the thread
 * detects is described as that check, and any other as a command the person added. An approval is
 * only worth something when the digest covers what runs, so a command resolves to nothing unless
 * it is a detected check or its digest covers a file: a package.json script it names or a file a
 * word names. The digest never covers the program itself, so a program path such as ./gradlew
 * resolves to nothing whatever else the command names, and so does a folder. A later commit could
 * change what either runs with nobody asked.
 */
export function resolveCheck(command: string, directory: string): ResolvedCheck {
  const words = commandWords(command);
  if (!words) return { command, resolved: null, digest: null };
  const normalized = words.join(' ');
  const detected = detectChecks(directory).find((check) => check.command === normalized);
  if (!detected && words[0].includes('/')) return { command, resolved: null, digest: null };
  const item: ChatCheck = detected
    ? { ...detected, enabled: true, pin: null }
    : {
        id: 'custom:1',
        label: normalized.slice(0, 80),
        kind: 'custom',
        source: 'custom',
        command: normalized,
        resolved: normalized,
        enabled: true,
        pin: null,
      };
  const now = describe(item, directory);
  // The digest of the command alone, as sourceDigest starts it for a command the person added.
  const bare = createHash('sha256').update(`${normalized}\0`).digest('hex');
  return detected !== undefined || now.digest !== bare
    ? { command, resolved: now.resolved, digest: now.digest }
    : { command, resolved: null, digest: null };
}

/**
 * Each command resolved against the project's committed HEAD, the base a run's copy starts from.
 * An empty list resolves to an empty list without touching git.
 */
export function resolveAtHead(
  root: string,
  home: string,
  commands: readonly string[],
): ResolvedCheck[] {
  if (!commands.length) return [];
  return (
    atHead(root, home, commands, (folder) =>
      commands.map((command) => resolveCheck(command, folder)),
    ) ?? commands.map((command) => ({ command, resolved: null, digest: null }))
  );
}

/**
 * How many checks a new thread would hold with these commands switched on: the ones it detects at
 * the committed HEAD plus every command it does not detect, which it adds. A thread holds at most
 * MAX_THREAD_CHECKS. Null when the project has no commit.
 */
export function threadCheckCount(
  root: string,
  home: string,
  commands: readonly string[],
): number | null {
  return atHead(root, home, commands, (folder) => {
    const detected = detectChecks(folder)
      .slice(0, MAX_THREAD_CHECKS)
      .map((check) => check.command);
    const added = new Set(commands.map((command) => commandWords(command)?.join(' ') ?? command));
    for (const command of detected) added.delete(command);
    return detected.length + added.size;
  });
}

export const MAX_THREAD_CHECKS = 16;

/**
 * Runs `work` over a folder that holds the files the checks read, taken from the project's
 * committed HEAD. The folder is private, under the controller home, and is removed after, so an
 * uncommitted edit plays no part and nothing in the project runs. A file over the read limit is
 * only checked for being there and for its size, so it becomes an empty sparse file of that size
 * and nothing large is copied. Null when the project has no commit.
 */
function atHead<T>(
  root: string,
  home: string,
  commands: readonly string[],
  work: (folder: string) => T,
): T | null {
  let head: string;
  try {
    head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).toString().trim();
  } catch {
    return null;
  }
  const names = new Set(DECLARING_FILES);
  for (const command of commands)
    for (const word of commandWords(command) ?? []) {
      const name = inside(word);
      if (name) names.add(name);
    }
  const parent = join(home, 'recipes');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const folder = mkdtempSync(join(parent, 'head-'));
  try {
    const listed = git(root, [
      '--literal-pathspecs',
      'ls-tree',
      '-z',
      '-l',
      head,
      '--',
      ...names,
    ]).toString('utf8');
    for (const record of listed.split('\0').filter(Boolean)) {
      const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64}) +(\d+)\t(.+)$/s.exec(record);
      if (!match) continue;
      const [, , oid, size, path] = match;
      const target = join(folder, ...path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      if (Number(size) <= FILE_BYTES) blobToFile(root, oid, target);
      else {
        const file = openSync(target, 'wx', 0o600);
        try {
          ftruncateSync(file, Number(size));
        } finally {
          closeSync(file);
        }
      }
    }
    return work(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * The project path a word names, as `sourceDigest` reads it: joined to the folder, so a leading
 * slash names a path inside it. Undefined for a word that leaves the folder or names `.git`.
 */
function inside(word: string): string | undefined {
  const name = posix.normalize(word).replace(/^\/+|\/+$/g, '');
  const parts = name.split('/');
  if (!name || name === '.' || parts.some((part) => part === '..' || part === '.git'))
    return undefined;
  return name;
}
