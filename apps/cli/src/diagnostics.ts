import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { writeDiagnosticsFolder } from '@crewkite/client/node';
import { CLI_EXIT } from '@crewkite/contracts';
import type { Connect, Io } from './chat/scripting.ts';
import { notDone, terminalText, UsageError } from './chat/scripting.ts';
import { crewkiteHome } from './settings.ts';

export const diagnosticsHelp = `Usage: crewkite diagnostics export <folder> [--thread task-id] [--home path]

Writes a new folder with versions, the pinned provider client digests, saved settings, the end of
the controller log, the last 200 events of the thread named by --thread, system facts, and the
Google setup state with its recent client operations. Secrets, your home folder and email
addresses are removed. The folder must not exist yet. Nothing is sent anywhere.
`;

/** `crewkite diagnostics export <folder>`: the same bundle the desktop's Settings exports. */
export async function runDiagnosticsCommand(
  args: string[],
  io: Io,
  connect: Connect,
): Promise<number> {
  let client: Awaited<ReturnType<Connect>> | undefined;
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        thread: { type: 'string' },
        home: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help || positionals.length === 0) {
      await io.out(diagnosticsHelp);
      return 0;
    }
    const [action, folder, ...extra] = positionals;
    if (action !== 'export' || !folder || extra.length > 0)
      throw new UsageError('Use crewkite diagnostics export <folder>.');
    client = await connect(crewkiteHome(values.home));
    const read = await client.readDiagnostics(values.thread);
    writeDiagnosticsFolder(read.files, resolve(folder));
    await io.out(
      `Wrote ${read.files.length} files to ${resolve(folder)}:\n${read.files
        .map((file) => `  ${file.name}  ${file.about}`)
        .join('\n')}\n`,
    );
    return 0;
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : 'The command could not run.';
    io.err(`${terminalText(message)}\n`);
    return notDone(error) ? CLI_EXIT.notDone : CLI_EXIT.failed;
  } finally {
    client?.transport.close();
  }
}
