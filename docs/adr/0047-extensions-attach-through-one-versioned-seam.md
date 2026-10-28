# 0047. Extensions attach through one versioned seam and receive no authority by default

- Status: Proposed
- Date: 2026-10-28

## Context

I want to sell premium features without closing the product. [ADR 0018](0018-apache-2-license.md) keeps CrewKite under Apache 2.0, so a paid feature cannot live in this repository. It needs a separate module under its own license that attaches to the controller and the desktop at runtime.

Anything that attaches at runtime is a second author of controller behavior. [ADR 0002](0002-authority-in-deterministic-code.md) keeps permissions, limits, task ownership and acceptance in one controller. A plugin interface that hands a module the store, the chat service or the command dispatcher would let it bypass every one of those checks. [ADR 0044](0044-thread-tools-over-one-controller-owned-mcp-server.md) already keeps code nobody chose for a turn out of it.

An extension is still code. Once loaded into the controller process it runs as me. No interface can stop a module from importing the file system.

## Decision

Extensions attach through one seam, typed in `packages/contracts/src/extensions.ts` and served by `apps/controller/src/extensions/`. [Extensions](../extensions.md) is the reference.

- An extension is a folder under `<home>/extensions` with a `manifest.json` and an entry module. The manifest names the extension, its version, the contract version it targets, the authority it asks for and what it adds: commands, event kinds, settings cards, thread actions, inspector tabs and crew roles.
- The controller validates each manifest. A version that is not three numbers, an authority outside the closed list, a contract major other than this build's, a newer contract minor, an unknown field or a folder that names another extension is refused with one plain line.
- Every extension is off by default. Turning one on in Settings > Extensions names the hash the person was shown, and loads the module once to check it. The hash covers the manifest and every regular file in the folder, by sorted relative path, size and bytes. A folder with a link, a special file, more than 256 files or more than 16 MiB is refused. A later change to any file turns the extension off. After the load the controller hashes the folder again from disk and keeps the extension off when it differs.
- The authority list is closed and small: `thread.read` reads a bounded copy of the thread the command runs on, and `thread.event` adds the extension's own declared event kinds to that thread. Nothing else exists. There is no authority for another thread, the scratch copy, the repository, settings, budgets, queues or limits.
- An extension command runs only through `RunExtensionCommand`. It passes the same path as every built-in command: the authenticated local owner, the shared schema, the idempotency receipt and the task check. The controller then builds a frozen context with the declared authority, calls the command synchronously inside the command's transaction, validates the output as text and label rows, and emits declared events only after the output passes. The reader and the emitter stop working when the command returns.
- Slots for the desktop, and for the CLI once its interactive client lands, are data: an extension, an ID, a title and the command it runs. Clients show the title and the returned text and run no extension code.
- The contract has a version, `EXTENSION_CONTRACT_VERSION`, now 1.0.0. A major bump turns every extension built for an older major off, with the line "Built for extension contract N.x. This CrewKite offers M.x, so it stays off until the extension is updated."
- Extensions install by copying a folder. There is no network install in this version.
- Crew roles an extension declares are listed with it. The ADR 0038 chain does not schedule them in contract 1.
- The reference extension in `packages/testkit/src/extensions/thread-stats` adds one thread action that counts a thread's recent messages. It is the template for the separate repository.

## Why

The person decides what runs on their machine. Enabling an extension is that decision, so it stays off until they make it, and the decision binds the exact bytes they saw. An entry module can import its siblings, and a `package.json` changes how Node reads a module, so the hash covers the whole folder. Any changed file asks again.

I state plainly that enabling runs code with the person's permissions. I considered running extensions in a worker thread or a separate process with a message channel. Either would narrow what a careless extension can reach by accident, and neither stops a module that imports `node:fs`, so neither would let me claim containment. Contract 1 runs the module in the controller process and limits what CrewKite hands it. A separate process stays open as a later major version if a real extension needs one.

Routing extension commands through the existing command path means one set of checks. A second dispatcher for extensions would need its own principal, receipt and task rules, and the two would drift. The context carries capabilities, not handles: a reader bound to one thread and an emitter bound to declared kinds. An extension can only call what it was given, and nothing it is given reaches past its own thread or touches a limit.

A synchronous command keeps the receipt honest. The command runs inside the same transaction that writes the receipt and its events, so a retry with the same key returns the stored result and never runs the extension twice. Asynchronous commands would need the intent and closure journal the provider operations use, and I add that when an extension needs it.

Slots as data keep the [desktop security](../architecture.md#desktop-security) rules intact: the renderer stays sandboxed and shows extension output as text.

A closed authority list grows by minor versions as real extensions need more. A major bump is the honest signal that old extensions might misbehave, so it turns them off with a line the person can act on.

## Consequences

- An enabled extension can do anything a program running as the person can do. The docs and the Settings card say so. The seam limits what CrewKite hands it; it does not contain the code.
- A changed folder needs a controller restart before it runs again once this run tried to load it, because Node keeps the first copy of a module it loaded. A failed load counts as a try.
- Extension commands cannot wait on I/O in contract 1. A command that returns a promise is refused.
- The on and off choices live in `<home>/extensions/enabled.json`, written after the command commits. A crash between the commit and that write loses the choice while the receipt says applied. A migration-owned table can replace the file.
- Crew roles are listed and not scheduled. Wiring them into the chain is a separate decision.
- The CLI renders slots from the same read once its interactive client lands.
- The seam has fixture coverage with the reference extension and test probes, and no premium extension exists yet.
