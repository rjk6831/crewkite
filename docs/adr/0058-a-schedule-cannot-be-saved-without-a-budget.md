# 0058. A schedule cannot be saved without a budget

- Status: Proposed
- Date: 2026-11-18

## Context

Until now, work starts when I type. Start at reset sends one stopped message again and nothing more. A schedule starts runs with nobody watching, on subscriptions whose allowance I also need for my own work.

Unattended loops fail in a few known ways. One runs forever. One spends the week's allowance overnight. One piles up results nobody reads. One repeats a run that does nothing. Each needs its own brake, and the brake has to sit outside the model.

Most of the brakes already exist for a single run: a check decides when work is done, state is saved at every step, repair is bounded and allowance is read from the provider. What is missing is the trigger, and the limits on the trigger itself.

## Decision

- A recipe ([ADR 0057](0057-a-recipe-is-one-file-and-only-a-saved-version-runs.md)) has a trigger: manual, once at a set time, every interval of at least 15 minutes, or when a provider's allowance window resets.
- A recipe with any trigger other than manual does not validate without a budget. The budget states the largest number of runs, a percent-used limit for every metered provider a run can reach, and the largest number of runs that may wait for me. That last number defaults to 3. With automatic handoff on, a run can reach every provider, so each one needs its limit.
- A run does not start while a provider its crew names reads above its limit. Inside a run the same check comes before every step the plan or the crew starts, on the provider that step runs on: the plan and its retry, each slice's build, review, fix and merge fix, the challenge and the report. A turn I send on that thread myself is not checked, since I am there to see what it spends. The plan's retry is the plan's own step and is checked whoever sends it. An unknown reading refuses the same way, and so does a metered provider the budget sets no limit for. Local has no allowance and is never checked. A reading 15 minutes old or older is unknown. CrewKite never estimates one.
- The schedule pauses while that many runs wait for me. A run that waits on a question counts, the same as one that waits for Accept.
- The schedule stops after two runs in a row that changed nothing and found nothing.
- The schedule stops at its run limit.
- A schedule starts no run while its newest run is still running. A run that waits on me does not hold the next start. It counts toward the waiting limit. Each run is its own thread in its own copy.
- A scheduled run never accepts, pushes, merges or opens a pull request. It ends ready for Accept and waits.
- A schedule never turns on credit spending ([ADR 0052](0052-credit-spending-is-a-per-provider-switch-that-defaults-off.md)), never assigns an API connection and never raises a permission. A run that needs an answer waits and sends the needs-approval event.
- Saving a schedule approves the recipe's check commands for its runs. The approval records what each command resolved to in the project and the digest a thread pins a check by, which covers the command and the script behind it. A run whose check resolves to another digest asks first. It is taken from the project's committed HEAD, which is what a run's copy starts from, and the save refuses when a script changed after the confirmation showed it. The approval lives in CrewKite's database and never in the recipe file.
- A schedule runs while CrewKite is open, and the screen says so with "Loops run while CrewKite is open." Open means the desktop or a CLI session is attached to the controller. A start that came due with nothing attached is skipped and logged, and the next launch makes at most one catch-up run.
- A schedule's work is a fixed request or the first unchecked item of a markdown checklist in the project. A checklist run proposes ticking its item as part of its change. The first release keeps checklist work behind a switch that is off, so a schedule takes a fixed request.
- Every pause, stop and skipped start has one plain line that says why.

## Why

I make the budget a condition of saving so that nobody runs a schedule on numbers they never chose. A default run limit would be a number I picked for a stranger's subscription. The form asks for it once, and the file shows it to everyone who reads the recipe.

An unknown reading refuses because the alternative is a guess, and a wrong guess spends the allowance I was trying to protect. A skipped start costs one interval.

The check approval covers the script because the command alone approves nothing. `pnpm test` runs whatever the project's test script says that day, and a commit from someone else can change it. A thread already asks again when a check's script changes. A schedule that skipped that question would run new code with nobody there.

The waiting limit counts questions as well as finished results. If it counted only finished runs, a recipe that asks before every plan would stack one unanswered question per interval until I came back.

Two dry runs in a row mean the schedule has nothing left to do or cannot do it. A third would tell me nothing new and would cost the same.

A scheduled run stops at ready for Accept because acceptance is mine ([ADR 0008](0008-isolated-writers-local-branch-acceptance.md)). I take that step for every run, including one that started while I was away.

Schedules run only while CrewKite is open because that is what the controller does today: it stops when the app quits. I could add a background service. It would be one more thing running on a person's machine with access to their subscriptions, and I am not ready to own that. One catch-up run keeps a week away from turning into a burst of starts.

## Consequences

- A schedule can sit paused for days. It resumes on its own once I accept or discard enough results, and the list says why it paused.
- The limit is checked before a run and before each turn. A turn that crosses the limit finishes. With credit spending turned on by the person, that turn can spend credits, which is the cost ADR 0052 already states.
- A checklist item is text from the repository that becomes the request of a run nobody watches. Whoever can change that file can steer the run, within the permissions the recipe grants.
- An approved check runs the code the builder wrote, such as new tests. The digest catches a changed script. It does not cover a test the builder added, so under a policy that allows edits a run steered through its checklist can still get code run by its checks. I accept that for a file the person picked, and I would not point a schedule with broad permissions at a checklist other people edit.
- A reset trigger depends on the provider reporting its reset time. Where the reading is unknown, the start is skipped and tried again later.
- A closed laptop runs nothing. People who expect overnight work must leave CrewKite open.
- Reading work from GitHub issues is not part of this. It needs a live read and its own decision.
