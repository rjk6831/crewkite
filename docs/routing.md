# Usage and routing

CrewKite assigns work using what each subscription reports about remaining allowance and reset timing. This page defines how it reads usage and how the router decides.

## Usage observations

Each route has one or more windows: a rolling short window, a weekly window, a model-specific bucket, or a shared pool. The controller stores every reading as an observation:

| Field | Meaning |
|-------|---------|
| Route and window | Which account, model scope and window the reading belongs to |
| Value and unit | Used or remaining amount in the provider's own unit |
| Reset time | When the provider says the window resets, if it says |
| Observed at | When the reading was taken |
| Source | Provider report, client output, local counter or manual entry |
| Confidence | Reported, estimated or inferred |

Rules I hold the router and the UI to:

- Missing data is unknown. It never becomes zero usage or full allowance.
- A percentage needs a real denominator from the provider. Tokens generated or calls launched never become a quota percentage on their own.
- Each window stands alone. A reset of the short window does not refill the weekly window.
- When the clock passes a reset time, the window becomes reset-pending. It returns to normal only after a fresh observation confirms the reset.
- An HTTP 429 is evidence of a limit on that window. It is not proof of weekly exhaustion.
- Redrawing a gauge does not refresh it. The observation time stays visible.
- Other apps and machines can spend the same account. The controller reserves only what it dispatches.

Unlike units never combine. Subscription windows, API credits, local hardware and CI minutes appear in separate views.

The chat picker and the handoff ranking count a model-scoped window only for models whose ID carries the window's model tokens, and a provider or pool window for every model. Google writer admission keeps the exact-ID exemption in [Google quota read](providers.md#google-quota-read) and counts that pool for every other model.

A chat thread picks the next provider on a limit with one of four handoff modes, set per thread. Most allowance left takes the highest percent remaining on the tightest window. Resets soonest takes the allowance that resets first while it has any left. Balanced divides percent remaining by hours until reset and takes the highest, counting any reset closer than fifteen minutes as fifteen. Local first takes Local while it is connected and ranks the rest as Balanced. Every mode skips a provider that is not connected or has no allowance left, and ranks a provider with no reading last. [ADR 0038](adr/0038-crew-and-flight-modes.md) records the modes.

## Routing sequence

The router is a deterministic function of the task, the resolved policy, the observations, the reservations and the clock. Given the same inputs it returns the same route and the same reasons.

1. Filter by hard rules: cancellation, privacy and data destination, required tools, model capability and explicit role pins.
2. Resolve every window that applies to each candidate route. Apply the stale or unknown usage policy the user chose.
3. Subtract controller reservations. Keep the configured review and recovery headroom.
4. Filter by slot capacity: per route, per provider, per role, local residency.
5. Apply the role's saved selection rule: ordered priority or reset-aware preference.
6. For reset-aware selection, apply hysteresis and minimum tenure so small fluctuations do not bounce work between providers.
7. Recheck revisions and observations inside the admission transaction, reserve, and record the receipt with chosen and rejected routes.

A pin outranks every soft preference. If a pinned route becomes unavailable, the router uses only a fallback the user approved for that role. Otherwise the task waits.

Ordered selection chooses the first eligible route in the saved primary and fallback order. Reset timing and selection tenure do not move a later route ahead of it. Reset-aware selection keeps the reset preference below, with saved order breaking ties. A role without an explicit selection rule retains reset-aware behavior. Both choices pass the same hard admission gates. [ADR 0021](adr/0021-explicit-route-order-and-review-floors.md) records the proposed extension.

## Reset-aware preference

The preference spends allowance that would otherwise expire, while it protects enough capacity to finish and review the work. Thresholds attach to a specific window and can depend on time to reset, role and task class. The numbers below are examples I use to test the logic. They are not defaults.

At observation time, route A (OpenAI) reports 80% weekly allowance remaining with the reset in two days. Route B (Anthropic) reports 30% remaining with the reset in two hours. Both are allowed for the coding role and the task fits both. B may run down to a 5% reserve because it resets soon. A keeps a 40% reserve because it has to last two more days.

| Moment | Router action | Guard |
|--------|---------------|-------|
| Admission | Prefer B for useful queued work | Never start busywork to consume quota |
| B reaches its reserve | Stop new B admissions and request a bounded checkpoint | The reserve covers review and wind-down cost |
| Safe transfer | Seal durable state and assign the next eligible work to A | Prove the old writer stopped, then move the lease |
| Clock passes B's reset time | Mark B reset-pending | Time alone does not prove the reset |
| Fresh observation confirms the reset | Restore the base order for new admissions | Recheck every window, including weekly |
| A is mid-attempt and healthy | Let it finish | A reset elsewhere never kills good work |

If the telemetry for B is stale or only the reset time is known, the percentage rule is unavailable for B. The user picks a fallback: a fixed launch and time allowance, a manual threshold, or waiting for fresh data. The UI states which rule is active.

## Draining and local finish

When a configured threshold is crossed, the controller stops new admissions on that window and lets bounded work finish. A client that supports live control can receive one wrap-up instruction for the active turn. The controller still waits for the terminal event and tool quiescence before it treats the work as stopped.

A one-shot client with closed input cannot be steered after launch, so it receives its stopping instructions up front. At the deadline the controller cancels it, and durable recovery works from the files it already wrote.

In cloud-first, local-finish mode, the local route takes only work it is qualified for. Inheriting task state does not inherit cloud capability. When the local route is not qualified for the remaining work, the controller splits the task at a validated boundary, chooses another approved route, or pauses.

## Displaying usage

Open Usage and capacity from the sidebar or find it in Search.

Provider cards use only retained observations. A unique provider-scoped weekly or five-hour reading gets a primary gauge. Other model and pool readings stay visible as auxiliary limits; a single model-scoped reading can occupy the center gauge. Ambiguous primary matches remain separate. No provider name or guessed entitlement chooses a slot. Route and account scope remain visible, and equal values alone cannot merge separate routes.

The Usage view has four regions:

- Allowance cards: reported windows with their own unit, scope, reset time, observation time, source and freshness. Missing, stale and reset-pending values stay labelled. Credits and context-token counts never become a subscription percentage.
- Controller activity: recorded attempts by route in this workspace. Active minutes are not measured; these counts do not describe account-wide usage.
- Local hardware: the configured route model and "No provider quota". Hardware measurements remain unavailable. Local setup separately lists observed model state.
- Credits: the dashboard reports unknown account credit balances. Using existing credits requires an explicit billing selection in preparation; a provider allowance grants no spending permission.
