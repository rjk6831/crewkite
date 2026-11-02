# Crew and permissions

A thread has two controls that decide how much happens without me. Flight mode decides what runs after my message. The Permissions policy decides which asks the client or CrewKite answers for me. They overlap in Balanced, so this page lays out both. [ADR 0038](adr/0038-crew-and-flight-modes.md) records the flight modes. [Provider routes](providers.md#chat-adapters) holds the per-client detail.

The scratch copy is the thread's own working copy of the project. Nothing a turn writes there reaches the project until I accept it.

## Flight mode

| Mode | What runs after a builder turn | What asks | What runs on its own |
|------|--------------------------------|-----------|----------------------|
| Manual | Nothing. Every step is a message. A plan waits for Run on each slice or Run plan. | Whatever the Permissions policy says. | Nothing beyond the policy. |
| Balanced | The reviewer, up to two fixer rounds, the challenger, then one closing line. A plan waits for Run plan, with a family picker per slice. | A command outside the read-only set, network access, an edit outside the scratch copy, a delete and any tool CrewKite cannot classify. The Permissions policy does not apply to the builder. | Read-only commands inside the scratch copy, edits inside it that are not deletes, and the project checks after each fix. |
| Glide | The same chain, to the end. A plan starts at once and shows Stop. | Only what the Permissions policy does not cover. | Read-only commands inside the scratch copy, and everything the policy allows. |

A thread with no crew is Manual. Entering Glide turns automatic handoff on. If I turn it off, Glide stops on a usage limit like the other modes.

The read-only set is `ls`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `find` and the git subcommands `status`, `diff`, `log` and `show`. A command the check cannot parse as read-only goes to me.

Balanced starts every builder turn with the client set to ask each time, and the controller answers the safe asks itself. That keeps the Permissions policy from loosening what Balanced asks about.

## Permissions policy

| Policy | Client mode at launch | What CrewKite answers | What asks |
|--------|-----------------------|-----------------------|-----------|
| Ask each time | OpenAI asks for every file change and for every command outside its short read-only list. Anthropic runs in its default mode. Google asks for every tool call it routes to permission. | Nothing, except kinds I allowed for the thread and, in Balanced and Glide, read-only commands inside the scratch copy. | Every edit, every command and network access. |
| Allow edits | OpenAI asks as above and CrewKite answers edits inside the scratch copy. Anthropic runs in accept-edits mode. Google asks as above and CrewKite answers edits inside the copy. | An edit whose reported paths all lie inside the scratch copy. | Commands, network access, an edit outside the copy, an edit that names no path and any tool CrewKite cannot classify. |
| Allow all | OpenAI lets its sandbox decide and asks only to leave it. Anthropic runs in accept-edits mode and CrewKite answers every tool ask. Google answers every ask that offers an allow. | Every command, and every edit inside the scratch copy. | An edit outside the copy. Network access under OpenAI. A tool of one of my MCP servers above the ceiling I set for it. |

Three things apply to every row:

- Allow for this thread records a kind of action, such as commands or edits, and answers it in later turns. It never covers a tool CrewKite cannot classify and never covers a file outside the scratch copy. Choosing Ask each time again clears the grants.
- Under Allow all with the Anthropic client, every command and tool call the model proposes runs without a question, network fetches included. The sandbox that limits OpenAI is not there. [Provider routes](providers.md#anthropic) says more.
- A delete counts as an edit under Allow edits and Allow all when its path lies inside the copy. Only Balanced asks about deletes. The OpenAI and Google clients report a delete in their own change type. The Anthropic client deletes through shell commands, which Balanced already asks about.

## Roles that only read

The reviewer, advisor, challenger, orchestrator, the side question and a read-only slice never write to the scratch copy. They ignore both controls, and allowed kinds never reach them.

- OpenAI runs them under a never-ask policy in a read-only sandbox narrowed to the scratch copy.
- Anthropic allows Read, Grep and Glob and declines any ask.
- Google and Local refuse writes in the adapter.

A turn that only reads can run while another turn does. The controls above describe the builder, so they hold whichever role runs beside it.
