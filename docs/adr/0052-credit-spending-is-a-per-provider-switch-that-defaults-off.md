# 0052. Credit spending is a per-provider switch that defaults off

- Status: Proposed
- Date: 2026-11-04

## Context

OpenAI and Anthropic can keep a turn going after the included allowance runs out. OpenAI spends credits when the account has them. Anthropic spends extra usage when the account turned it on. Both bill money, and CrewKite never showed it. The rail read 0% while the provider kept answering, and the next message went to the same family.

OpenAI's rate-limit read already reports credits as available, none or unlimited, a decimal balance, a spend control and whether a limit was reached. Anthropic's usage read reports only whether extra usage is turned on. Google reports nothing about credits.

## Decision

- The OpenAI and Anthropic cards in Settings each get an Allow credit spending switch. The controller keeps it per family, and it defaults off. Google has no switch because it reports no credit state. Local has no limits.
- Turning the switch on says CrewKite may let work run on credits. It does not turn credits on. The provider's own setting still decides, and the card says so while the switch is on. CrewKite cannot override it.
- A family's included allowance counts as used up when the provider says its limit is reached, or when a window that applies to the selected model reads 0%. From then on its rail bar and its gauge in Settings show the credit state in the same bar. Before that nothing changes.
- The gate runs before a turn starts and never during one. With the allowance used up and the switch off, the turn does not start on that family. A crew step runs on the next family, a thread moves to the next connected family with allowance, and the next family never is one that is paused itself. A side question never moves the thread and gets a line. With no taker the thread gets a line and no turn starts.
- A turn that finishes on credits with the switch off ends normally. The thread gets one line, and the next turn goes through the gate.

## Why

Credits are money on the person's account. The safe default is to hand work to an allowance that is already paid for, and to make spending a choice made once per provider.

I gate only before a turn. Stopping a turn halfway leaves a half-edited scratch copy and a lost reply, and the credits already spent stay spent. Letting it finish and moving the next turn costs at most one turn of credits, and the thread says so.

## Consequences

- With the switch off, a family past its allowance takes no new turn even when the account has credits. Turning the switch on is one click in Settings.
- The provider reports credits after the fact. A turn that crosses the limit can spend credits before CrewKite reads it.
- The OpenAI credit state comes from the newest of the quota read and the last chat turn. Anthropic's comes from its usage read.
- A plan slice keeps its lane. It fails on the limit, and the plan hands it on as before.
