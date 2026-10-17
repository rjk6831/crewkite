# Continuity and recovery

A provider can stop mid-task for many reasons: a usage limit, a crash, a lost network, a closed laptop. CrewKite keeps the task recoverable without asking the stopped model for anything.

## Four different things

These are often treated as one feature. I keep them separate because each one helps without proving the others.

| Mechanism | What it gives you | What it does not prove |
|-----------|-------------------|------------------------|
| Context summary | A short model-written recap | That the recap is complete or true |
| Native resume | The same client picks up its own session | That another provider can continue |
| Durable task recovery | Facts and files the controller already holds | That every byte the model produced arrived |
| Safe writer transfer | A new route takes the task after the old writer is proven stopped | That the new route has the same capability |

The first release builds durable recovery and safe transfer. Summaries are an optional aid. Manual route switching comes before automatic failover.

## The handoff packet

The controller journals events during work and seals a versioned, checksummed packet at verified boundaries. A successor starts from the packet and the referenced artifacts.

The packet contains:

- Task, run and attempt lineage with the handoff generation
- The original outcome and acceptance criteria
- Decisions made and actions denied
- Source and candidate identities, with a manifest of every received artifact
- Unfinished or unverified work and checks that failed or never ran
- Scope, remaining budgets and unresolved exposure
- The effective policy and the routes allowed to continue

It references retained content by hash. It excludes credentials, unrelated history and private model reasoning. A summary, when present, is labelled as model output and links to the facts it describes.

## Transfer sequence

1. Stop new admissions for the outgoing route.
2. Request a checkpoint if the client supports one, then wait for the terminal event.
3. Prove quiescence. If ownership cannot be proven, the task enters `unknown` and transfer waits.
4. Seal the received work as an immutable artifact and write the packet.
5. Admit the approved successor through the normal admission transaction. The writer lease moves with a compare-and-swap, so a restart cannot produce two writers.
6. Recheck and review according to the task policy.

Pins, denied capabilities, remaining budgets and unresolved exposure carry over. A provider limit never authorizes another account, a new data recipient, a paid API route or a weaker quality gate.

## Manual route switching

`SwitchRoute` saves one exact target from the current run's coder route and approved fallbacks. The CLI sends it through `task switch <task-id> <route-id>` with the current task revision. Selecting a target does not mean it has been admitted.

The controller stops the owned coding worker and waits for process-group absence and closed output streams. It seals the current partial bytes as unverified work, then applies the original pin, allowance, slot and remaining-budget gates. A healthy pinned primary still takes priority. The run keeps its saved policy and authority.

A blocked target stays visible on the stopped task. Explicit resume rechecks that exact target. Stop cancels it. Pausing during the outgoing stop leaves the target pending until explicit resume. Restart retains the request and never dispatches it automatically. Draft tasks and check or review stages cannot become a successor coder through this command.

## Manual native file handoffs

New native file runs can opt into a finite recipient list during initial preparation. That list grants no automatic routing authority and changes no saved pin or role assignment. After the current writer is stopped and positively quiescent, `PrepareNativeHandoff` seals the retained file and durable task packet for one allowed recipient. Fresh consent binds its exact identity, credit policy and required billing assertions. Preparation launches nothing. `StartNativeHandoff` consumes that preparation once and admits a fresh writer in independent scratch within the original run limits.

The retained file and packet each have a 64 KiB bound. Original committed source and retained target bytes keep separate identities. Changed work needs new checks and review. A pending transfer survives reopening without submission; Stop cancels it. Legacy and repository runs do not gain this capability. The path has offline fixture coverage only, with no connected-transfer qualification. Google consumer launch remains unavailable. The [CLI guide](../apps/cli/README.md#manual-native-file-transfers) records the explicit commands and consent.

## Combined ownership and recovery

One frozen parent owns two child memberships and their shared dispatch ledger. A child cannot independently change its task contract, route or acceptance path. Retained candidates keep both contributors' run, attempt, scope and source identities. Identical final bytes do not erase that lineage. Ordered replay checks and guarded private ref transitions remain part of the final origin; acceptance also needs the full combined check and separate review.

Parent Pause closes new admissions and records the current phase. An already owned process may finish. Resume is explicit and restores an available phase only after every owner has stopped, recorded proofs remain valid and the remaining budget covers reserved work. Unknown ownership or a failed or stopped stage blocks it. Resume dispatches nothing and cannot restart a child writer. Child Pause and Resume refuse while the parent owns that membership.

Stopping one child closes further combined admission. Parent Stop requests cancellation for both children, checks, review and private integration work, and closes their pending approvals. The parent remains stopping until all owners settle; unresolved ownership remains unknown. Retained work stays inspectable. Stop on an already accepted group preserves its accepted result.

Restart never resubmits a writer, reruns a check or automatically replays a private Git operation. Missing terminal proof or unproven process closure in a ref journal keeps the group unknown without probing or signalling historical process groups. A saved ref value alone cannot prove process closure. Exact command retry can return a committed result; it grants no new execution. Reconciliation and publication still validate the saved generation, immutable origin and exact ref state. Offline fixtures cover these rules; connected recovery remains unqualified.

## Restart

On startup the controller reconciles attempts and effects before it dispatches anything.

- An intent with no acknowledgment becomes `outcome-unknown`. It is never replayed blindly.
- A known never-launched attempt releases its reservations.
- Partial files stay available and are marked unverified.
- Revoked authority stays revoked.

Reopening a task shows what is known, what is uncertain and the safe next actions. It never restarts inference by itself.

## Durability

SQLite runs in WAL mode on local disk with full synchronous writes for control records. Artifacts are written, hashed and published before their references commit. A consistent backup includes the referenced artifacts. Disk-full and corrupt-evidence conditions keep the last valid state and surface an explicit blocker.
