import { execFileSync } from 'node:child_process';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Task } from './manifest.ts';

// Everything here works on local files and local git objects. Nothing reaches the network.

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
};

export function git(repository: string, args: readonly string[]): Buffer {
  return execFileSync('git', ['-C', repository, '-c', 'core.fsmonitor=false', ...args], {
    env: GIT_ENV,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** The repository a task reads commits from. `self` is the checkout the harness runs from. */
export const repositoryOf = (task: Task, self: string) =>
  task.repository === 'self' ? self : task.repository;

export function hasCommit(repository: string, commit: string): boolean {
  try {
    git(repository, ['cat-file', '-e', `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Writes the tree of one commit into an empty directory. Tracked files only, no history. */
export function exportCommit(repository: string, commit: string, directory: string) {
  mkdirSync(directory, { recursive: true });
  const archive = join(mkdtempSync(join(tmpdir(), 'bench-archive-')), 'tree.tar');
  try {
    git(repository, ['archive', '--format=tar', '-o', archive, commit]);
    execFileSync('tar', ['-xf', archive, '-C', directory], { stdio: 'ignore' });
  } finally {
    rmSync(dirname(archive), { recursive: true, force: true });
  }
}

/**
 * A fresh repository holding the base tree as its only commit. The controller copies the committed
 * files of HEAD, and a history with no later commits has nothing to leak the solution through.
 */
export function createProject(repository: string, base: string, directory: string) {
  exportCommit(repository, base, directory);
  const run = (args: string[]) => git(directory, args);
  run(['init', '-q']);
  run(['add', '-A', '-f']);
  run([
    '-c',
    'user.name=bench',
    '-c',
    'user.email=bench@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--no-verify',
    '-m',
    'base',
  ]);
}

/** Copies files from the solution commit over the working copy. Binary files copy as they are. */
export function placeHidden(
  repository: string,
  solution: string,
  paths: readonly string[],
  directory: string,
) {
  for (const path of paths) {
    const target = resolve(directory, path);
    if (!target.startsWith(`${resolve(directory)}${sep}`))
      throw new Error(`${path} leaves the working copy.`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, git(repository, ['show', `${solution}:${path}`]));
  }
}

export function copyTree(from: string, to: string) {
  cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
}

/** Directories named node_modules at the root and up to two folders down. */
function dependencyFolders(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string, depth: number) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.git') continue;
      const path = join(directory, entry.name);
      if (entry.name === 'node_modules') found.push(path);
      else if (depth < 2) visit(path, depth + 1);
    }
  };
  visit(root, 0);
  return found;
}

/**
 * Gives a working copy the installed dependencies of the checkout it came from, so checks run
 * without an install and without a network. Each node_modules folder is rebuilt as real folders
 * of links. A link to another workspace package points at the copy's own package, so the code under
 * test is the code in the copy. Every other link points at the shared store.
 */
export function linkDependencies(source: string, directory: string) {
  const root = realpathSync(source);
  for (const folder of dependencyFolders(root)) {
    const place = join(directory, relative(root, folder));
    // A package the base commit did not have gets no folder.
    if (!lstatOrNull(dirname(place))) continue;
    mirror(folder, place, root, directory);
  }
}

const lstatOrNull = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

function mirror(folder: string, place: string, root: string, directory: string) {
  mkdirSync(place, { recursive: true });
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const from = join(folder, entry.name);
    const to = join(place, entry.name);
    if (entry.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(from);
      } catch {
        continue;
      }
      const inside = relative(root, real);
      const workspace =
        !inside.startsWith('..') && !inside.split(sep).includes('node_modules') && inside !== '';
      const target = workspace ? join(directory, inside) : real;
      if (workspace && !lstatOrNull(target)) continue;
      symlinkSync(target, to);
    } else if (entry.isDirectory() && entry.name.startsWith('@')) {
      mirror(from, to, root, directory);
    } else {
      symlinkSync(from, to);
    }
  }
}

/** Where a link in a mirrored folder points, for tests that read the layout. */
export const linkTarget = (path: string) => readlinkSync(path);
