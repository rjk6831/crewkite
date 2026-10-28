# 0043. Remember the Local token on this device

- Status: Accepted
- Date: 2026-10-28

## Context

[ADR 0025](0025-use-an-explicit-memory-only-local-credential.md) keeps the Local connection token in controller memory. Every relaunch needs the token again: rail Connect opens Settings, I press Connect and type the token. I saw this on each launch of the last release candidate. The cost is real and it falls on every session.

The README says cloud-provider authentication stays with the native clients. That is still right for OpenAI, Anthropic and Google. A Local runtime token is a different thing, and this record separates the two so that the README can say so.

The release candidate also showed the loopback probe deciding the saved auth mode. A cold runtime missed the 2 second probe, the first Connect opened the token window, and a later Connect that answered without a token switched the saved mode to none. The mode on disk followed a timing result.

## Decision

I chose an opt-in setting, "Remember on this device", on the Local card, with a "Forget" action beside it.

- Off by default. Turning it on happens on the Local card, after a successful connect with a token, and asks once.
- The main process stores the token with Electron `safeStorage`. On macOS the key sits in the keychain. The encrypted blob is a file in the CrewKite home.
- The option appears only when `safeStorage` can encrypt and `safeStorage.getSelectedStorageBackend()` is not `basic_text`. On Linux `basic_text` is the fallback when no keyring answers, and it is a fixed key, so I treat it as no encryption. Where the option is hidden, the card says why.
- Scope is one runtime host and port. The blob is keyed to the endpoint, such as `ws://127.0.0.1:1234`. A different host or port does not find it, and a changed endpoint or mode deletes it.
- The renderer never receives the token. The main process decrypts it and hands it to the controller in memory when Connect runs, the way the packaged input helper does now.
- Forget deletes the blob and clears the controller's copy. Disconnect keeps the blob.
- Logs, snapshots, receipts and exports never contain the value. The controller keeps the in-memory handling ADR 0025 describes.

The loopback probe runs at the start of every connect, in both saved modes, and it never writes the saved mode. Its result lives on the connection as `connectedWithoutToken` and the card shows it. With the saved mode none and a runtime that now wants a token, the connect opens the token window for this connection and leaves the saved mode as none. A probe that times out is tried once more, 2 seconds each, before the token window opens. The turn trace records what the probe found.

This record amends one clause of ADR 0025 and leaves that record's text as it is. ADR 0025 says the CLI configures the no-token mode and the desktop only reports it. The Local card now has a switch with two options, "Token" and "No token (loopback only)". It writes the saved mode through the same command the CLI uses, with the same checks and the same revocation of readiness and model selection.

## Why

A Local runtime token is a different class from a subscription credential. I create it, for a process on my own machine, in the runtime's own settings. It grants no account, no billing and no cloud access. It opens a socket on 127.0.0.1 that a person or process on this device could already reach. A subscription credential identifies me to a company, can spend money and works from anywhere. ADR 0005 keeps those with their clients because CrewKite has no business holding them. That reasoning does not apply to a token that only unlocks a local socket.

Asking for the token on every launch costs me a step each session and protects little, since anyone who can read the encrypted blob as me can usually read the runtime's own configuration too. `safeStorage` keeps the value off disk in plain form, which is the part of ADR 0025 I care about most. Opt-in keeps the default as strict as it was. I hide the option on `basic_text` because a blob anyone can decrypt with a known key is a plain file with extra steps.

A plain file in the CrewKite home lost because it exposes the value to a copied home or an export. The macOS keychain called directly would work, but `safeStorage` is the supported Electron path and needs no native module I would have to qualify.

The probe answers a question about this connect: does the runtime want a token right now. The saved mode answers a different one: what I told CrewKite to use. Letting the first answer overwrite the second made a cold start change my settings. Keeping them apart means a timeout can cost one extra prompt and nothing more.

The switch on the card exists because I change the runtime's auth setting from its own window, and going to a terminal to tell CrewKite the same thing was the step I skipped. One command behind both paths keeps one set of checks.

## Consequences

- A stored secret now exists in the CrewKite home, encrypted. A copied home is not enough to read it, and a process running as me on this device can still ask `safeStorage` to decrypt it.
- On Linux without a keyring, the option is not offered and the token is asked for on each launch, as before.
- The Local card gains a setting, Forget, a mode switch and a probe line. There is a test that a changed endpoint deletes the blob.
- A cold runtime can cost up to 4 seconds of probing before the token window opens.
- The README principle reads: "Cloud-provider authentication stays with those clients, and CrewKite never reads or stores a provider credential. The one secret it can keep is the token of a model runtime on this device, only when I turn on Remember the Local token, and Forget removes it."
- The wording "CrewKite never reads or stores a provider credential" holds for OpenAI, Anthropic and Google. The Local token is not a provider credential, and the sentence says so in plain words.
- ADR 0025 is still Proposed. When I accept it, it gets a dated amendment that points here for the stored token and the mode switch.
