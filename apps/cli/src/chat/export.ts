import { closeSync, fsyncSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CLI_EXIT, type ExportFormat, TaskIdSchema } from '@crewkite/contracts';
import { crewkiteHome } from '../settings.ts';
import { type ChatClient, CommandRefused } from './client.ts';
import { type Connect, type Io, notDone, terminalText, UsageError } from './scripting.ts';

// `crewkite export <thread> --markdown path` and `--html path`. The controller renders the text.
// This command writes it to a new file and uploads nothing.

export const exportHelp = `Usage: crewkite export <task-id> [--markdown path] [--html path] [--home path]

--markdown writes the thread as Markdown with each tool call folded to one line.
--html writes a read-only page with secrets, email addresses and home folders redacted, no
script and no network request. Each path names a new file; an existing file is never replaced.
`;

const FORMATS: readonly [string, ExportFormat][] = [
  ['markdown', 'markdown'],
  ['html', 'html'],
];

export async function runExportCommand(args: string[], io: Io, connect: Connect): Promise<number> {
  let client: ChatClient | undefined;
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        markdown: { type: 'string' },
        html: { type: 'string' },
        home: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      await io.out(exportHelp);
      return 0;
    }
    if (positionals.length === 0) throw new UsageError('Give the thread ID. Use --help.');
    if (positionals.length > 1) throw new UsageError('Give one thread ID.');
    const taskId = TaskIdSchema.safeParse(positionals[0]);
    if (!taskId.success)
      throw new UsageError('That is not a thread ID. List them with thread list.');
    const targets = FORMATS.flatMap(([flag, format]) => {
      const path = values[flag as 'markdown' | 'html'];
      return path === undefined ? [] : [{ format, path: resolve(path) }];
    });
    if (targets.length === 0) throw new UsageError('Give --markdown path, --html path or both.');
    // Both files are created before the controller is asked for anything. The exclusive flag
    // refuses a file or a link already at a path, so a path that is taken stops the command with
    // nothing read and nothing replaced. A failure later removes the files this run made.
    const made: { path: string; file: number }[] = [];
    try {
      for (const { path } of targets) {
        try {
          made.push({ path, file: openSync(path, 'wx', 0o600) });
        } catch (failure) {
          throw new UsageError(
            (failure as NodeJS.ErrnoException).code === 'EEXIST'
              ? `${path} already exists. Choose a new file name.`
              : `${path} could not be written. Choose another place.`,
          );
        }
      }
      client = await connect(crewkiteHome(values.home));
      for (const [index, { format, path }] of targets.entries()) {
        const exported = await client.exportThread(taskId.data, format);
        writeFileSync(made[index].file, exported.content);
        fsyncSync(made[index].file);
        await io.out(
          `Wrote ${path} (${exported.turns} ${exported.turns === 1 ? 'turn' : 'turns'}).\n`,
        );
        if (exported.omitted > 0)
          io.err(`${exported.omitted} earlier messages did not fit and are not in the file.\n`);
        if (format === 'html')
          io.err(
            'Redaction matches known patterns and can miss others. Read the page before you share it.\n',
          );
      }
    } catch (error) {
      for (const { path, file } of made.splice(0)) {
        try {
          closeSync(file);
        } catch {}
        try {
          unlinkSync(path);
        } catch {}
      }
      throw error;
    } finally {
      for (const { file } of made) {
        try {
          closeSync(file);
        } catch {}
      }
    }
    return 0;
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : 'The export could not run.';
    io.err(`${terminalText(message)}\n`);
    return notDone(error) || error instanceof CommandRefused ? CLI_EXIT.notDone : CLI_EXIT.failed;
  } finally {
    client?.transport.close();
  }
}
