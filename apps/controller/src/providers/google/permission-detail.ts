import { isAbsolute, relative, resolve } from 'node:path';

// The detail line under a permission question. A command request shows the command line and the
// folder it runs in, relative to the scratch copy, since the client's own request fields (timeouts,
// flags) say nothing the person decides on. Any other request shows its paths and its input.

const MAXIMUM = 4000;
const clip = (value: string) =>
  value.length > MAXIMUM ? `${value.slice(0, MAXIMUM - 1)}…` : value;

const field = (input: Record<string, unknown>, names: readonly string[]) => {
  for (const name of names) {
    const value = input[name];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string'))
      return value.join(' ');
  }
  return null;
};

/** The folder a command runs in, as the person knows it: inside the scratch copy, or as given. */
function folderLine(cwd: string | null, scratch: string): string | null {
  if (cwd === null) return null;
  const inside = relative(scratch, isAbsolute(cwd) ? cwd : resolve(scratch, cwd));
  if (inside === '') return 'Folder: scratch copy';
  if (inside.startsWith('..') || isAbsolute(inside)) return `Folder: ${cwd}`;
  return `Folder: ${inside.split('\\').join('/')}`;
}

export function permissionDetail(
  rawInput: unknown,
  paths: ReadonlySet<string>,
  scratch: string,
): string | null {
  if (rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const input = rawInput as Record<string, unknown>;
    const command = field(input, ['CommandLine', 'commandLine', 'command', 'cmd']);
    if (command !== null) {
      const folder = folderLine(field(input, ['Cwd', 'cwd', 'directory', 'workdir']), scratch);
      return clip([command, folder].filter(Boolean).join('\n'));
    }
  }
  const detail = [
    paths.size ? `Paths: ${[...paths].join(', ')}` : '',
    rawInput === undefined ? '' : clip(JSON.stringify(rawInput)),
  ]
    .filter(Boolean)
    .join('\n');
  return detail || null;
}
