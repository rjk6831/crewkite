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
