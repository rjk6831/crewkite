# Design history

I chose CrewKite for my daily coding work across local models and official subscription clients. The design centers on finished work, explicit authority and recovery from the files the controller already holds. The [ADRs](adr/README.md) record the decisions and their costs.

## Decisions that shaped the design

| Decision | Reason |
|----------|--------|
| Keep local planning optional | A lower planning cost means little if work takes longer to finish. I will measure it against completed tasks. See ADR 0001. |
| Put authority in the controller | A model cannot approve its own effects or raise its own limits. Admission and acceptance need deterministic checks. See ADR 0002. |
| Use a separate Node controller | The desktop app and CLI need one permission path and one durable task history. See ADRs 0003 and 0004. |
| Allocate by observed allowance and reset windows | I use four route families with different reset schedules. Unknown usage must stay visible. See ADR 0006. |
| Recover from durable facts | A stopped provider may never write a final summary. Files, criteria and denied actions must survive without it. See ADR 0007. |
| Isolate writers | Shared writable Git metadata lets one attempt damage another. Results publish as new local branches. See ADR 0008. |
| Trust official clients for supervised first use | A custom containment layer costs time and needs its own qualification. I state the first release's trust boundary explicitly. See ADR 0009. |
| Keep authority, quality and effects independent | Choosing a thorough review must not grant broader permissions. See ADR 0010. |
| Build a small fake journey first | Scripted providers expose controller failures without touching live accounts. Qualification comes later. See ADR 0012. |
| Reuse selectively | Adopting a large codebase also adopts its authority model. I record provenance for any code I reuse. See ADR 0016. |

## Scope

CrewKite is a coding workspace. Role, route, model and effort choices stay visible. I ruled out a general no-code builder and a broad routing gateway because they serve a different workflow.

CrewKite is the working name. Trademark clearance remains open before a commercial launch.

## Credits

Three open-source projects shaped the review methods:

- [Ponytail](https://github.com/DietrichGebert/ponytail) for the simplicity lens and the build-less ladder in CONTRIBUTING.md
- [ADHD](https://github.com/UditAkhourii/adhd) for bounded assumption challenges during planning
- [multi](https://github.com/szarkans/multi) for independent and round-robin review

CrewKite implements its own versions of these methods as finite jobs. No code from them is copied.
