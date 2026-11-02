# 0049. Provider setup sends again without receipt replay

- Status: Proposed
- Date: 2026-11-03

## Context

The desktop writes every change that carries an expected revision to a receipts file before it sends it. A lost or late answer leaves the receipt in place, the page shows "An action has an uncertain outcome", and every other change is refused until I press Retry exact command. That replay is right for the commands [ADR 0028](0028-journal-project-commands-and-remote-effects.md) cares about, where a second send with a new key could push twice or open a second pull request.

Local setup went down the same path. In the d3-rc10 candidate I pressed Local Connect during a Google Connect. The controller was busy for longer than the desktop's 5 second deadline, so the answer came back as `response-timeout`. The card printed that code, the uncertain-outcome banner came up, and the Local buttons locked. Retry exact command resent the same key, the controller answered from its receipt, and nothing visible happened. The connect had applied the first time.

Provider setup commands are already safe to send again. The same key returns the saved answer. A new key while a connect or model read runs is refused with `local-operation-active`, and the card waits and sends again. A changed revision is refused with `stale-revision`. The Google terms acknowledgement writes the same record each time.

## Decision

Provider setup commands carry no desktop receipt and no exact retry. The set is ConfigureLocal, BeginLocalConnectionInput, CancelLocalConnectionInput, DisconnectLocal, RefreshLocalModels, SelectLocalModel and AcknowledgeGoogleTerms.

- The desktop sends them without the busy lock and without writing a receipt. A receipt an older build left for one of them is not loaded.
- They never announce a retry, so they never raise the uncertain-outcome banner or lock another change.
- BeginLocalConnectionInput on a setup that is connected, with a current read and no operation, is a no-op. A repeat press keeps the model selection.
- A lost or late answer reads on the Local card as "Local did not answer in time. Press Connect again." No card prints a raw reason code.
- Local commands wait up to 20 seconds for an answer, the window the controller gives a model read.

Every other change keeps its receipt and its exact retry. This record narrows where receipt replay applies and leaves ADR 0028 as written.

## Why

A receipt exists so a change whose outcome is unknown is never repeated blind. For provider setup, repeating it is the recovery, and the controller already makes a repeat harmless. Keeping the replay there bought nothing and cost a banner, a lock and a button that did nothing visible.

I considered keeping a silent receipt for crash recovery with no announcement. It would still hold the lock on every other change while it sat there, and the person would have no way to clear it. I ruled it out.

## Consequences

- A setup command whose answer was lost may have applied. The card reads the setup again and shows what is true. Pressing Connect again is safe because of the no-op above.
- Making a new setup command means making it safe to send again first, then adding it to the set in `apps/desktop/src/main/receipts.ts`.
- The banner on the page still shows for every other change that keeps a receipt, such as starting a run or a chat turn. Narrowing it to the candidate, source and publication changes needs the notice to name the command, and a separate decision on what those other commands show.
