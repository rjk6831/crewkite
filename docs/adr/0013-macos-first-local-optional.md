# 0013. Start on Apple Silicon macOS with local inference optional

- Status: Accepted
- Date: 2026-10-10

## Context

My workstation is a 48 GB Apple Silicon MacBook Pro. Process supervision, sockets, file permissions and sandboxing behave differently on each OS, and claims about them need real hardware.

## Decision

- macOS on Apple Silicon is the reference platform. Domain code stays portable. Other platforms come later with their own writer qualification.
- Local inference is optional. Every feature works with no local route configured.
- The first local profile runs one resident model and one generation at a time. It grows as measured memory, latency and result quality allow.

## Why

I can only qualify what I can run. Making local inference optional keeps the product useful on machines without spare memory, and the conservative starting profile avoids promising throughput I have not measured.

## Consequences

- Linux CI covers portable logic only. Native process, socket, SQLite and packaging claims need Mac evidence.
- Local model choices are dated test inputs and change with measurement.

## Amendment 2026-10-31: Linux preview

Linux x64 and arm64 run the OpenAI, Anthropic and Local families from source in this preview. The chat path finds each client the way it does on the Mac, by version range, with the same real path, regular file, owner and mode checks. The search covers the person's PATH plus fixed install locations: `~/.local/bin`, `/usr/local/bin` and `/usr/bin`. Local runs in the no-authentication loopback mode. Token entry needs the macOS keychain, so token mode is refused with one line that says so.

Google is held. It stays on the Mac, and on Linux the Google card says in one line that Google is not available on Linux in this preview. The writer profiles keep their exact pins on the macOS arm64 builds, so a Linux writer needs its own pin and qualification, as the decision above already says. Packaging for Linux (AppImage, deb and rpm) comes in a later wave. Windows is not supported, and I have not tested WSL2.

CI now runs lint, types, policy and the Node test suite on `ubuntu-24.04` and `ubuntu-24.04-arm`. The desktop build and the Electron journey stay on macOS. The Linux jobs prove the portable logic and the gates. Real client output, process ownership and a chat turn on Linux need a Linux machine with the clients signed in, and I have not run those yet.

I made this change because I want people on Linux to try CrewKite before packaging exists, and the gates were narrower than the code behind them needed to be. The Biome pin used for formatting and packaging now names the glibc platform package for each supported computer, at the same version as the root manifest.
