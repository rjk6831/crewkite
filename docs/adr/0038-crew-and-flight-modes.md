# 0038. Run a crew in a thread, with flight modes and four handoff modes

- Status: Accepted
- Date: 2026-10-25

## Context

A thread answers one message at a time with one model. After a reply I read the diff myself, decide whether it needs a review, paste the findings back and ask for a fix. Every step is a message I type, and each one waits for me. When a provider reaches its limit mid-step, I pick the next provider by hand, and the pick is a guess about which window resets first.

[ADR 0036](0036-the-chat-thread-is-the-product-center.md) puts roles inside the thread, with a badge and one provider and model behind each. [ADR 0006](0006-route-by-allowance-and-reset-windows.md) routes by allowance and reset windows. The thread has neither a defined chain of roles nor a choice of how it ranks providers on a limit.

## Decision

- A crew is a named set of up to four roles, each with a provider, model and effort. Builder answers my messages. Reviewer reads the changes. Challenger argues against the assumptions behind the last answer. Fixer is the builder again, given the findings. Each role appears at most once and a crew needs a builder. `ChatCrewSchema` in `packages/contracts/src/chat.ts` enforces both.
- A thread has a flight mode: Manual, Balanced or Glide. A thread with no crew is Manual.
  - Manual runs nothing after a builder turn. Every step is mine.
  - Balanced runs the chain after each builder turn and asks me before a risky action: a command outside the read-only set, network access, an edit outside the scratch copy or a delete. The read-only set is `ls`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `find` and the git subcommands `status`, `diff`, `log` and `show`. In this mode the thread's permission policy does not apply to the builder. The controller answers the safe asks itself and sends the rest to me.
  - Glide runs the chain to the end and stops on a failure, or on a permission the thread's policy does not cover.
- Entering Glide turns automatic handoff on for the thread. The checkbox stays visible. If I turn it off, Glide stops on a usage limit like the other modes. Balanced and Manual keep whatever the checkbox says.
- The chain starts when a builder turn finishes in Balanced or Glide and the crew has a reviewer. The reviewer runs on a read-only turn. If its reply carries a line `Findings: N` (the last such line counts) and N is above zero, the fixer runs once with the review text, then the reviewer runs again. The chain runs at most two fixes, so at most three reviews. Then the challenger runs when the crew has one. Then one system line closes the chain, for example "Crew finished: 2 review rounds, 1 fix."
- Each step is an ordinary turn with its role badge. The chain stops with one line that says why when I send a message, I press Stop, a step fails, a step cannot start, a provider reaches its limit and nothing moves the step on, I switch the thread to Manual mid-chain, or a review ends without a `Findings` line. Only one chain runs per thread, and a new builder turn starts a fresh one.
- The thread keeps one of four handoff modes. `rankFamilies` in `packages/contracts/src/chat.ts` applies it when a limit stops a turn and automatic handoff is on. A family that is not connected never ranks. A family at zero percent never ranks, since a turn there ends on the limit it already hit. A family with no reading ranks after every family that has one, except Local under Local first.
  - Most allowance left takes the family with the highest percent remaining on its tightest window.
  - Resets soonest takes the family whose allowance resets first, while it has any left. Allowance that expires unused is lost, so I spend it first.
  - Even spend divides percent remaining by hours until reset and takes the highest. A reset closer than fifteen minutes counts as fifteen, so a window about to refill does not win on a tiny divisor. A window with no reset time ranks after every timed one.
  - Local first takes Local while it is connected, then ranks the rest as Even spend.
- The handoff mode is called Even spend so it never shares a name with the Balanced flight mode. A thread or setting saved under the first name, balanced, reads as Even spend.
- Settings holds the default handoff mode for new threads and three crew presets. Solo is the builder alone. Pair is a builder and a reviewer on another family. Full crew is builder, reviewer, challenger and fixer. A preset stores only the models and efforts I pin. A thread that starts from it picks the other roles from the connected families under the thread's handoff mode, so a preset still works after a family disconnects.
- The composer shows the flight mode as a pill next to the model picker. The pill opens the Crew tab in the inspector, where I pick a preset and the flight mode. The Crew tab also lets me change each role's model and effort in place. The builder's choice also becomes the thread's selection for my messages.
- Send now sits beside Remove on a queued message while a reply runs. It stops the running turn and starts that message first, with the stopped turn's packet, the same path a limit stop takes.

## Why

Review and fix is the loop I run by hand on every change, and the steps are always the same. A fixed chain with a cap removes the typing and keeps the cost bounded. I cap the fixes at two. If two rounds have not cleared the findings, a third round of the same model is unlikely to, and I want to read the diff myself.

The reviewer and challenger default to another family so the second look does not share the builder's blind spots. It also spreads the work over more than one allowance, which is the point of connecting several providers.

Glide turns automatic handoff on. Without it, the first usage limit ends the chain. I keep the checkbox visible and editable so I can see and change it. If I want Glide's permission rules without provider moves, I turn the checkbox off.

Balanced asks only for the actions that leave the scratch copy or cannot be undone from it. Reading files and running a read-only command cost nothing to allow. A delete, a network call or an edit outside the copy can lose work or send data out, so those go to me.

The handoff modes differ in what they protect. Most allowance left keeps the largest buffer. Resets soonest uses allowance that is about to vanish. Even spend uses every window at the rate it can afford and is what I want most of the time. Local first is for work where a local model is good enough and the subscriptions should stay full. Most allowance left is the default for new threads because it needs no reset times to work.

I ruled out a Manager role this wave. A Manager would decide which role runs next and when to stop, and that makes model output the authority over the chain. The chain is a short fixed sequence the controller can run without one, and I want to see it work before I add a role that steers it.

I ruled out letting the model grant itself permissions. [ADR 0002](0002-authority-in-deterministic-code.md) keeps permissions in the controller. The Balanced rules are code that reads the request, the kind of action and the path. The reviewer and challenger run read-only, and nothing the thread allowed reaches them.

## Consequences

- A chain multiplies usage. A change with two fixes costs a build, three reviews, two fixes and a challenge, six or seven turns against one. Each counts against the provider's allowance. Solo and Manual are the settings that cost nothing extra.
- The chain depends on the reviewer stating `Findings: N`. A reply without that line ends the chain and tells me to ask for a fix or review again. A reviewer that miscounts changes the outcome, and I have no check on its count.
- The Balanced command rule reads the command text. It is a fixed list, and a command it cannot parse as read-only goes to me.
- A delete is known from the client's own change type. The permission event carries a deletes mark, set by the OpenAI adapter from the patch and by the Google adapter from the delete and move kinds. The Anthropic and Local clients delete only through shell commands, which Balanced already sends to me. A client that deleted through a file tool without naming it would pass as an edit inside the copy, and the removed file would still show in Changes before Accept.
- Glide with automatic handoff on can move a step to a provider I did not pick. Every turn carries its provider badge and the handoff line, so the move is visible, and I find out afterward.
- Send now ends the running reply early. The stopped turn's work stays in the scratch copy and travels in the packet, and the partial reply stays in the thread.
- Presets live in the renderer's local storage, one set per machine. They are not part of the project or the controller's state.
- The chain, Send now and Balanced's rules have fixture coverage and no live run on record. [Provider routes](../providers.md) says Live qualification pending for each provider.
