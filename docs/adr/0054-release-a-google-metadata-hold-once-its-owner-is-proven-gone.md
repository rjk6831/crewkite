# 0054. Release a Google metadata hold once its owner is proven gone

- Status: Proposed
- Date: 2026-11-18

## Context

Google quota reads, initialize, sign-in and discovery share one metadata gate per home. A row whose ownership was left unknown stayed unknown across every restart. Only Stop on an unknown setup step could clear one, and a quota read had no way out at all. That is how a Ready setup came to sit behind one unknown quota-read row, with every later Google read and setup step refused and nothing on the card to say why.

The journal also could not tell a row that closed normally from one released by Stop. Both were just settled, so a late answer from the released command could still publish.

## Decision

I separate an interrupted metadata result from the ownership that blocks the next operation.

- For usage, initialize and discovery, which send no model prompt, grant no project write or terminal and start no sign-in, startup and an explicit Recover release the gate once a current zero probe returns `ESRCH` for the recorded group and no Google runtime or pending Google start remains in this controller. Stop on an unknown setup step runs the same rule.
- The release records the settlement as `owner-absent`, with its receipt and evidence, in one transaction. The result stays unknown. Only a row that closed normally publishes, and the publishing transaction checks that against the live authority first. A late answer from a released command publishes nothing and leaves newer setup state alone.
- Earlier observations keep their timestamps. The setup proof and Ready stay.
- Startup never releases an interrupted sign-in. Recover can, after the same probe. The setup then reads its sign-in as unknown and waits for the person to sign in again, and nothing discovers on the older proof first. The card says that a sign-in still open in the browser may complete.
- A group that answers, a refused probe, a row with no recorded group, a live runtime and a known machine, namespace or provenance conflict keep the hold. Missing legacy identity alone does not. Each hold has one fixed line of copy, and the snapshot lists every row that holds the gate with its reason, so Ready never hides one.
- With every row settled and no Google owner registered, the controller may remove the reserved temporary usage directories under the same home contract. That clears disposable storage and proves nothing about an escaped process.

The zero probe is the only call. Recovery never sends a signal to a historical process number, and no acknowledgment or clock comparison counts as proof of absence.

## Why

A closed gate protects nothing once the process is gone. It only keeps the home waiting on a person who has no way to act. The 2026-10-18 amendment to [ADR 0024](0024-integrate-google-through-its-published-acp-agent.md) made the same call for writer attempts. I extend it to metadata with tighter limits.

I ruled out a reboot or the clock as proof. A process number can be reused, and a long run looks the same as a dead one. I ruled out replaying the read, since nobody asked for it again. I kept sign-in apart because a browser flow can finish after its client exits, so releasing it automatically would claim something I cannot see.

A descendant that left the recorded group survives `ESRCH`, and this rule does not contain it. I accept that residual for observation-only work: no task prompt, no project write grant, no replay and no publication of the released result. The native client may still write its own cache or session files. I do not extend this reasoning to writers or claim that an old browser flow ended.

## Consequences

- Restart now probes each held row once with signal 0. The provider notes said restart never probes; they now describe this rule.
- The proof holds only for a locally owned home in one host PID namespace. The home lock proves nothing across machines. This build records home-keyed boot and machine digests before each launch, but nothing compares them yet, so a home copied from another machine looks local. I state that limit plainly until a qualified identity check exists.
- A row with no recorded group stays held through every restart, and so does a group number that still answers. Its hold copy points to diagnostics.

## Amendment, 2026-11-21

A zero probe cannot tell a group that is gone from one whose number another program has taken, so a reused number held a row for good. I add a second proof. When the probe answers or is refused, the controller reads the start time of the process whose PID equals the recorded group from the process table with `ps -o lstart=`, by absolute path and with no signal. If that process started more than one hour after the row was recorded, the row settles as owner-absent at startup or on Recover, with its receipt and evidence. Its result stays unknown. An interrupted sign-in still needs a person at startup.

The Decision says no clock comparison counts as proof of absence. This one differs. It never infers absence from elapsed time. It compares the start of the process now holding the number with the moment the read was recorded, to prove the number was reused. The row is recorded at intent and the spawn follows in the same synchronous run right after the commit, so CrewKite's own process started within milliseconds of that time. macOS and Linux never hand out a PID while a process group or session with that number exists. A process holding the number that started later was created after the read's group and session had ended.

The hour covers clock corrections. On Linux the start time comes from the boot time, which moves when the clock is stepped. A step larger than an hour while CrewKite's own read still runs is the residual, and I accept it.

Two cases still hold: a group whose leader has exited, since its members may be the read's own children, and a leader that started within the hour. The card now says "The process number this operation recorded is still in use, so CrewKite cannot confirm that it ended. Another program may hold the number. Restart the computer to free the number. The operation is then released when CrewKite starts, or by Recover." Recover is offered for these rows. It only reruns the probe and the proof. Signal 0 and the process table read are the only contact with the recorded number. A quota refresh refused by a hold now says "An interrupted Google operation is holding Google quota reads. Recovery on the Google card in Settings says why and what releases it."
