# The Google metadata hold

One interrupted Google quota read kept my installed 0.1.0 from reading Google for at least five days while the card said Ready. This page records the incident and what 0.2.0 changes. [Proposed ADR 0054](adr/0054-release-a-google-metadata-hold-once-its-owner-is-proven-gone.md) records the decision and its reasons.

## What failed

At 23:59 UTC on 7 November 2026, a Google quota read started on my installed 0.1.0. Its journal row recorded a process group and never recorded an end. The last successful reading had landed a minute and a half earlier.

Quota reads, initialize, sign-in and discovery share one metadata gate per home, so two Google client processes never run side by side. 0.1.0 marked an unfinished row unknown at startup and kept it unknown across every restart. The only path that could settle a row whose group was gone was Stop on an unknown setup step, and that needs a setup step in progress. My setup was Ready with no step in progress. Nothing in the desktop or the CLI could reach the row.

On 13 November the card still showed Google as connected and its setup as Ready. The quota bars were about 132 hours old. Refresh answered "That did not go through. Try again." The controller had refused each of my three refreshes with `google-ownership-unknown` and started no read. The card dropped that reason because the refusal carried no next step, and it took a Ready setup as proof that the connection worked. Reconnecting or updating could not help, since every setup step waits on the same gate.

## The stale model list

Discovery reads the models the Google agent offers and keeps them with the setup proof. Once setup was Ready, 0.1.0 never ran discovery again, and the card hid Connect. The picker kept listing the two models from the last discovery as live, with no age. Check again checks the separate quota client, and the model refresh command covered OpenAI only. My account has access to a model that list never showed.

The quota client and the coding agent are separate installs. The quota client was at 1.4.2. The managed agent that discovers models stays pinned at 1.4.0 until I qualify a newer build, and updating the quota client does not touch it.

## What I do not know

The controller log shows the three refreshes and a successful connection check. It says nothing about what interrupted the read on 7 November. A process list taken on 13 November found nothing with that group number. That proves the group was gone at that moment and says nothing about any later one, because the number can be reused. I have no evidence that the sign-in expired or that Google refused the account, and I do not assume either.

## Ownership and result

The journal kept one state for two facts: whether a process that could still write is alive, and what the read returned. A later probe can answer the first. Nothing answers the second once the process is gone. 0.1.0 kept both unknown, so the gate stayed shut over a question nobody could answer.

The journal also could not tell how a settled row ended. A row that closed normally and a row released by Stop both read as settled, so a late answer from a released command could still publish.

## What 0.2.0 changes

Startup, a new Recover action and Stop on an unknown setup step share one rule. When a row has a recorded process group and no Google runtime or pending start remains in this controller, the controller sends signal 0 to that group. Only `ESRCH` releases the row. The row settles as owner absent, with its receipt and evidence, in one transaction. Its result stays unknown. Earlier quota readings keep their times, and Ready and the setup proof stay. Nothing replays. Signal 0 is the only call, and recovery never sends a real signal to a historical process number. On a home like mine, the next startup releases the read as long as no process holds that group number.

An interrupted sign-in is the exception. A browser sign-in can finish after its client exits, so startup never releases one. Recover does, after the same probe. The sign-in then reads as unknown, nothing discovers on the old proof, and the card asks me to sign in again.

Each settled row now records how it ended: closed, never spawned, owner absent, or legacy for a row an older build settled. Only a closed row publishes, and the publishing transaction checks the live setup or reader revision first. A late answer from a released command publishes nothing and leaves newer setup state alone.

The Google card lists every operation that holds the gate, with its reason, also while setup reads Ready. It offers Recover only for a row it can release. Every provider card states sign-in, models, quota age and any blocker as separate facts.

Read models again runs discovery from Ready under the same gate. Setup stays Ready while it runs. A failure keeps the earlier list and stores why it failed. A lost sign-in is the one failure that leaves Ready, because the proof no longer holds. The CLI has the same two actions as `native setup recover` and `native setup refresh`.

Each quota read made two folders in the home, and nothing removed them. By 13 November my home held 3,326 of each. Once every metadata row has settled and no Google operation runs, recovery removes folders whose names match what a quota read creates. It works in batches of 32 and checks the gate again before each batch. A folder that is a link, is not mine or is open to other users stays.

## Tests

The tests run on real SQLite in temporary homes with scripted clients. None of them touched my installed home.

- `apps/controller/src/commands/google-recovery.test.ts` rebuilds the incident shape: a Ready setup beside an unknown discovery row whose group is gone, with and without a model refresh in progress. It first shows the incident, Ready with the gate held and the reason listed. After a restart the row has settled as owner absent, Ready, the proof and the sign-in stay, nothing launched, and a new discovery is accepted.
- The incident row itself was a quota read. The quota restart test in `apps/controller/src/store/controller.test.ts` covers that kind. Startup sends one signal 0 probe to the recorded group, settles the read, keeps the last reading's time, replays nothing and lets a new read run.
- A table in `google-recovery.test.ts` checks the rule. `ESRCH` releases a row. A refused probe, a group that answers, a row with no group, a running read and an interrupted sign-in at startup each hold with their own reason. The only calls are signal 0.
- The same file checks that a late completion after recovery publishes nothing and leaves newer setup alone, and that only a person releases an interrupted sign-in.
- `apps/controller/src/commands/google-model-refresh.test.ts` checks that a refresh from Ready replaces the list, that a failed refresh keeps Ready, the proof and the list with its evidence, and that a refresh is refused while another operation holds the gate.
- `apps/controller/src/commands/google-usage-sweep.test.ts` checks that the sweep removes only folders shaped like the ones a quota read makes, removes nothing while a Google operation could own a folder, and stops between batches once one could.

## Upgrade evidence

Version 0.2.0 moves the database from schema 21 to 27. A test fills a schema 21 home with the state 0.1.0 writes, upgrades it and checks every unchanged table byte for byte. Its three Google rows come out as the rule expects: a settled row with a group reads legacy, one with no group reads never spawned, and a row still owned stays open for recovery to judge. [Releases](releases.md#version-020) covers going back to 0.1.0.

An installed upgrade of my own home is not done. Neither is recovery on that home, or a fresh quota read and model refresh there. Until they are, this page describes tested code, and the incident stays open on the machine where it happened.

## What still holds

- A group that still answers. Its number may belong to another program by now, and a probe cannot tell. The row holds, and the card says CrewKite cannot confirm the operation ended and asks for diagnostics. A later probe that finds the group gone releases it. I accept a false hold here, since the gate exists so that two Google client processes never run on one home.
- A row with no recorded group. The process may have started before its group was written down, so nothing can prove it gone. The row holds through every restart, and 0.2.0 has no action that clears it. Other providers keep working.
- A home moved between machines. A probe answers for this machine only. 0.2.0 records boot and machine digests before each launch and compares nothing yet, so a home copied from another machine looks local. Do not move a home that has a held row.
- An escaped descendant. A process that left the recorded group survives `ESRCH`, and this rule does not contain it. I accept that here because none of these operations sends a prompt, writes to a project, replays or publishes its released result. The client may still write its own cache or session files. The folder sweep proves nothing about such a process.
- The model my account has. Read models again lists what the pinned 1.4.0 agent offers. If that list still leaves the model out, the next step is a qualified upgrade of the agent.
