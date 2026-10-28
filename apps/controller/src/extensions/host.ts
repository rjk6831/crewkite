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
// <home>/extensions. Each one is off until the person turns it on for the exact folder they were
// shown: the manifest and the bytes of every file beside it. A command reaches an extension only through RunExtensionCommand,
// which passes the same principal, schema, receipt and task checks as every built-in command, and
// the extension receives a context that holds only the authority its manifest declared.

const MAX_FOLDERS = 32;
const MAX_MANIFEST_BYTES = 65_536;
const MAX_EVENTS_PER_COMMAND = 4;
const THREAD_MESSAGES = 50;
const MESSAGE_CHARACTERS = 2000;
const ENABLED_FILE = 'enabled.json';
/** A folder holds at most this many regular files and bytes, links and special files refused. */
export const MAX_FOLDER_FILES = 256;
export const MAX_FOLDER_BYTES = 16 * 1024 * 1024;

export type ExtensionHandler = (context: ExtensionContext) => unknown;

export type ExtensionHostDeps = {
  home: string;
  task: (taskId: string) => Task | undefined;
  readThread: (taskId: string) => ChatThreadRead;
  emit: (task: Task, event: ExtensionEvent) => void;
};

type Payload<S extends z.ZodType> = z.infer<S>;
type Found = ExtensionListing & { directory: string; folderHash: string | null };
type FileStat = { path: string; size: number; mtime: number; ctime: number; inode: number };

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

/**
 * Every regular file under the folder, sorted by relative path, or null when the folder holds a
 * link, a special file or more than the bounds allow.
 */
function folderFiles(root: string): FileStat[] | null {
  const files: FileStat[] = [];
  let bytes = 0;
  const walk = (relative: string): boolean => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(join(root, path), { bigint: false });
      if (stat.isDirectory()) {
        if (!walk(path)) return false;
        continue;
      }
      if (!stat.isFile()) return false;
      bytes += stat.size;
      if (files.length >= MAX_FOLDER_FILES || bytes > MAX_FOLDER_BYTES) return false;
      files.push({
        path,
        size: stat.size,
        mtime: stat.mtimeMs,
        ctime: stat.ctimeMs,
        inode: stat.ino,
      });
    }
    return true;
  };
  try {
    return walk('') ? files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) : null;
  } catch {
    return null;
  }
}

/** SHA-256 over each relative path, its size and its bytes, in path order. */
function hashFiles(root: string, files: readonly FileStat[]): string | null {
  const hash = createHash('sha256');
  try {
    for (const file of files) {
      const bytes = readFileSync(join(root, file.path));
      if (bytes.length !== file.size) return null;
      hash.update(`${file.path}\0${file.size}\0`);
      hash.update(bytes);
    }
  } catch {
    return null;
  }
  return hash.digest('hex');
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
  // One record per extension this run tried to load. Commands are null when the load failed or
  // the folder changed during it, so any later attempt in this run asks for a restart.
  private readonly loaded = new Map<
    string,
    { hash: string | null; commands: Record<string, unknown> | null }
  >();
  // Folder hashes by the stat of every file, so reads and runs do not hash unchanged bytes again.
  private readonly hashes = new Map<string, { key: string; hash: string }>();
  private readonly load = createRequire(import.meta.url);

  private readonly deps: ExtensionHostDeps;

  constructor(deps: ExtensionHostDeps) {
    this.deps = deps;
  }

  get directory(): string {
    return join(this.deps.home, 'extensions');
  }

  /** The person's choices: extension ID to the hash of the folder they turned on. */
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

  // shortcut: the choices live in one JSON file beside the extensions, written by rename as an
  // effect after the command's commit, so a crash between the commit and the rename loses the
  // choice and the receipt still says applied. Upgrade: move them into a migration-owned table
  // when the integration owner adds one.
  private saveEnabled(choices: Record<string, string>) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, ENABLED_FILE);
    writeFileSync(`${path}.next`, `${JSON.stringify(choices, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${path}.next`, path);
  }

  /** The folder's hash, from the cache while every file's stat is unchanged. */
  private folderHash(directory: string, fresh = false): string | null {
    const files = folderFiles(directory);
    if (!files) return null;
    const key = JSON.stringify(files);
    const cached = this.hashes.get(directory);
    if (!fresh && cached?.key === key) return cached.hash;
    const hash = hashFiles(directory, files);
    if (hash) this.hashes.set(directory, { key, hash });
    else this.hashes.delete(directory);
    return hash;
  }

  private folders(): string[] {
    try {
      return readdirSync(this.directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort()
        .slice(0, MAX_FOLDERS);
    } catch {
      return [];
    }
  }

  private scan(choices = this.enabled()): Found[] {
    return this.folders().map((folder) => this.inspect(folder, choices));
  }

  /** One extension by ID, without reading any other folder. */
  private one(id: string): Found | undefined {
    if (!this.folders().includes(id)) return;
    const found = this.inspect(id, this.enabled());
    return found.manifest?.id === id ? found : undefined;
  }

  private inspect(folder: string, choices: Record<string, string>): Found {
    const directory = join(this.directory, folder);
    const refused = (refusal: ExtensionListing['refusal'], line: string): Found => ({
      folder,
      state: 'refused',
      refusal,
      line,
      manifest: null,
      manifestHash: null,
      directory,
      folderHash: null,
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
    if (!regularFile(join(directory, checked.manifest.entry), MAX_FOLDER_BYTES))
      return refused('entry-missing', `The entry file ${checked.manifest.entry} is missing.`);
    const folderHash = this.folderHash(directory);
    if (!folderHash)
      return refused(
        'folder-unsupported',
        `The folder holds a link, a special file, more than ${MAX_FOLDER_FILES} files or more than 16 MiB.`,
      );
    // The hash covers the manifest and every file in the folder, so changed code asks again.
    const manifestHash = hashCanonical({ manifest: checked.manifest, folderHash });
    const chosen = choices[checked.manifest.id];
    return {
      folder,
      state: chosen === manifestHash ? 'on' : chosen ? 'changed' : 'off',
      refusal: null,
      line: chosen && chosen !== manifestHash ? 'Changed since it was turned on. Off.' : null,
      manifest: checked.manifest,
      manifestHash,
      directory,
      folderHash,
    };
  }

  read(choices = this.enabled()): ExtensionsRead {
    const found = this.scan(choices);
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
      extensions: found.map(({ directory: _directory, folderHash: _hash, ...listing }) => listing),
      slots,
      crewRoles: on.flatMap(({ manifest }) =>
        manifest.crewRoles.map((role) => ({ extensionId: manifest.id, ...role })),
      ),
    };
  }

  /**
   * On a thread, the task must exist and the revision is not compared, the rule the chat
   * commands use. Without a thread, and for ConfigureExtension, the revision must be zero.
   */
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

  /** The choice is written by an effect after the command commits. */
  configure(
    payload: Payload<typeof ConfigureExtensionPayloadSchema>,
    effects: (() => void)[],
  ): CommandResult {
    const choices = this.enabled();
    const applied = (next: Record<string, string>): CommandResult => {
      effects.push(() => this.saveEnabled(next));
      return { outcome: 'applied', data: { kind: 'extensions', ...this.read(next) } };
    };
    if (!payload.enabled) {
      if (!(payload.extensionId in choices))
        return { outcome: 'applied', data: { kind: 'extensions', ...this.read(choices) } };
      const { [payload.extensionId]: _off, ...rest } = choices;
      return applied(rest);
    }
    const found = this.one(payload.extensionId);
    if (!found?.manifest || !found.manifestHash)
      return blocked('extension-not-found', 'Read Settings > Extensions again.');
    if (found.manifestHash !== payload.manifestHash)
      return blocked(
        'extension-manifest-changed',
        'The manifest or a file beside it changed. Read it again before turning it on.',
      );
    const module = this.module(found);
    if (module === 'restart')
      return blocked(
        'extension-restart-needed',
        'The extension changed after this run loaded it. Restart CrewKite, then turn it on.',
      );
    if (module === 'changed')
      return blocked(
        'extension-changed-while-loading',
        'A file in the extension changed while it loaded. It stays off. Restart CrewKite, then turn it on.',
      );
    if (!module)
      return blocked(
        'extension-load-failed',
        'The extension module did not load. It stays off. Check its entry file.',
      );
    return applied({ ...choices, [payload.extensionId]: payload.manifestHash });
  }

  /**
   * Load the entry once per controller run, then hash the folder again from disk. A changed
   * folder needs a restart, since Node keeps the first copy of a module it loaded.
   */
  private module(found: Found): Record<string, unknown> | 'restart' | 'changed' | null {
    const id = found.manifest?.id;
    if (!id || !found.folderHash) return null;
    const cached = this.loaded.get(id);
    if (cached) return cached.hash === found.folderHash ? cached.commands : 'restart';
    let table: Record<string, unknown> | null = null;
    try {
      const loaded = this.load(join(found.directory, found.manifest?.entry ?? '')) as unknown;
      const commands = (loaded as { commands?: unknown } | null)?.commands;
      if (typeof commands === 'object' && commands !== null)
        table = commands as Record<string, unknown>;
    } catch {
      table = null;
    }
    if (this.folderHash(found.directory, true) !== found.folderHash) {
      this.loaded.set(id, { hash: null, commands: null });
      return 'changed';
    }
    this.loaded.set(id, { hash: found.folderHash, commands: table });
    return table;
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
    const found = this.one(payload.extensionId);
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
    // The reader and the emitter work only while the command runs. A kept context is inert.
    let live = true;
    const alive = () => {
      if (!live) throw Error('The command that received this context has returned.');
    };
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
            ...(granted.has('thread.read')
              ? {
                  read: () => {
                    alive();
                    return this.view(taskId);
                  },
                }
              : {}),
          }
        : null,
      ...(taskId && granted.has('thread.event')
        ? {
            emit: (kind: string, output: ExtensionCommandOutput) => {
              alive();
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
    let output: ExtensionCommandOutput;
    try {
      const returned = (handler as ExtensionHandler)(context);
      if (typeof (returned as { then?: unknown } | null)?.then === 'function') {
        // The command runs inside the controller's transaction, so it has to answer at once.
        void Promise.resolve(returned).catch(() => {});
        return blocked(
          'extension-async-unsupported',
          'Contract 1 runs extension commands synchronously. Update the extension.',
        );
      }
      const parsed = ExtensionCommandOutputSchema.safeParse(returned);
      if (!parsed.success)
        return blocked(
          'extension-output-invalid',
          'The extension returned something other than text and rows. Nothing changed.',
        );
      output = parsed.data;
    } catch {
      return blocked('extension-failed', 'The extension command failed. Nothing changed.');
    } finally {
      live = false;
    }
    if (task) for (const event of pending) this.deps.emit(task, event);
    return {
      outcome: 'applied',
      data: {
        kind: 'extension-result',
        extensionId: manifest.id,
        commandId: payload.commandId,
        taskId: taskId ?? null,
        output,
      },
    };
  }
}
