import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statfsSync,
} from 'node:fs';
import {
  arch,
  availableParallelism,
  freemem,
  homedir,
  release,
  totalmem,
  type,
  version,
} from 'node:os';
import { join } from 'node:path';
import {
  CliSettingsSchema,
  DIAGNOSTIC_EVENT_BYTES,
  DIAGNOSTIC_EVENTS,
  DIAGNOSTIC_LOG_BYTES,
  DIAGNOSTIC_PARTS,
  type DiagnosticFile,
  type Event,
  type ReadDiagnosticsPayload,
} from '@crewkite/contracts';
import { readControllerLogTail } from './log.ts';
import { redactDiagnosticText, redactDiagnosticValue } from './redact.ts';

// The diagnostics bundle: every listed part, built here from the controller's own home and
// store, redacted before it leaves. The desktop and the CLI write the parts to a folder and add
// nothing.

export type ProviderClientFact = {
  profile: string;
  family: string;
  available: boolean;
  reason: string | null;
  client: { executable: string; sha256: string; version: string } | null;
};

export type DiagnosticsSource = {
  /** The controller home, which holds the log and the CLI settings. */
  home: string;
  controllerVersion: string;
  /** The pinned provider clients the controller already resolved. */
  clients: () => ProviderClientFact[];
  /** The newest events of a thread, oldest first, at most `count`. */
  events: (taskId: string, count: number) => Event[];
  /** The folder that becomes ~ and whose volume the free disk figure describes. */
  userHome?: string;
};

const SETTINGS_FILE = 'cli.json';
const SETTINGS_BYTES = 65536;

function readSettings(home: string): unknown {
  let file: number;
  try {
    file = openSync(
      join(home, SETTINGS_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return { present: false };
  }
  try {
    const state = fstatSync(file);
    if (!state.isFile() || state.size > SETTINGS_BYTES) return { present: true, readable: false };
    const buffer = Buffer.alloc(state.size);
    const count = readSync(file, buffer, 0, state.size, 0);
    // Only fields the schema knows leave. A file with any other field is reported as unreadable,
    // which is also how the CLI treats it.
    const parsed = CliSettingsSchema.safeParse(
      JSON.parse(buffer.subarray(0, count).toString('utf8')),
    );
    return parsed.success
      ? { present: true, settings: parsed.data }
      : { present: true, readable: false };
  } catch {
    return { present: true, readable: false };
  } finally {
    closeSync(file);
  }
}

function systemFacts(userHome: string) {
  let disk: { freeBytes: number; totalBytes: number } | null = null;
  try {
    const state = statfsSync(userHome);
    disk = { freeBytes: state.bavail * state.bsize, totalBytes: state.blocks * state.bsize };
  } catch {}
  return {
    platform: process.platform,
    arch: arch(),
    cpus: availableParallelism(),
    memory: { totalBytes: totalmem(), freeBytes: freemem() },
    disk: disk === null ? null : { volume: 'the volume holding your home folder', ...disk },
  };
}

/** Events as redacted JSON, with the oldest dropped until the text fits its byte bound. */
function eventsText(taskId: string | null, events: Event[], home: string): string {
  let kept = events.map((event) => redactDiagnosticValue(event, home));
  const write = () => `${JSON.stringify({ taskId, count: kept.length, events: kept }, null, 2)}\n`;
  let text = write();
  while (Buffer.byteLength(text) > DIAGNOSTIC_EVENT_BYTES && kept.length > 0) {
    kept = kept.slice(Math.max(1, Math.ceil(kept.length / 10)));
    text = write();
  }
  return text;
}

export function buildDiagnostics(
  source: DiagnosticsSource,
  payload: ReadDiagnosticsPayload = {},
): DiagnosticFile[] {
  const userHome = source.userHome ?? homedir();
  const json = (value: unknown) =>
    `${JSON.stringify(redactDiagnosticValue(value, userHome), null, 2)}\n`;
  let clients: ProviderClientFact[] = [];
  try {
    clients = source.clients();
  } catch {}
  let events: Event[] = [];
  if (payload.taskId) {
    try {
      events = source.events(payload.taskId, DIAGNOSTIC_EVENTS);
    } catch {}
  }
  const log = readControllerLogTail(source.home, DIAGNOSTIC_LOG_BYTES);
  const text: Record<(typeof DIAGNOSTIC_PARTS)[number]['name'], string> = {
    'versions.json': json({
      crewkite: payload.desktop?.app ?? null,
      controller: source.controllerVersion,
      electron: payload.desktop?.electron ?? null,
      chrome: payload.desktop?.chrome ?? null,
      node: process.versions.node,
      os: `${type()} ${release()}`,
      osBuild: version(),
    }),
    'clients.json': json({ clients }),
    'settings.json': json(readSettings(source.home)),
    'controller.log': log
      ? redactDiagnosticText(log, userHome)
      : 'No controller log has been written yet.\n',
    'thread-events.json': eventsText(
      payload.taskId ?? null,
      events.slice(-DIAGNOSTIC_EVENTS),
      userHome,
    ),
    'system.json': json(systemFacts(userHome)),
  };
  return DIAGNOSTIC_PARTS.map((part) => ({
    name: part.name,
    about: part.about,
    text: text[part.name],
  }));
}

/** The version in the controller package, or unknown when the package file is not beside it. */
export function readControllerVersion(): string {
  try {
    const value = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };
    return typeof value.version === 'string' ? value.version.slice(0, 64) : 'unknown';
  } catch {
    return 'unknown';
  }
}
