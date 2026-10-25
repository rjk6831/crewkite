# 0042. The thread is the source of truth for every family

- Status: Proposed
- Date: 2026-10-26

## Context

A native session lives inside one client. When a thread ran on Anthropic, then Google, then Local, and I sent the next message to Anthropic, the adapter resumed its old session. That session had never seen the Google and Local turns, so the reply came from a conversation that no longer matched the thread. I saw this live. The thread and the session disagreed, and the session won.

A model change inside one family had a similar fault. Resuming the old session carried the previous model's context into the new model, and the client's own resume warning appeared in the thread as if the model had written it.

Local had a third problem. [ADR 0013](0013-macos-first-local-optional.md) says "The first local profile runs one resident model and one generation at a time." Two models loaded in LM Studio made every Local model ineligible, though the selected one was loaded and idle. The fixed 8,192 context in the connection checks did the same to any model loaded with a different window. A reply also spent its whole output budget on reasoning and stopped with no answer.

## Decision

- The thread holds every turn, and it is the source of truth for every family. A native session is a cache of the turns that family ran. The thread record keeps one cursor per family: the sequence of the newest turn that family's session has seen. The cursor advances when a turn on that family completes.
- On every turn the controller compares the family's cursor with the thread's newest turn. When turns from other families sit between them, it resumes the session and sends a delta packet with the new message. The delta packet holds the user messages verbatim, assistant text in full for the last three turns and summarized before that, one line per tool action, the diff since this family last ran (or the changed-file list when the diff exceeds its budget), check results since, and the files attached since, under the earlier-files heading.
- When the delta still exceeds the 96 KiB packet cap after the existing trimming, the controller drops the session and starts a new one with the full packet. The thread gets one system line: "Started a new Anthropic session. The thread moved past what the old session could carry." The family name changes with the family. Regenerate on the same family keeps its current path.
- A model change within a family starts a new native session with the full packet, through the same path as a family switch. The handoff card names the reason: "model changed in the composer". An effort change alone resumes the session.
- A client notice that is not model output, such as a resume warning or a settings notification, goes to the turn trace. The thread never shows it as assistant text, and I never edit text a model produced.

This record also amends the resident clause of ADR 0013 and leaves that record's text as it is. One generation at a time stays. The one-resident rule goes, and these rules replace it:

- Local qualifies when the selected instance is loaded and its model is eligible, whatever else is resident. Other resident language models do not disqualify it. An embedding model resident in the runtime still does.
- A turn binds to one instance reference, so a second loaded model cannot receive it.
- Memory pressure is a warning on the Local card and never a gate.
- No context size is fixed anywhere in code, as a floor, a ceiling or a special case. The loaded instance reports its context when CrewKite connects and at each re-observation. The repo map budget, the rolling summary trigger and the reply budget all derive from that number. An instance that reports 8,192, 131,072 or 1,048,576 qualifies the same way and gets budgets sized for its own window. [Local models](../local-models.md) gives the rule.

## Why

A session cannot know what happened outside it. The controller can, because every turn passes through it and lands in the thread. Putting the truth there means a family returning after two other families still answers from the whole conversation. A packet per turn on every family would also work, but it throws away the native session's own cache, its tool state and its prompt caching. The delta keeps those and adds only what the session missed.

I picked the 96 KiB cap because it is the packet bound already in use, so a fresh start behaves like any other handoff. When the delta cannot fit, a resume would drop turns without saying so. A new session with the full packet and one visible line costs the cache and keeps the answer correct.

A model change gets a new session because the old session holds the previous model's turns in the format that model produced them. An effort change leaves the history valid, so it resumes.

On Local, the one-resident rule protected against a memory problem I had not measured. The cost showed up first as a false refusal. A warning tells me about pressure and leaves the choice with me. I removed the fixed context because a constant tied to one window is wrong for every other window, and the loaded instance already reports the real number.

## Consequences

- Threads from before the cursor existed have no value for it. The first return to a family on such a thread starts a new session with the full packet.
- A return after other families ran costs a larger first request than a plain resume. The delta is bounded by the packet cap.
- A thread can show a "Started a new session" line on a long thread. That is the visible cost of the cap.
- A resume warning is no longer visible in the message text. It is in the turn trace.
- Proposed ADR 0025 repeats the one-resident profile in its consequences. Accepting this record supersedes that sentence, and 0025 gets a dated amendment then.
- The file-proposal profile for Local writers still carries its own fixed context and output limits. This record does not change it.
- The cursor, delta, model-change and Local rules have fixture coverage and no live run on record until the next live check.
