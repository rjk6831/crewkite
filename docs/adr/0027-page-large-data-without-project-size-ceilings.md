# 0027. Page large data without aggregate project-size ceilings

- Status: Proposed
- Date: 2026-10-21

## Context

A whole-workspace snapshot can exceed one transport frame even when the requested task is small. Artifact responses are paged, but the reader still allocates the whole artifact. Source capture and integration also carry small aggregate byte and file ceilings. Raising those constants moves the failure and increases memory pressure.

## Decision

I will keep finite transport frames and make the normal workspace read path paged. A cursor binds its selection to a consistent revision or watermark. Large bodies live behind immutable identities, with ranged reads, incremental hashing and explicit completeness. Source capture and private integration stream manifests and file bytes to disk, with resource accounting and cancellation.

A frame bound is a transfer unit. It does not define the maximum project, file, conversation or retained history. Views show whether content is complete, loading, omitted from a preview or unavailable. Provider input remains bounded by the selected route's actual context capacity; local retained content stays independently accessible.

## Why

I ruled out unbounded frames and whole-object allocation because one large read can stall the controller and Stop handling. Increasing constants alone leaves that failure intact. I also ruled out silently truncating source or history because a partial result can mislead review and recovery.

SQLite remains the authority for state and indexes under ADR 0004. Immutable files remain the content store. I will reuse those boundaries and measure the cost of paging before considering another storage system.

## Consequences

- Cursors, cancellation, backpressure and stale-page behavior become shared contracts. Older clients need an explicit compatibility path.
- Whole-content integrity is established by incremental verification or trusted publication metadata. A partial read cannot claim it checked every byte.
- Disk pressure, corrupt content and unsupported source entries remain actionable failures. Removing aggregate ceilings supplies no extra filesystem or command authority.
- [Daily-work slices](../daily-work-slices.md) define the first implementations and measured acceptance. Compression format and history segment sizes wait for measurements.
