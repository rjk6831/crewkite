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

## Amendment, 2026-10-31: the Changes list pages and Accept takes hunks

The Changes list held at most 2,000 entries, and Accept refused when more files changed, because it publishes only what I could review. That was a size cap of the kind this record rules out. I lift it.

- `ReadChatChanges` returns one page of up to 2,000 entries in path order, the `total`, a `next` path and a `listing` digest. The digest covers the base and every entry by path, blob id and mode. A later page sent with the first page's listing is refused when the list moved, so a read never mixes two states of the copy. Every entry reaches exactly one page, and a page ends early when the next patch would pass the frame limits, so that patch starts the next page.
- Accept to branch has no entry cap. It takes the listing the Changes tab read and refuses when the copy no longer matches it, so it publishes exactly the list I paged through. Without a listing, as from the CLI, it publishes the current list, all of which the pages reach. The 100,000 file limit on a scratch copy stays.
- A text file that the base and the copy both hold, with the same mode, sides of at most 4 MiB and at most 1,000 hunks, shows its hunks with Accept and Discard each. Discard rewrites that file in the copy with the hunk reverted. Accept marks the hunk for the branch. Accept to branch then publishes such a file as the base with only its accepted hunks applied, and the rest stay in the copy against the new base. A file with no accepted hunk goes in whole. Binary files, links, added and deleted files stay whole-file.
- The controller keeps the marks in `chat_hunk_decisions`, each bound to the base and the file's blob id in the copy. Any change to the file's bytes or a new base drops them. A hunk key hashes its base start line and its lines, so a mark survives a discard of another hunk in the same file.
- A comment on a hunk or on lines of it is sent through `SendChatMessage` as a message that names the file and the lines and quotes the hunk lines. A running turn queues it like any message.

I kept the listing optional on Accept because the CLI reads the whole list and accepts in one step. The desktop always sends it.
