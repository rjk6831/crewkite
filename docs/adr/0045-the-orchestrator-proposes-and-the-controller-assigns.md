# 0045. The orchestrator proposes and the controller assigns

- Status: Proposed
- Date: 2026-10-28

## Context

[ADR 0038](0038-crew-and-flight-modes.md) runs one builder turn, then a fixed review chain. A large request goes to one model as one turn. When it does not fit that model's context or allowance, the turn fails or stops on the limit, and I split the work by hand into messages.

ADR 0038 ruled out a Manager role: "A Manager would decide which role runs next and when to stop, and that makes model output the authority over the chain." [ADR 0002](0002-authority-in-deterministic-code.md) already says models, the orchestrator included, propose plans and assignments, and the controller decides. What was missing was a plan shape the controller could check and an assignment rule it could run without the model.

## Decision

This record amends the Manager paragraph of ADR 0038 and leaves that record's text as it is. A crew can have an orchestrator. It proposes. The controller validates, assigns and runs.

- `orchestrator` is a fifth crew role with a model and effort. A crew still needs a builder, and each role appears at most once. The Full crew preset includes an orchestrator. Solo and Pair do not.
- When the crew has an orchestrator, the orchestrator turn replaces the single builder turn. It runs read-only and returns one fenced `json` block tagged `plan`.
- `ChatPlanSchema` in `packages/contracts/src/chat.ts` defines the plan: `planId`, `goal` (at most 2,000 characters) and 1 to 8 slices. A slice has `id` (1 to 8, unique), `title` (at most 120), `brief` (at most 4,000), `files` (at most 40 paths inside the scratch copy, no `..`, no absolute path), `depends` (ids of other slices, no cycle), `difficulty` (easy, medium or hard), an optional `hint` (`family`, and `role` builder or fixer) and `readOnly`.
- A plan that fails the schema goes back to the orchestrator once with the error. A second failure stops the chain with one line.
- Assignment is a pure function of recorded inputs, in the controller. For each slice in dependency order, the candidates are the connected families above the reserve, ranked by the thread's handoff mode with `rankFamilies`.
  - Hard and medium: the crew builder's model when its family ranks, otherwise the next ranked family with its default model.
  - Easy: Local when it is connected and the slice fits, otherwise the top-ranked family. A slice fits when the bytes of its named files are within the Local prompt room from the A5 rule and none of them is an image.
  - `hint.family` breaks a tie among ranked candidates. It never adds a candidate.
  - Each assignment writes a system line with its reason, for example "Slice 2 (easy) assigned to Local: 5,478 token room, Local first." The same line goes in the packet.
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
