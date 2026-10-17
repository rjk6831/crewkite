# 0025. Use an explicit memory-only Local connection credential

- Status: Proposed
- Date: 2026-10-17

## Context

A Local runtime exposes authenticated loopback inference. ADR 0005 leaves cloud-provider credentials with their native clients. Reusing a subscription credential for Local access would cross that boundary. I need a separate, explicit credential for the Local connection without turning the renderer or saved configuration into a secret store.

## Decision

I propose a narrow exception for a dedicated Local runtime credential entered through the fixed packaged native input helper. The endpoint is a literal loopback address, `ws://127.0.0.1:<port>`. The controller holds the credential in memory, bound to the current connection revision and hash. Logs, snapshots, receipts and persisted setup exclude its value. Restart requires input again. A changed connection or explicit disconnect revokes the in-memory authority.

The runtime manifest binds the packaged Node, helper and native source hashes. Missing capability keeps input unavailable. No renderer field, caller executable path, environment override or cloud credential store supplies this value.

Discovery is explicit and reads installed and loaded model metadata without loading a model. Selection binds one observed eligible instance to its runtime and source preparation. Native input, discovery and generation share a durable exclusion gate. Client loss does not prove that external generation stopped; missing terminal and closure proof retains unknown ownership across restart.

## Why

I chose a dedicated credential because Local access is a separate cost and trust domain. Keeping it out of durable state limits what a copied home or diagnostic export can expose. Requiring input again after restart costs convenience. I accept that cost before adding a credential store and its lifecycle.

I kept model identity in observed metadata. A hardcoded model name or machine memory size cannot establish which instance is loaded, idle and eligible now.

## Consequences

- This proposal awaits my acceptance and leaves Accepted ADR 0005 unchanged while Proposed. It grants no access to cloud-provider credential stores.
- The initial profile permits one resident language model and one generation, with no embeddings or draft model. It neither downloads nor loads models.
- Loaded eligibility establishes no model qualification. Memory, latency, quality, cancellation and installed recovery need separate evidence.
- The Local file proposal retains work for inspection and export. Checks, review and acceptance remain unavailable for that profile.
