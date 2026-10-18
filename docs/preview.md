# Trying the preview

This guide gives one practical sequence for trying the candidate on a real project. You need a local Git repository and any provider client you plan to use.

## Start a task

1. Open the normal candidate. Packaging details are in the [distribution notes](distribution.md).
2. Choose Add project and select the exact Git repository root.
3. Choose New task, select that project, and read the planning permission before sending anything.
4. Review the explicit provider setup in Usage and capacity. Details are in the [provider routes](providers.md).

## Plan before coding

Planning and coding are separate. Send a bounded objective, then read the answers, criteria and scope. Choose Adopt plan only when they match your intent. Adoption saves the task contract and starts no coding work.

Execution is a second step. Prepare the source, permissions and finite limits, review them, then choose Start.

A material model or effort Save creates a linked planning run and returns the contract to provisional, so adopt a fresh valid plan before preparing execution again. Make material planning changes before execution begins, since that Save is scoped to the discussion. Once an execution run exists, it is retained, and material planning changes are unavailable there. Ordinary messages remain guidance and do not replace that run.

## Review the result

Open Changes to inspect the retained work. Checks and review are separate actions with their own permissions. A passing result still needs your approval for that destination before CrewKite creates one new local branch. Nothing merges, checks out, pushes or publishes, and your original checkout stays unchanged.

## Stop and reopen

Use Stop to end active work. Reopening the same home launches nothing. An uncertain command keeps its original receipt, so you can retry that exact command. Unresolved ownership is shown as such and gives no permission to relaunch the work or treat it as complete.

## Providers

Local uses a dedicated token by default. The packaged app asks for it and keeps it in controller memory, so it is requested again after a restart. An explicit CLI configuration can instead select no authentication, limited to this device's loopback address. The main interface has no selector and never switches modes automatically. See the [provider notes](providers.md#local-models) and the [CLI guide](../apps/cli/README.md). Model eligibility is not qualification. An eligible model stays unmeasured until separate evidence covers it.

## Usage and context

Usage shows reported or last-observed values with their source and time. Missing data appears as unknown. CrewKite does not estimate how full a window is from tokens, and it does not infer quota from them. After a successful OpenAI planning turn, the composer can show last-observed context tokens and reported capacity. Without reported capacity, the percentage stays unknown.

## Send a short record

Keep a short record of the concrete result you observed, any refusal, the changes or evidence retained, how Stop and reopen behaved, and whether the next action was clear. A few sentences is enough. The [roadmap](roadmap.md) lists the open evidence gates.
