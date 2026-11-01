import { resolve } from 'node:path';
import { scratchPath } from './local-tools.ts';

// The read-only command rule (F12, H11). Balanced and Glide run a command from this set without
// asking when every path it names stays in the scratch copy. A path outside it, through `~`, an
// absolute path, `..` or a link that leads out, goes to the thread's policy.

// Commands Balanced and Glide run without asking. Each reads files and changes nothing. sed
// counts only as `sed -n` with a line range to print.
const READ_ONLY_COMMANDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'find']);
const SED_PRINT = /^(\d+|\$)(,(\d+|\$))?p$/;
// A client can wrap the command in a shell. The script inside is read by the same rules.
const SHELLS = new Set(['sh', 'bash', 'zsh']);
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show']);
// find can run, delete or write through these. rg runs programs with --pre, --hostname-bin and
// --search-zip. git diff and show write a file with --output and run configured programs with
// --ext-diff and --textconv.
const WRITING_FLAGS =
  /^(-exec|-execdir|-ok|-okdir|-delete|-fprint0?|-fprintf|-fls|--pre|--pre-glob|--hostname-bin|-z|--search-zip|--output|--ext-diff|--textconv)(=|$)/;
// A piece of a word the read-only commands accept: plain characters, or a quoted part the shell
// passes on as it stands. No globs, variables, substitutions or escapes outside quotes.
const WORD_PIECE = /^(?:[A-Za-z0-9._/=:,+@%-]+|'[^'\n]*'|"[^"$`\\!\n]*")/;

/**
 * A path inside the scratch copy by the rules the Local tools use: no `..`, nothing in `.git`, and
 * no link that leads out of the copy. The copy itself counts as inside.
 */
export function inScratch(scratch: string, path: string): boolean {
  if (resolve(path) === resolve(scratch) || path === '.') return true;
  try {
    scratchPath(scratch, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every spelling of a path an argument can carry: the word, each part around `=`, and the tail
 * after a short flag written together with its value, such as `-f/etc/passwd`.
 */
function pathParts(word: string): string[] {
  const parts = [word, ...word.split('=')];
  const short = /^-([A-Za-z]+)(.+)$/.exec(word);
  if (short) for (let at = 1; at <= short[1].length; at++) parts.push(word.slice(at + 1));
  return parts.filter((part) => part !== '' && !part.startsWith('-'));
}

/**
 * True for one command from the read-only set that stays in the scratch copy. Any shell operator,
 * substitution or redirect could chain a second command, so those go to the person, and so does
 * an argument that points outside the copy or a flag that writes or runs something.
 */
export function readOnlyCommand(input: unknown, scratch: string): boolean {
  const call = commandOf(input);
  if (!call) return false;
  if (call.cwd !== null && !inScratch(scratch, call.cwd)) return false;
  return readOnlyWords(shellWords(call.command), scratch, folderOf(scratch, call.cwd), true);
}

/** The command line and folder a client sends, by either spelling of the field names. */
function commandOf(input: unknown): { command: string; cwd: string | null } | null {
  if (!input || typeof input !== 'object') return null;
  // Clients name the fields differently: command and cwd, or CommandLine and Cwd.
  const fields = new Map(
    Object.entries(input as Record<string, unknown>).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  const command = fields.get('command') ?? fields.get('commandline');
  const cwd = fields.get('cwd');
  if (typeof command !== 'string' || (cwd != null && typeof cwd !== 'string')) return null;
  return { command, cwd: cwd ?? null };
}

/** The folder relative arguments start from: the command's own folder, else the copy root. */
const folderOf = (scratch: string, cwd: string | null) =>
  cwd === null ? scratch : resolve(scratch, cwd);

// rg and find follow links out of the copy with these, and grep with -R.
const FOLLOWS: Record<string, RegExp> = {
  rg: /^(--follow$|-[A-Za-z]*L)/,
  find: /^(-L$|-H$|-follow$)/,
  grep: /^(--dereference-recursive$|-[A-Za-z]*R)/,
};

/**
 * Whether a word names only paths inside the copy. A relative part starts from the command's
 * folder, and every part goes through the copy rules, links included.
 */
function wordInside(word: string, scratch: string, folder: string): boolean {
  return pathParts(word).every(
    (part) => !part.startsWith('~') && inScratch(scratch, resolve(folder, part)),
  );
}

function readOnlyWords(
  words: string[] | null,
  scratch: string,
  folder: string,
  outer: boolean,
): boolean {
  if (!words?.length) return false;
  const [program, ...rest] = words;
  const name = program.split('/').at(-1) ?? '';
  if (outer && SHELLS.has(name) && rest.length === 2 && (rest[0] === '-c' || rest[0] === '-lc'))
    return readOnlyWords(shellWords(rest[1]), scratch, folder, false);
  const inside = (word: string) => wordInside(word, scratch, folder);
  if (program === 'sed') {
    const [flag, script, ...files] = rest;
    return flag === '-n' && SED_PRINT.test(script ?? '') && files.length > 0 && files.every(inside);
  }
  if (program === 'git' ? !READ_ONLY_GIT.has(rest[0] ?? '') : !READ_ONLY_COMMANDS.has(program))
    return false;
  const follows = FOLLOWS[program];
  return rest.every((word) => !WRITING_FLAGS.test(word) && !follows?.test(word) && inside(word));
}

/**
 * The paths a command line names outside the scratch copy, in any command it runs, so a turn
 * that runs commands without a question can be stopped when one reaches past the copy. Program
 * names are left out, and so is a word that names no path: one with no slash that is not `~`
 * or `..`. Quotes are taken off, every part goes through the copy rules, and a path through a
 * variable counts as outside.
 */
export function outsidePaths(input: unknown, scratch: string): string[] {
  const call = commandOf(input);
  if (!call) return [];
  const found = new Set<string>();
  if (call.cwd !== null && !inScratch(scratch, call.cwd)) found.add(call.cwd);
  const folder = folderOf(scratch, call.cwd);
  const visit = (line: string) => {
    for (const segment of line.split(/[;&|()\n`]+|\$\(/)) {
      const words = segment.replace(/[<>]/g, ' ').match(/"[^"]*"|'[^']*'|[^\s"']+/g);
      if (!words) continue;
      const [, ...rest] = words.map((word) => word.replace(/^["']|["']$/g, ''));
      const name =
        (words[0] ?? '')
          .replace(/^["']|["']$/g, '')
          .split('/')
          .at(-1) ?? '';
      if (SHELLS.has(name) && (rest[0] === '-c' || rest[0] === '-lc') && rest[1] !== undefined) {
        visit(rest.slice(1).join(' '));
        continue;
      }
      for (const word of rest) {
        if (word.includes(' ')) {
          visit(word);
          continue;
        }
        const path = /\//.test(word) || word.startsWith('~') || word === '..';
        // A variable can name any folder, so a path through one counts as outside.
        if (path && (word.includes('$') || !wordInside(word, scratch, folder))) found.add(word);
      }
    }
  };
  visit(call.command);
  return [...found];
}

/**
 * The words the shell hands the program, or null when the command holds anything the shell
 * would act on: an operator, a redirect, a glob, a variable or an escape outside quotes.
 */
function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word: string | null = null;
  let rest = command.trim();
  while (rest) {
    const space = /^[ \t]+/.exec(rest);
    if (space) {
      if (word !== null) words.push(word);
      word = null;
      rest = rest.slice(space[0].length);
      continue;
    }
    const piece = WORD_PIECE.exec(rest)?.[0];
    if (!piece) return null;
    const quoted = piece.startsWith("'") || piece.startsWith('"');
    word = (word ?? '') + (quoted ? piece.slice(1, -1) : piece);
    rest = rest.slice(piece.length);
  }
  if (word !== null) words.push(word);
  return words;
}

// Programs a read-only turn on the wide sandbox may run, each one reading only the paths it is
// given. Anything else, a script in the copy included, could read past it.
const SCRATCH_PROGRAMS = new Set([
  ...READ_ONLY_COMMANDS,
  'sed',
  'git',
  'pwd',
  'echo',
  'printf',
  'true',
  'false',
  'nl',
  'uniq',
  'cut',
  'tr',
  'diff',
  'stat',
  'file',
  'tree',
  'du',
]);
// The client runs each command through its own shell wrapper, such as `/bin/zsh -lc "..."`. The
// wrapper is taken off once; a shell inside it could run anything.
const WRAPPER = /^\s*(?:\/[\w./-]*\/)?(?:sh|bash|zsh)\s+-l?c\s+([\s\S]+)$/;
// Anything that can move the command out of the folder it was given, or run a second program
// the words do not show: a variable or substitution, a home or parent path, a change of folder,
// a nested shell or a program that runs its arguments.
const MOVES = /[$`]|~|\.\./;
const RUNNERS = new Set([
  'cd',
  'pushd',
  'popd',
  'eval',
  'env',
  'exec',
  'source',
  'command',
  'builtin',
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'xargs',
]);

/** The script inside the client's shell wrapper, unquoted, or the command when it has none. */
function unwrapped(command: string): string {
  const inner = WRAPPER.exec(command)?.[1]?.trim();
  if (inner === undefined) return command;
  if (/^'[^']*'$/.test(inner)) return inner.slice(1, -1);
  if (/^"(?:[^"\\]|\\.)*"$/.test(inner)) return inner.slice(1, -1).replace(/\\(["\\])/g, '$1');
  return inner;
}

/**
 * True only for a command that provably reads inside the scratch copy, for a read-only turn on a
 * sandbox that can read the whole disk. The command runs in a folder inside the copy, names no
 * variable, home or parent path and changes no folder, runs no nested shell or argument runner,
 * and every absolute path and every word it names resolves inside the copy.
 */
export function scratchCommand(input: unknown, scratch: string): boolean {
  const call = commandOf(input);
  if (!call || call.cwd === null || !inScratch(scratch, call.cwd)) return false;
  const script = unwrapped(call.command);
  if (!script.trim() || MOVES.test(script)) return false;
  const folder = folderOf(scratch, call.cwd);
  const words = script
    .split(/[\s;&|()<>]+/)
    .map((word) => word.replace(/["']/g, ''))
    .filter(Boolean);
  if (words.some((word) => RUNNERS.has(word.split('/').at(-1) ?? ''))) return false;
  // `2>&1` joins two outputs and starts no command, so only an `&` after no redirect splits.
  for (const segment of script.split(/(?<![<>])[;&|]+|[()\n]+/)) {
    const [program, ...rest] = segment
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(/["']/g, ''));
    if (!program) continue;
    if (!SCRATCH_PROGRAMS.has(program)) return false;
    if (program === 'git' && !READ_ONLY_GIT.has(rest[0] ?? '')) return false;
    // sed runs programs through its e command, so it counts only as `sed -n` with a line range.
    if (program === 'sed' && !(rest[0] === '-n' && SED_PRINT.test(rest[1] ?? ''))) return false;
    if (rest.some((word) => WRITING_FLAGS.test(word) || FOLLOWS[program]?.test(word))) return false;
  }
  // An absolute path anywhere in a word, such as `--file=/etc/hosts` or `-f/etc/hosts`. Output
  // sent to /dev/null reads nothing.
  const absolute = [...script.matchAll(/(?:^|[^\w.-])(\/[^\s'";&|()<>]*)/g)].map(
    (match) => match[1],
  );
  return (
    absolute.every((path) => path === '/dev/null' || inScratch(scratch, path)) &&
    words.every(
      (word) => /^\d*&\d*$/.test(word) || word === '/dev/null' || wordInside(word, scratch, folder),
    )
  );
}
