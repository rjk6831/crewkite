# 0057. A recipe is one file in the project, and only a version I saved runs

- Status: Proposed
- Date: 2026-11-18

## Context

A plan run splits one request into slices, builds them in parallel on isolated copies, gates each slice and merges the results ([ADR 0045](0045-the-orchestrator-proposes-and-the-controller-assigns.md)). Its setup lives on the thread: the crew, the flight mode, the permission policy, the checks and the handoff setting. When the thread ends, the setup that worked ends with it. The next request starts from defaults, and I rebuild the same crew by hand.

Saved crews keep which model plays which role. They live in my home, so a project cannot carry one, and they say nothing about checks or how a run asks.

I want to keep a setup with the project, run it again on a new request, and let anyone on the project read what it does.

## Decision

- A recipe is one JSON file per recipe, in a project folder the person picks. The picker offers `.crewkite/recipes`.
- The file holds a name, a description, a shape, a crew, the run settings, the checks and a trigger, and for a schedule a budget and the source of its work ([ADR 0058](0058-a-schedule-cannot-be-saved-without-a-budget.md)).
- The crew maps each role to a provider, a model and an effort, and it has an orchestrator, since a recipe run is a plan. The run settings are the flight mode (Balanced or Glide, because Manual runs no plan), the permission policy, the handoff settings and the largest number of slices.
- The shape is change or report. A change run edits files and ends ready for Accept. A report run only reads, has the challenger argue against its findings and ends with one message. The first release keeps report runs behind a switch that is off: a report recipe with no trigger saves and does not run, and one with a trigger is refused at the save.
- A recipe is data. There is no script runtime. The controller runs a recipe through the same typed plan and lane contracts as any other plan ([ADR 0002](0002-authority-in-deterministic-code.md)), and the orchestrator still splits each request into slices at run time, inside the recipe's slice limit.
- The file holds only what the plan runner honors. The runner fixes the order of steps and the role that takes each one. Every enabled check runs at every gate. The challenger runs once, after the last slice. The file has no field for any of these.
- The controller records each saved version and its hash. Saving writes the file in the person's working tree after they confirm the diff, and commits nothing. A save that would overwrite an edit made on disk refuses.
- Only a recorded version runs. A file that changed on disk, or one CrewKite never saved, starts no run and arms no schedule until the person reviews it and saves it here.
- Every run records the hash of the version it used.
- A recipe names no API connection, and a run assigns none ([ADR 0056](0056-an-api-connection-spends-only-where-i-assign-it.md)).
- Saving a finished plan thread as a recipe drafts the file from what the thread did. The draft saves nothing until the person saves it.
- `schema: 1` versions the shape.

## Why

The file lives in the repository for the reason the design system does ([ADR 0055](0055-a-project-design-system-is-one-file-in-the-w3c-tokens-format.md)). There is one source. A recipe gets reviewed in a pull request like any other project file, and it travels with a clone.

I ruled out a script. A script that drives a run can raise its own limits, skip a gate or approve its own work, and then the rules live in whatever the script says that day. Data cannot do that. The controller reads the recipe and applies the same limits it applies to every plan.

The saved version is my approval. A repository is a shared place, and a pull can change any file in it. If the file alone could start a run, a commit from someone else could start unattended work on my subscriptions, with check commands I never read. So the controller runs the version whose hash it recorded when I confirmed the diff, and nothing else. A changed file shows its diff and waits.

I keep the file to what the runner honors because a file that states something the run does not do is worse than a short file. If the recipe said the fixer was one model while the runner picked another, I would debug the wrong thing. The cost is real. This version cannot move a step to another role, send chosen slices to Local, use different checks per stage or challenge each result. The runner would have to learn each of those first, and the schema number leaves room for them.

## Consequences

- A save is a working-tree change. The person commits it with the rest of their work.
- A recipe a teammate committed shows as not yet saved here. It runs after I review and save it once.
- A recipe from another machine can name a provider I have not connected. The run refuses with one line that names the provider.
- Saved crews stay as they are. A recipe carries its own crew and never points at a saved one, because saved crews do not travel with the project.
- The older task path uses the word recipe for a fixed check command. The two share the word. `crewkite recipe` is the saved setup, and `--recipe` on `task prepare-evaluation` is the check.
