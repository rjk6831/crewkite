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
- Accept to branch has no entry cap. It takes the listing the Changes list was read under and refuses when the copy no longer matches it, so it publishes exactly the list I paged through. The desktop sends the listing of the tab, the interactive CLI sends the listing of its Changes view, and `crewkite accept` reads every page first and sends that listing. The 100,000 file limit on a scratch copy stays.
- A text file that the base and the copy both hold, with the same mode, sides of at most 4 MiB and at most 1,000 hunks, shows its hunks with Accept and Discard each. Discard rewrites that file in the copy with the hunk reverted. Accept marks the hunk for the branch. Accept to branch then publishes such a file as the base with only its accepted hunks applied, and the rest stay in the copy against the new base. A file with no accepted hunk goes in whole. Binary files, links, added and deleted files stay whole-file.
- The controller keeps the marks in `chat_hunk_decisions`, each bound to the base and the file's blob id in the copy. Any change to the file's bytes or a new base drops them. A hunk key hashes its base start line and its lines, so a mark survives a discard of another hunk in the same file.
- A comment on a hunk or on lines of it is sent through `SendChatMessage` as a message that names the file and the lines and quotes the hunk lines. A running turn queues it like any message.

The listing stays optional in the command for older clients. Every client in this repository sends it.

## Amendment, 2026-10-31: no file count cap on a scratch copy

A scratch copy refused a base with more than 100,000 files. That number named no limit of the disk, of Git or of a provider, so it was a size ceiling of the kind this record rules out, and it kept large repositories from starting a thread at all. I remove it.

- A thread copies a base of any file count. Git listings that grow with the repository may print up to 512 MiB, the most one JavaScript string holds.
- Before it writes, the copy checks free space on the disk that holds the CrewKite home. A copy that writes every byte needs the base's size plus 1 GiB free. A copy that may clone from the checkout needs the 1 GiB up front, since a clone takes no new space. When the volume refuses a clone, the copy checks the rest of the size before it writes on, before each file it streams, and every 256 MiB. A refusal names both numbers, and the partial copy is removed.
- The Local search covers every file the copy's .gitignore rules keep, and says how many files over 1 MiB it did not search. Local reads lines of a file of any size. Completion and the Local outline take the first 50,000 files, since they only need a sample.
- Pasted text longer than one message goes in as a file that main saves from the clipboard.
- The writer path for tasks keeps its 10,000 file limit.
- In the container (2 CPUs, no clone support) a 250,000-file base planned in 4 s, copied in 21 s, listed Changes in 11 to 13 s and built the Accept tree in 9 s, with the controller at about 870 MB. These runs block the controller while they work; moving them off the main thread is later work.
