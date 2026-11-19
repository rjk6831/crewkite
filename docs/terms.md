# Terms

Five words name the parts of a project's setup in CrewKite: context, hooks, loops, graphs and results. This page says what each one is here and where it lives. The file on disk and the CLI use one more word. A recipe is a graph with its hooks and its loop, saved as one JSON file in the project ([Proposed ADR 0057](adr/0057-a-recipe-is-one-file-and-only-a-saved-version-runs.md)).

| Term | What it is here | Where I set it | Where it is kept |
|------|-----------------|----------------|------------------|
| Context | What a turn is given before it starts. The project notes go to every turn. The writing rules and the project's design system go to every turn that writes. | Settings: Writing rules, Design system, Project notes. | Writing rules and notes in the controller's database. The design system as one file in the project ([Proposed ADR 0055](adr/0055-a-project-design-system-is-one-file-in-the-w3c-tokens-format.md)). |
| Hooks | Checks that run on their own: after each turn that writes and after each merge of a slice, in Balanced and Glide, and at Accept. | A thread's Crew tab. The Hooks section of a recipe. | Per thread in the database. In the recipe file, for runs of that recipe. |
| Loops | A recipe's trigger, budget and work source. A recipe that has them starts on its own, inside the budget. | The Loop section of a recipe. The Loops view lists them and pauses, resumes or restarts one. | The trigger, the budget and the work source in the recipe file. The state and the counts in the database ([Proposed ADR 0058](adr/0058-a-schedule-cannot-be-saved-without-a-budget.md)). |
| Graphs | A crew and the order its steps run in. | The Graph section of a recipe. | In the recipe file. |
| Results | One record per step of a plan: who ran it, what the first check and the first review said, and what became of the change. | Nothing to set. The Results view shows counts, and `crewkite results` prints and exports them. | In the controller's database, on this device ([Proposed ADR 0059](adr/0059-results-stay-on-the-device.md)). |

The Project setup card in Settings shows all five for one project, with one line each on whether it is set up and a button that opens the place that changes it.

## One graph shape

This release has one fixed graph shape. A run splits the request into slices, builds each slice in its own copy, runs the checks, reviews, fixes what the review found, merges, runs the checks on the merged copy, has the challenger argue against the result once, and stops at ready for Accept. A recipe picks the model for each role and how many slices a request may split into. CrewKite sets the order and which role takes each step. A recipe cannot add a step, drop one or change the order. A step whose role the crew does not have is left out, so a crew with no reviewer has no review. A failing check still gets a fix, from the fixer or, in a crew with no fixer, from the slice's builder.

A report recipe keeps the split and the challenge. Its slices only read, it has no review, fix or check, it merges nothing, and it ends with one closing message from the orchestrator. Report runs are off in this release. A report recipe with no trigger saves, one with a trigger is refused at the save, and running one is refused with a sentence that says so.

Graphs I can draw myself are not in this release.

## What the CLI calls them

The CLI shares the word loop: `crewkite recipe list`, `crewkite loop list`, `crewkite results`. `crewkite recipe show` prints a recipe's crew and its checks under those two names. Inside the controller the stored names still say schedule, in the table `recipe_schedules` and in commands such as `ReadSchedules`. They show in `--json` output and nowhere else a person reads, so they stayed.
