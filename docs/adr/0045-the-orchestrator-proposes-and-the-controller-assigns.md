# 0045. The orchestrator proposes and the controller assigns

- Status: Proposed
- Date: 2026-10-28

## Context

[ADR 0038](0038-crew-and-flight-modes.md) runs one builder turn, then a fixed review chain. A large request goes to one model as one turn. When it does not fit that model's context or allowance, the turn fails or stops on the limit, and I split the work by hand into messages.

ADR 0038 ruled out a Manager role: "A Manager would decide which role runs next and when to stop, and that makes model output the authority over the chain." [ADR 0002](0002-authority-in-deterministic-code.md) already says models, the orchestrator included, propose plans and assignments, and the controller decides. What was missing was a plan shape the controller could check and an assignment rule it could run without the model.

## Decision

This record amends the Manager paragraph of ADR 0038 and leaves that record's text as it is. A crew can have an orchestrator. It proposes. The controller validates, assigns and runs.

- `orchestrator` is a fifth crew role with a model and effort. A crew still needs a builder, and each role appears at most once. The Full crew preset includes an orchestrator. Solo and Tandem do not.
- When the crew has an orchestrator, the orchestrator turn replaces the single builder turn. It runs read-only and returns one fenced `json` block tagged `plan`.
- `ChatPlanSchema` in `packages/contracts/src/chat.ts` defines the plan: `planId`, `goal` (at most 2,000 characters) and 1 to 8 slices. A slice has `id` (1 to 8, unique), `title` (at most 120), `brief` (at most 4,000), `files` (at most 40 paths inside the scratch copy, no `..`, no absolute path), `depends` (ids of other slices, no cycle), `difficulty` (easy, medium or hard), an optional `hint` (`family`, and `role` builder or fixer) and `readOnly`.
- A plan that fails the schema goes back to the orchestrator once with the error. A second failure stops the chain with one line.
- Assignment is a pure function of recorded inputs, in the controller. For each slice in dependency order, the candidates are the connected families above the reserve, ranked by the thread's handoff mode with `rankFamilies`.
  - Hard and medium: the crew builder's model when its family ranks, otherwise the next ranked family with its default model.
  - Easy: Local when it is connected and the slice fits, otherwise the top-ranked family. A slice fits when the bytes of its named files are within the Local prompt room from the A5 rule and none of them is an image.
  - `hint.family` breaks a tie among ranked candidates. It never adds a candidate.
  - Each assignment carries its reason, for example "Slice 2 (easy) assigned to Local: 5,478 token room, Local first." The plan card shows it on the slice row and the same line goes in the packet. The thread writes no line that repeats it; a slice with no family to run on still gets one. Amended 2026-11-01: the thread used to write one line per assignment, which repeated the card. The slice brief, the user message of a slice turn, shows folded under the slice chip as "Slice 1 brief".
- The chain: each slice runs as an ordinary builder turn with the slice brief and files. The ADR 0038 review chain runs once per slice with the same caps. The challenger runs once after the last slice. One line closes it, for example "Crew finished: 3 slices, 4 reviews, 1 fix."
- Failure: a slice that fails stops the chain. The slices after it show "not run", and each can be run on its own from the card. Stop marks every slice not yet done as not run. A slice is queued, running, done, failed or not run.
- The plan card in the thread follows the flight mode.
  - Manual shows the card and runs nothing. Each slice has Run, and the card has Run plan.
  - Balanced shows the card and waits. Each slice has a family picker listing the ranked candidates with their reasons. The card has Run plan and Cancel.
  - Glide starts at once. The card shows Stop and each slice's status.

## Why

The plan is the part a model is good at: reading a request and cutting it into pieces with an order. Choosing which subscription pays for each piece is arithmetic over allowance, reset times and context size, and the controller already does it for handoff. Splitting the two keeps the part I need to trust in code I can test with fixed inputs.

ADR 0038 ruled out a Manager because it would steer the chain. The orchestrator does not. It writes one plan, once. The controller checks it against a schema, decides who runs each slice and runs the same review chain it runs today. A bad plan is refused before anything runs. A plan that passes can still be a poor split, and the card shows it to me before Balanced or Manual runs it.

Eight slices is the cap because past that I stop reading the card, and every slice costs at least a builder turn and a review. The 40 file and 4,000 character limits keep one slice inside what a small context can take.

Easy slices go to Local first because they are the work a small model can do, and they spend nothing from a subscription. The fit check uses the same budget rule the Local adapter uses, so a slice that is assigned to Local fits when it runs. Hard slices stay with the builder I picked, because that is the model I chose for the hard part.

The hint breaks ties only. If it could add a family, the orchestrator could route around the reserve or a family at zero, and that is the authority ADR 0002 keeps in the controller.

A failure stops the chain because later slices may depend on the failed one, and a partial result I can see beats a chain that guesses on.

## Consequences

- A plan multiplies usage further. Three slices with one fix cost an orchestrator turn, three builds, four reviews, one fix and a challenge.
- The orchestrator's reply must contain the fenced block. A model that writes prose only fails twice and stops the chain.
- The controller cannot judge a plan's quality. It checks shape, bounds and order.
- Local takes easy slices whenever it fits. A small model that does an easy slice badly costs a review round to catch.
- The thread record carries the plan card, so it grows by up to 8 slice rows. The briefs stay in the orchestrator's reply.
- Parallel slices on isolated copies are out of scope. Slices run one at a time, and one turn per subscription runs at a time.
- The plan schema has fixture coverage. The assignment, chain and card have no live run on record.

## Amendment, 2026-10-28

A slice marked `readOnly` runs in the ask role, the read-only role the controller already enforces for every adapter. Before this, it ran as a builder turn and only its brief asked it to change nothing. A read-only slice changes nothing, so no review chain follows it, and the challenge after the last slice argues against the last slice that wrote. A plan whose slices all read closes without a challenge. Like an Ask, a read-only slice leaves the thread's pick alone, and a usage limit fails it for the card to run again.

The guard that runs one turn per family at a time across threads skips review chain turns. They start when their step comes, even while their family answers in another thread. A chain runs its steps one at a time, and the guard exists for competing threads, where a message or an Ask from the person waits in its own thread's queue. This paragraph first said the guard skipped plan slices too. Since the parallel amendment below, slices of one plan compete with each other, so every turn a slice opens waits for its family like a message does.

## Amendment, 2026-10-28: parallel slices and the replay merge

The Consequences above say parallel slices on isolated copies are out of scope. This amendment brings them in, and the controller still decides everything that runs.

- Slices whose dependencies are all done start together. At most one turn runs per family across every thread, so two ready slices on one family run one after the other, in plan order. A slice whose family answers elsewhere waits on the card as queued. While a slice is blocked, no new slice starts.
- Each slice runs in its own scratch copy. The controller makes it from the thread's base with the same copy function the thread uses, then writes over it every file the thread's copy changed since the base, so a slice that depends on another starts from that slice's merged work. It records which paths differed when the copy started.
- A slice's builder turn, its reviews and its fixes all work in that copy. The copy is the turn's working folder, the thread tools read their diff from it, and the controller answers an edit request on its own only when the edit lands inside it. A slice turn starts a new native session with the slice brief, and the thread never resumes that session.
- Each slice runs the ADR 0038 review chain in its own lane, with the same caps: a review, at most two fixes and at most three reviews. A review without a `Findings` line fails the slice. The project checks do not run inside a lane.
- A slice that finishes its chain replays onto the thread's copy in plan order, so a slice that finishes early waits for the slices before it. Files compare by blob ID and mode, the way Changes compares a copy with its base. A path the slice changed is written when the thread's copy still holds what the slice started from, skipped when the thread's copy already matches the slice, and is a conflict otherwise. Links are not replayed, since Accept takes them from the base.
- A conflict marks the slice blocked and the card lists up to 16 conflicting paths. The slice's other paths are merged. The orchestrator's model then gets one turn, as a fixer in the thread's copy, with the slice's version of each conflicting file quoted in its message. When that turn ends done, the slice counts as merged. When it fails or stops, the plan stops and the slice stays blocked, and the card can run it again from a fresh copy.
- After the last slice the project checks run on the thread's copy through the combined check, with the same question as any check run: Allow once, Allow for this thread or Deny. A failure goes to the fixer under the chain's cap of two fixes. Then the challenger runs, and the closing line counts slices, reviews and fixes.
- The thread writes one line when a slice starts and one when it finishes or blocks. Stop stops every running slice and keeps the slices already merged. A slice whose chain finished but still waited for its turn to merge merges before the plan stops, and a conflict there leaves it blocked for the card to run again. A restart during a plan stops it with the line "Plan stopped: restarted."
- A usage limit on a slice fails it for the card to run again. Moving one lane to another family would move the thread's pick, which the other lanes share.

The orchestrator still proposes only. It never picks which slice starts, never resolves a conflict on its own initiative and never answers a permission. A plan grants no permission and raises no limit: each slice turn carries the thread's own policy and grants, and the resolve turn runs under the same rules as any fixer.

I chose a file-level replay because the slice briefs name files, and two slices that touch one file are the case the orchestrator should look at. A line-level merge would merge more on its own and hide the cases where two slices disagree. The controller cannot judge a merge, so the challenger and the checks read the merged copy before anything else runs.

Consequences of this amendment:

- A plan with independent slices on two families takes about as long as its longest slice, and it spends the same allowance as before.
- Each running slice holds a full copy of the base on disk until the thread is deleted. Copy on write keeps that small on a volume that clones.
- A shell command that the thread's policy allows can still name a path outside the slice's copy. The working folder, the thread tools and the automatic answers are bound to the copy, and the other copies are not named to the model.
- The orchestrator's resolve turn counts as a fix in the closing line.
- The lanes, the replay and the restart line have fixture coverage and no live run on record.

2026-10-31: A blocked slice writes none of its paths to the thread's copy until its resolve turn ends done. The clean paths then merge beside the conflicts the orchestrator merged. When the resolve turn fails or stops, or the plan stops with the slice blocked, the thread's copy holds no part of the blocked slice. It holds the finished slices' work and whatever the resolve turn wrote before it stopped, as after any stopped fixer, and neither the checks nor the challenger ran on it. I chose this because a halt merges only finished slices and runs neither of them, and a blocked slice is not finished.

2026-10-31: A slice's own changes are the paths its builder and its fixes changed in its copy. The replay leaves out a path only a review changed, such as another slice's merged work in that copy, and the finished line names what it left out. The writer side is confined the same way, at the copy and at replay, so the reviewer is confined at replay too. A read-only slice's packet lists its own copy's diff against the base.

2026-10-31: A request for agents or subagents in a crew with an orchestrator is met by the plan. The slices are the parallel workers: slices whose dependencies are done start together, with one turn per family at a time, and the orchestrator's own turn only reads and plans. The orchestrator brief tells it to split the work into as many slices as the person asked for where the work divides that way, to leave the independent ones without dependencies and to say in its summary which run side by side. The brief no longer says the slices run one at a time. The reply keeps the plan block, which the controller reads, and the thread shows the reply without it, since the plan card shows the same plan. A slice that writes runs as the builder, so its client starts subagents when the builder's switch allows them.

## Amendment, 2026-11-01: slices stay inside the crew

The assignment rule in the Decision section ranked every connected family for each slice. Easy slices went to Local first, and medium and hard slices left the builder whenever its family did not rank. In a d3-rc5 run on a crew with no Local role, three slices went to Local and one to OpenAI by allowance, so the plan ran on models I had not put in the crew. This amendment replaces the assignment bullets and the hint bullet.

- A slice runs on the crew builder's model and effort.
- A hard slice runs on the crew fixer's model and effort when the crew has a fixer on a model other than the builder's.
- When the first choice cannot take the slice, the other of the two takes it. A model cannot take a slice when its family is not connected or has no allowance left, and Local cannot take one with an image, without a context length or with files over its prompt room.
- No family outside the crew takes a slice, and Local takes one only as a crew role.
- A family the person's message rules out takes no slice, crew member or not, and the handoff rule skips it. The controller reads a negation and a provider name in one clause, such as "Do not assign anything to Local AI" or "don't use Google or OpenAI". The orchestrator's hint could not do this, since it only breaks ties.
- The handoff rule still applies. When neither crew model can take a slice and Continue on another provider is on, the slice goes to the family the thread's handoff mode ranks first, with that family's default model, and `hint.family` breaks a tie there only. With Continue on another provider off, the slice has no model, and the thread writes one line that says why.
- The reason on the card names the role and why, for example "Slice 2 (hard) assigned to Anthropic (Fable 5.1): Fixer, hard slice." or "Slice 1 (medium) assigned to OpenAI (the builder model): Builder, the crew's model."
- Balanced lists the crew's models that can take the slice as its candidates, and after a handoff the families the handoff mode ranks.

I put the models in the crew on purpose, and a plan that spends a subscription I left out of the crew breaks that choice. The handoff switch is the one place I already said another family may take over, so it stays the only way out of the crew. The fixer takes hard slices because a crew with its own fixer model names the model I trust with the hard part.

The Easy-slice paragraph under Why and the Local consequence no longer hold. Local takes easy work when I make Local a member of the crew.

## Amendment, 2026-11-01: the orchestrator answers questions itself

The Decision section has the orchestrator return a plan block every time, and a reply without one went back once and then stopped the chain. In a d3-rc5 run a question about the calendar became a one-slice plan to confirm the answer. The orchestrator now answers a question, or a request that changes no file, in plain sentences with no plan block, and proposes a plan only for work that changes files or splits into independent parts. A reply with no plan block is that answer: nothing runs after it and no line follows. A reply with a plan block that fails the schema still goes back once with the error, and a second failure stops the chain with one line.

## Amendment, 2026-11-01: a message waits while a plan runs

A message the person sent while a plan ran stopped the plan with "Plan stopped: you sent a new message." once its running turns ended. A message now waits in the thread's queue while the plan runs, as it does behind any running turn, and starts once the plan has finished or stopped. Stop and Cancel still stop the plan.

## Amendment, 2026-11-01: the orchestrator reads the earlier plans

An orchestrator turn started cold with the person's message alone, so a second message about the first plan got "I couldn't find an earlier plan in this thread". An orchestrator turn now carries the thread packet, as a side question does: the conversation with the earlier plan replies, slice briefs and slice answers, the changed files, and the thread's last plan in words, with its goal, its phase and each slice's status and model.

## Amendment, 2026-11-01: Retry under a failed slice

Retry under a failed slice turn ran the slice brief again as a new message to the thread, on whatever provider the picker showed. Retry on a slice turn now runs that slice again from the plan, on the crew builder unless the person picks another model in Retry's picker, and the card line says which. In Balanced and Glide the plan goes on from there: the slices not done queue behind it and run as their dependencies finish. Manual runs the one slice, as the card's Run does. Regenerate and Continue do not apply to a slice turn.
