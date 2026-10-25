# 0043. Remember the Local token on this Mac

- Status: Proposed
- Date: 2026-10-26

## Context

[ADR 0025](0025-use-an-explicit-memory-only-local-credential.md) keeps the Local connection token in controller memory. Every relaunch needs the token again: rail Connect opens Settings, I press Connect and type the token. I saw this on each launch of the last release candidate. The cost is real and it falls on every session.

The README says cloud-provider authentication stays with the native clients. That is still right for OpenAI, Anthropic and Google. A Local runtime token is a different thing, and this record separates the two so that the README can say so.

## Decision

I propose an opt-in setting, "Remember the Local token on this Mac". Nothing changes until I accept this record, and nothing is built.

- Off by default. Turning it on happens on the Local card, after a successful connect with a token, and asks once.
- The main process stores the token with Electron `safeStorage`, which encrypts it with a key held in the macOS keychain. The encrypted blob is a file in the CrewKite home. If `safeStorage` reports that encryption is unavailable, the setting stays off and says why.
- Scope is one runtime host and port. The blob is keyed to the endpoint, such as `ws://127.0.0.1:1234`. A different host or port does not find it, and a changed endpoint or mode deletes it.
- The renderer never receives the token. The main process decrypts it and hands it to the controller in memory when Connect runs, the way the packaged input helper does now.
- A Forget action on the Local card deletes the blob and clears the controller's copy. Disconnect keeps the blob. Forget removes it.
- Logs, snapshots, receipts and exports never contain the value. The controller keeps the in-memory handling ADR 0025 describes.

## Why

A Local runtime token is a different class from a subscription credential. I create it, for a process on my own machine, in the runtime's own settings. It grants no account, no billing and no cloud access. It opens a socket on 127.0.0.1 that a person or process on this Mac could already reach. A subscription credential identifies me to a company, can spend money and works from anywhere. ADR 0005 keeps those with their clients because CrewKite has no business holding them. That reasoning does not apply to a token that only unlocks a local socket.

Asking for the token on every launch costs me a step each session and protects little, since anyone who can read the encrypted blob as me can usually read the runtime's own configuration too. `safeStorage` keeps the value off disk in plain form, which is the part of ADR 0025 I care about most. Opt-in keeps the default as strict as it is today.

The alternatives lost. A plain file in the CrewKite home exposes the value to a copied home or an export. The macOS keychain directly would work, but `safeStorage` is the supported Electron path and needs no native module I would have to qualify.

## Consequences

- Nothing is built until I accept this record. ADR 0025 stands as written.
- Accepting it adds a stored secret to the CrewKite home, encrypted. A copied home is not enough to read it, and a process running as me on this Mac can still ask `safeStorage` to decrypt it.
- It adds a Forget action, a setting and a test that a changed endpoint deletes the blob.
- The README principle changes. Today it reads: "Cloud-provider authentication stays with those clients." If accepted, it reads: "Cloud-provider authentication stays with those clients, and CrewKite never reads or stores a provider credential. The one secret it can keep is the token of a model runtime on this Mac, only when I turn on Remember the Local token, and Forget removes it." The README does not change until I accept this record.
- The wording "CrewKite never reads or stores a provider credential" holds for OpenAI, Anthropic and Google in both versions. The Local token is not a provider credential, and the new sentence says so in plain words.
