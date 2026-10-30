import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CLI_EXIT, type ExportFormat } from '@crewkite/contracts';
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
    if (values.help || positionals.length === 0) {
      await io.out(exportHelp);
      return 0;
    }
    if (positionals.length > 1) throw new UsageError('Give one thread ID.');
    const targets = FORMATS.flatMap(([flag, format]) => {
      const path = values[flag as 'markdown' | 'html'];
      return path === undefined ? [] : [{ format, path: resolve(path) }];
    });
    if (targets.length === 0) throw new UsageError('Give --markdown path, --html path or both.');
    client = await connect(crewkiteHome(values.home));
    for (const { format, path } of targets) {
      const exported = await client.exportThread(positionals[0], format);
      try {
        // The exclusive flag also refuses a link at the path.
        writeFileSync(path, exported.content, { flag: 'wx', mode: 0o600 });
      } catch (failure) {
        throw new UsageError(
          (failure as NodeJS.ErrnoException).code === 'EEXIST'
            ? `${path} already exists. Choose a new file name.`
            : `${path} could not be written. Choose another place.`,
        );
      }
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
