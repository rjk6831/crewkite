# Extensions

An extension is a module that adds commands, event kinds, settings cards, thread actions, inspector tabs and crew roles to CrewKite through one versioned seam. CrewKite itself stays Apache 2.0. A separately licensed module can live in its own repository and attach through this seam. [ADR 0047](adr/0047-extensions-attach-through-one-versioned-seam.md) records the decision.

## What enabling an extension means

An extension is code. When you turn one on, the controller loads its entry module into the controller process, and that code runs as you, with your user permissions. It can do anything a program you run yourself can do on this machine. Turning an extension on is your choice, and CrewKite asks before it loads one.

What the seam controls is what CrewKite hands the extension:

- Every extension is off by default. A new folder, or a changed manifest or module, stays off until you turn it on in Settings > Extensions.
- Turning one on names the hash of the folder you were shown: the manifest and every regular file in the folder, by sorted relative path, size and bytes. A later change to any file, a new file or a removed one turns it off again with the line "Changed since it was turned on. Off."
- After loading the module the controller hashes the folder again from disk. A file that changed during the load keeps the extension off until a restart.
- An extension command runs only through `RunExtensionCommand`. That command passes the same checks as every built-in command: the authenticated local owner, the shared command schema, the idempotency receipt and the task check.
- The command receives a frozen context. It holds the thread it was run on and only the authority its manifest lists. The thread reader takes no argument and always reads that one thread. The reader and the emitter stop working when the command returns, so a context the module keeps reads and emits nothing.
- No authority reaches another thread, the scratch copy, your repository, settings, budgets, queues or limits. There is no API for them, and a result that carries extra fields is refused.
- What an extension returns is shown as plain text and label rows. Clients never render it as markup.

These rules bind the seam. They do not contain the code: a module that imports Node's file system can read files as you, the same as any other program you install. Turn on only extensions whose source you trust.

## Where extensions live

Each extension is a folder under the controller home:

```text
<CrewKite home>/extensions/
  enabled.json          your on and off choices, written by the controller
  thread-stats/
    manifest.json
    index.mjs
```

The folder name must equal the manifest `id`. The controller lists at most 32 folders and reads a manifest of at most 64 KiB. A folder may hold subfolders and at most 256 regular files with at most 16 MiB in all. A folder with a link, a special file or more than those bounds is refused with `folder-unsupported`. There is no network install. You copy a folder in, then turn it on in Settings > Extensions, which shows the manifest and the authority it asks for.

## The manifest

```json
{
  "id": "thread-stats",
  "name": "Thread stats",
  "version": "1.0.0",
  "contract": "1.0.0",
  "description": "Counts the recent messages in a thread by author.",
  "entry": "index.mjs",
  "authority": ["thread.read"],
  "commands": [{ "id": "count-messages", "title": "Count messages" }],
  "threadActions": [{ "id": "count", "title": "Count messages", "command": "count-messages" }]
}
```

| Field | Meaning |
|-------|---------|
| `id` | Lower-case kebab name, the same as the folder |
| `name` | Shown in Settings, up to 80 characters |
| `version` | The extension's own version, three numbers such as `1.2.0` |
| `contract` | The extension contract version it targets, such as `1.0.0` |
| `entry` | A `.mjs` or `.js` file in the folder that exports `commands` |
| `authority` | What it asks for, from the closed list below |
| `commands` | Up to 32 commands, each with an `id` and a `title` |
| `eventKinds` | Up to 32 event kinds it may emit. Needs `thread.event` |
| `settingsCards`, `threadActions`, `inspectorTabs` | Slots, each with an `id`, a `title` and the `command` it runs |
| `crewRoles` | Up to 4 roles with an `id`, a `title` and a `brief` |

`ExtensionManifestSchema` in `packages/contracts/src/extensions.ts` is the exact shape. A manifest with an unknown field is refused.

### Authority

| Authority | What the context gains |
|-----------|------------------------|
| `thread.read` | `context.thread.read()`: the thread's title and its last 50 messages, each cut to 2,000 characters, with the author as person, assistant or system |
| `thread.event` | `context.emit(kind, output)`: at most four events per command, of kinds the manifest declares, on the thread the command ran on |

A manifest that names any other authority is refused with "The manifest asks for authority CrewKite does not have". An extension with no authority still runs its commands; its context then holds the command, the input and the thread ID.

## The module

The entry exports `commands`, an object keyed by command ID. Each command takes the context and returns its output synchronously:

```js
export const commands = {
  'count-messages': (context) => {
    const thread = context.thread.read();
    return { text: `This thread has ${thread.messages.length} recent messages.` };
  },
};
```

The output is `{ text, rows? }`: up to 4,000 characters of text and up to 32 rows of a label and a value. `ExtensionContext` and `ExtensionCommandOutputSchema` in the contracts package type both. A command runs inside the controller's command transaction, so contract 1 refuses a command that returns a promise. A command that throws or returns another shape changes nothing and returns `extension-failed` or `extension-output-invalid`.

The controller loads a module once per run. A changed file in the folder turns the extension off until you turn it on again. When this run already tried to load the extension, whether the load worked or failed, restart CrewKite first, since Node keeps the first copy of a module it loaded.

## Slots

The desktop reads the slots with `ReadExtensions`. The CLI reads the same slots once its interactive client lands. A slot is data: the extension, its own ID, a title and the command it runs. Clients run no extension code.

| Slot | Where it shows | What it runs |
|------|----------------|--------------|
| `settings-card` | A row in Settings > Extensions with a Run button | Its command with no thread |
| `thread-action` | A button in the thread's top bar | Its command on that thread |
| `inspector-tab` | A tab in the thread inspector | Its command on that thread when the tab opens and on Refresh |

Slots appear only for extensions that are on. `ExtensionSlotSchema` types them for every client. Crew roles an extension declares are listed in the same read. The crew chain of [ADR 0038](adr/0038-crew-and-flight-modes.md) does not schedule them in contract 1; a role runs through the extension's own commands.

## Commands

| Command | Contract |
|---------|----------|
| `ReadExtensions` | List every folder with its state, refusal line, manifest and hash, the slots and crew roles of extensions that are on |
| `ConfigureExtension` | Turn one extension on or off. Turning on names the manifest hash you were shown and loads the module once to check it |
| `RunExtensionCommand` | Run one declared command, on a thread or with none, and return its output. A retry with the same key answers from its receipt |

An extension's events reach clients as `extension.event`, with the extension ID, the declared kind and the output.

## Compatibility

This build offers extension contract `1.0.0`, `EXTENSION_CONTRACT_VERSION` in the contracts package.

- A manifest whose contract major differs from this build's major is turned off with one plain line, for example "Built for extension contract 2.x. This CrewKite offers 1.x, so it stays off until the extension is updated." A CrewKite release that bumps the contract major therefore turns every older extension off until its author updates it.
- A manifest that targets a newer minor of the same major is refused with "Update CrewKite to use it."
- A manifest that targets the same or an older minor of the same major loads.
- A minor bump only adds fields or authority. A change that removes or changes what an existing extension relies on is a major bump.

## The reference extension

`packages/testkit/src/extensions/thread-stats` is the reference for a separate extension repository. It asks for `thread.read` only and adds one thread action, Count messages, that counts a thread's recent messages by author. The tests copy it into a controller home with `installSampleExtension` from `@crewkite/testkit/extensions`.
