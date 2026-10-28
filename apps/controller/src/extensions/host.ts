import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  type ChatThreadRead,
  type Command,
  type CommandResult,
  type ConfigureExtensionPayloadSchema,
  EXTENSION_CONTRACT_VERSION,
  type ExtensionCommandOutput,
  ExtensionCommandOutputSchema,
  type ExtensionContext,
  type ExtensionEvent,
  type ExtensionListing,
  type ExtensionManifest,
  type ExtensionSlot,
  type ExtensionsRead,
  type ExtensionThreadView,
  type RunExtensionCommandPayloadSchema,
  type Task,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import type { z } from 'zod';
import { checkManifest } from './manifest.ts';

// The controller side of the extension seam (ADR 0047). Extensions live in folders under
// <home>/extensions. Each one is off until the person turns it on for the exact manifest and
// entry bytes they were shown. A command reaches an extension only through RunExtensionCommand,
// which passes the same principal, schema, receipt and task checks as every built-in command, and
// the extension receives a context that holds only the authority its manifest declared.

const MAX_FOLDERS = 32;
const MAX_MANIFEST_BYTES = 65_536;
const MAX_EVENTS_PER_COMMAND = 4;
const THREAD_MESSAGES = 50;
const MESSAGE_CHARACTERS = 2000;
const ENABLED_FILE = 'enabled.json';

export type ExtensionHandler = (context: ExtensionContext) => unknown;

export type ExtensionHostDeps = {
  home: string;
  task: (taskId: string) => Task | undefined;
  readThread: (taskId: string) => ChatThreadRead;
  emit: (task: Task, event: ExtensionEvent) => void;
};

type Payload<S extends z.ZodType> = z.infer<S>;
type Found = ExtensionListing & { directory: string; entryHash: string | null };

const blocked = (reason: string, next: string): CommandResult => ({
  outcome: 'blocked',
  reason,
  next,
});

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/** A regular file inside the folder, never a link, at most `limit` bytes. */
function regularFile(path: string, limit: number): Buffer | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > limit) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

export class ExtensionHost {
  private readonly loaded = new Map<string, { hash: string; commands: Record<string, unknown> }>();
  private readonly load = createRequire(import.meta.url);

  private readonly deps: ExtensionHostDeps;

  constructor(deps: ExtensionHostDeps) {
    this.deps = deps;
  }

  get directory(): string {
    return join(this.deps.home, 'extensions');
  }

  /** The person's choices: extension ID to the hash of the manifest and entry they turned on. */
  private enabled(): Record<string, string> {
    try {
      const value = JSON.parse(readFileSync(join(this.directory, ENABLED_FILE), 'utf8'));
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
      return Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === 'string' && /^[a-f0-9]{64}$/.test(entry[1]),
        ),
      );
    } catch {
      return {};
    }
  }

  // shortcut: the choices live in one JSON file beside the extensions, written by rename inside
  // the command's transaction, so a crash between the rename and the commit keeps the file's
  // choice. Upgrade: move them into a migration-owned table when the integration owner adds one.
  private saveEnabled(choices: Record<string, string>) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, ENABLED_FILE);
    writeFileSync(`${path}.next`, `${JSON.stringify(choices, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${path}.next`, path);
  }

  private scan(): Found[] {
    let folders: string[];
    try {
      folders = readdirSync(this.directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort()
        .slice(0, MAX_FOLDERS);
    } catch {
      return [];
    }
    const choices = this.enabled();
    return folders.map((folder): Found => {
      const directory = join(this.directory, folder);
      const refused = (refusal: ExtensionListing['refusal'], line: string): Found => ({
        folder,
        state: 'refused',
        refusal,
        line,
        manifest: null,
        manifestHash: null,
        directory,
        entryHash: null,
      });
      const bytes = regularFile(join(directory, 'manifest.json'), MAX_MANIFEST_BYTES);
      let raw: unknown;
      try {
        if (!bytes) throw Error('missing');
        raw = JSON.parse(bytes.toString('utf8'));
      } catch {
        return refused('manifest-unreadable', 'No readable manifest.json in this folder.');
      }
      const checked = checkManifest(raw, folder);
      if (!checked.ok) return refused(checked.refusal, checked.line);
      const entry = regularFile(join(directory, checked.manifest.entry), 16 * 1024 * 1024);
      if (!entry)
        return refused('entry-missing', `The entry file ${checked.manifest.entry} is missing.`);
      const entryHash = createHash('sha256').update(entry).digest('hex');
      // The hash covers the manifest and the entry bytes, so a changed module asks again.
      const manifestHash = hashCanonical({ manifest: checked.manifest, entryHash });
      const chosen = choices[checked.manifest.id];
      return {
        folder,
        state: chosen === manifestHash ? 'on' : chosen ? 'changed' : 'off',
        refusal: null,
        line: chosen && chosen !== manifestHash ? 'Changed since it was turned on. Off.' : null,
        manifest: checked.manifest,
        manifestHash,
        directory,
        entryHash,
      };
    });
  }

  read(): ExtensionsRead {
    const found = this.scan();
    const on = found.filter(
      (item): item is Found & { manifest: ExtensionManifest } =>
        item.state === 'on' && item.manifest !== null,
    );
    const slots: ExtensionSlot[] = on.flatMap(({ manifest }) => [
      ...manifest.settingsCards.map((item) => ({
        slot: 'settings-card' as const,
        extensionId: manifest.id,
        ...item,
      })),
      ...manifest.threadActions.map((item) => ({
        slot: 'thread-action' as const,
        extensionId: manifest.id,
        ...item,
      })),
      ...manifest.inspectorTabs.map((item) => ({
        slot: 'inspector-tab' as const,
        extensionId: manifest.id,
        ...item,
      })),
    ]);
    return {
      contract: EXTENSION_CONTRACT_VERSION,
      extensions: found.map(({ directory: _directory, entryHash: _entry, ...listing }) => listing),
      slots,
      crewRoles: on.flatMap(({ manifest }) =>
        manifest.crewRoles.map((role) => ({ extensionId: manifest.id, ...role })),
      ),
    };
  }

  /** The same revision rule as the thread commands, and revision zero without a thread. */
  checkRevision(
    command: Extract<Command, { command: 'ConfigureExtension' | 'RunExtensionCommand' }>,
  ): CommandResult | undefined {
    if (command.command === 'RunExtensionCommand' && command.payload.taskId) {
      if (!this.deps.task(command.payload.taskId))
        return blocked('task-not-found', 'Choose a registered task.');
      return;
    }
    if (command.expectedRevision !== 0)
      return { outcome: 'stale-revision', revision: 0, next: 'Send revision zero.' };
  }

  configure(payload: Payload<typeof ConfigureExtensionPayloadSchema>): CommandResult {
    const found = this.scan().find((item) => item.manifest?.id === payload.extensionId);
    const choices = this.enabled();
    if (!payload.enabled) {
      if (payload.extensionId in choices) {
        delete choices[payload.extensionId];
        this.saveEnabled(choices);
      }
      return { outcome: 'applied', data: { kind: 'extensions', ...this.read() } };
    }
    if (!found?.manifest || !found.manifestHash)
      return blocked('extension-not-found', 'Read Settings > Extensions again.');
    if (found.manifestHash !== payload.manifestHash)
      return blocked(
        'extension-manifest-changed',
        'The manifest or its module changed. Read it again before turning it on.',
      );
    const module = this.module(found);
    if (module === 'restart')
      return blocked(
        'extension-restart-needed',
        'The module changed after this run loaded it. Restart CrewKite, then turn it on.',
      );
    if (!module)
      return blocked(
        'extension-load-failed',
        'The extension module did not load. It stays off. Check its entry file.',
      );
    choices[payload.extensionId] = payload.manifestHash;
    this.saveEnabled(choices);
    return { outcome: 'applied', data: { kind: 'extensions', ...this.read() } };
  }

  /**
   * Load the entry once per controller run. A changed entry needs a restart, since Node keeps
   * the first copy of a module it loaded.
   */
  private module(found: Found): Record<string, unknown> | 'restart' | null {
    const id = found.manifest?.id;
    if (!id || !found.entryHash) return null;
    const cached = this.loaded.get(id);
    if (cached) return cached.hash === found.entryHash ? cached.commands : 'restart';
    try {
      const loaded = this.load(join(found.directory, found.manifest?.entry ?? '')) as unknown;
      const commands = (loaded as { commands?: unknown } | null)?.commands;
      if (typeof commands !== 'object' || commands === null) return null;
      const table = commands as Record<string, unknown>;
      this.loaded.set(id, { hash: found.entryHash, commands: table });
      return table;
    } catch {
      return null;
    }
  }

  private view(taskId: string): ExtensionThreadView {
    const task = this.deps.task(taskId);
    const read = this.deps.readThread(taskId);
    return deepFreeze({
      taskId,
      title: task?.title ?? '',
      messages: read.messages.slice(-THREAD_MESSAGES).map((message) => ({
        author:
          message.author.kind === 'user'
            ? ('person' as const)
            : message.author.kind === 'assistant'
              ? ('assistant' as const)
              : ('system' as const),
        text: message.text.slice(0, MESSAGE_CHARACTERS),
      })),
    });
  }

  run(payload: Payload<typeof RunExtensionCommandPayloadSchema>): CommandResult {
    const found = this.scan().find((item) => item.manifest?.id === payload.extensionId);
    const manifest = found?.manifest;
    if (!found || !manifest)
      return blocked('extension-not-found', 'Read Settings > Extensions again.');
    if (found.state !== 'on')
      return blocked('extension-off', 'Turn the extension on in Settings > Extensions first.');
    if (!manifest.commands.some((command) => command.id === payload.commandId))
      return blocked('extension-command-unknown', 'The extension does not declare this command.');
    const task = payload.taskId ? this.deps.task(payload.taskId) : undefined;
    if (payload.taskId && !task) return blocked('task-not-found', 'Choose a registered task.');
    const module = this.module(found);
    const handler = typeof module === 'object' ? module?.[payload.commandId] : undefined;
    if (typeof handler !== 'function')
      return blocked(
        'extension-load-failed',
        'The extension module did not load or lacks this command. Restart CrewKite after an update.',
      );
    const granted = new Set(manifest.authority);
    const pending: ExtensionEvent[] = [];
    const taskId = task?.id;
    const context: ExtensionContext = deepFreeze({
      contract: EXTENSION_CONTRACT_VERSION,
      extensionId: manifest.id,
      commandId: payload.commandId,
      input: payload.input ?? null,
      thread: taskId
        ? {
            taskId,
            // The reader takes no argument. It reads the thread the command was run on.
            ...(granted.has('thread.read') ? { read: () => this.view(taskId) } : {}),
          }
        : null,
      ...(taskId && granted.has('thread.event')
        ? {
            emit: (kind: string, output: ExtensionCommandOutput) => {
              if (!manifest.eventKinds.includes(kind))
                throw Error('The manifest does not declare this event kind.');
              if (pending.length >= MAX_EVENTS_PER_COMMAND)
                throw Error('An extension command emits at most four events.');
              pending.push({
                extensionId: manifest.id,
                kind,
                output: ExtensionCommandOutputSchema.parse(output),
              });
            },
          }
        : {}),
    });
    let returned: unknown;
    try {
      returned = (handler as ExtensionHandler)(context);
    } catch {
      return blocked('extension-failed', 'The extension command failed. Nothing changed.');
    }
    if (typeof (returned as { then?: unknown } | null)?.then === 'function') {
      // The command runs inside the controller's transaction, so it has to answer at once.
      void Promise.resolve(returned).catch(() => {});
      return blocked(
        'extension-async-unsupported',
        'Contract 1 runs extension commands synchronously. Update the extension.',
      );
    }
    const output = ExtensionCommandOutputSchema.safeParse(returned);
    if (!output.success)
      return blocked(
        'extension-output-invalid',
        'The extension returned something other than text and rows. Nothing changed.',
      );
    if (task) for (const event of pending) this.deps.emit(task, event);
    return {
      outcome: 'applied',
      data: {
        kind: 'extension-result',
        extensionId: manifest.id,
        commandId: payload.commandId,
        taskId: taskId ?? null,
        output: output.data,
      },
    };
  }
}
