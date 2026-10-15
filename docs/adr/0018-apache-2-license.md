# 0018. License CrewKite under Apache 2.0

- Status: Accepted
- Date: 2026-10-15

## Context

The first prototype was MIT. I want developers and companies to pick CrewKite up without a legal review slowing them down. I also want room to sell team and remote features later without touching the license on the core.

## Decision

- The core is licensed under Apache 2.0, with a NOTICE file.
- Paid features, if I build them (remote control, team accounts, a hosted relay), live in a separate repository or folder under a commercial license. The core never depends on them.
- Contributors sign off every commit under the Developer Certificate of Origin.
- The license covers the code. The CrewKite name stays mine.

## Why

MIT and Apache are both permissive open-source licenses, and either one supports an open core model. I picked Apache for three practical reasons:

- Patents. Every contributor grants a patent license, and anyone who sues claiming the project infringes their patent loses that license. Corporate legal teams approve Apache faster, and companies are the ones who would pay for team features.
- The name. Apache says outright that it grants no trademark rights. A fork can take the code. It can't ship as CrewKite.
- Credit. Anyone redistributing the code keeps the NOTICE file and marks the files they changed.

The cost is a NOTICE file and some care with GPLv2-only code, which this stack doesn't use.

I looked at AGPL and at source-available licenses such as BSL and FSL. They make it harder for someone to resell a hosted copy, and they also slow adoption. Source-available licenses don't count as open source at all. A paid tier is worth buying because of hosting, support and an active maintainer, and none of that comes from the license.

## Consequences

- Distributed builds ship LICENSE, NOTICE and third-party notices.
- I run a trademark search and register CrewKite before I charge for anything.
- Sign-off records that a contributor had the right to submit the code. It doesn't give me the right to relicense it. If I ever want to change the core's license, I need a contributor license agreement in place before accepting outside code.
- The old MIT prototype stays MIT for copies already out there.
