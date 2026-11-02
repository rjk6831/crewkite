# 0050. A side question runs beside the active turn

- Status: Proposed
- Date: 2026-11-03

## Context

A side question, the Quick question row in the composer, went the way a message goes. It waited behind the running turn in its own thread and behind any turn on the same family in another thread. A question about what the builder is doing got its answer once the builder had finished, which is when I no longer needed it.

On d3-rc11 I asked one while the builder ran three commands that CrewKite approved on its own, and the builder ended with a bare "Stopped.". The question did not stop it. The controller dropped the reason of every stop before it reached the thread, so the label read the same for Stop, Send now, a cancelled plan, a restart and a turn the OpenAI client interrupted by itself. The approved commands also showed as full permission cards with "Allow for this thread" checked, which looked like clicks I never made.

## Decision

- Ask starts a read-only turn at once, in the same thread, beside whatever the thread runs. It never enters the queue. Send now stays for queued messages.
- The thread's active turn stays the builder's. Stop, Send now, a handoff and the plan runner read the active turn, so none of them sees the question. The question has its own Stop on its row. Stopping one leaves the other running.
- One side question runs per thread at a time. A second one is refused with "Wait for the side question to finish, or stop it, then ask."
- The question skips the rule of one running turn per family. It reads only, every adapter enforces that, and it runs in a fresh session the thread never resumes. Its usage is read when it settles, like any turn's. Messages and plan slices in other threads still wait on it as they wait on any open turn on that family.
- An approval the builder waits on stays the builder's. The question declines every ask of its own, and the controller answers asks only for turns that write.
- Every stop records a cause on the turn record (`stopCause`: person, send-now, plan, restart or client) and writes one line in the thread: "Stopped: you pressed Stop.", "Stopped: Send now started the next message.", "Stopped: the plan was cancelled.", "Stopped: CrewKite restarted.", or the client's own reason, such as an interrupt after too many denials. Escape in the composer is still a Stop and gets the same line.
- `permission.resolved` names who answered: the person, a thread grant, the Permissions policy, the flight mode or the read-only rule. An ask nobody put to me folds into one muted line under its tool card. `permission.requested` carries the tool kind, so Allow for this thread holds when a client asks before the tool starts. An ask of a kind the thread allowed says on its card why it still came to me.

## Why

A side question is worth most while the work runs. In the queue it was a message with a different badge.

Running it beside the builder is safe because of what it is. It cannot write, and its session is thrown away, so it never competes with the builder's session or its scratch copy. The copy can change while the question reads it, and the answer may describe a file the builder edits a second later. I accept that. The question is about the moment.

I kept one active turn per thread. A second active turn would reach every command that reads it: Stop, Send now, Retry, Accept, handoff and the plan. Plan slices already run beside the active turn with Stop of their own, and the question takes the same path.

One question at a time keeps the thread readable and caps the extra load on a subscription at one read-only turn.

Every stop path already knew its cause. The reason was lost in two places, the controller's turn ending and the renderer's fold. A line in the thread survives a reload, the export and the handoff packet with no new reader.

## Consequences

- One thread can run two turns on one family at once, the builder and the question. Both spend the same window.
- A failed or stopped question can be the newest turn while the builder runs. Retry and the queue's hold after a failure read the newest turn, so a failed question can hold the queue. It did that when it queued too.
- [ADR 0045](0045-the-orchestrator-proposes-and-the-controller-assigns.md) says a person's Ask waits in its thread's queue. This record replaces that clause.
- An Ask queued by an earlier build still starts from the queue, and it now runs beside the turn.
- An approval method a client adds and CrewKite does not know shows a warning in the thread before the stop it can cause.
