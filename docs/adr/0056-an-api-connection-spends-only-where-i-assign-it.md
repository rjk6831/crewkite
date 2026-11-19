# 0056. An API connection spends only for the thread or role I assign it to

- Status: Proposed
- Date: 2026-11-18

## Context

[ADR 0005](0005-official-clients-on-user-subscriptions.md) keeps CrewKite on my own subscriptions and rules out any automatic move to paid API use. Some people want API billing on purpose: a team key with its own budget, or a model their plan does not include. The official clients support it. OpenAI's app server signs in with an API key and reports the account type it signed in with. Anthropic's client signs in through the Console's API key flow in a configuration folder of its own.

CrewKite picks a family on its own in several places: a handoff after a usage limit, a turn whose credits are paused, a plan slice the handoff rule moves out of the crew, every ranking mode, and the default the composer and the CLI preselect. Credits can already carry a family past its allowance when I allow it ([ADR 0052](0052-credit-spending-is-a-per-provider-switch-that-defaults-off.md)). If an API connection counted as one more connected route, any of those paths could start spending on it, and a subscription limit would turn into an API bill without anyone asking.

## Decision

This record amends the subscription scope of ADR 0005 and leaves that record's text as it is. An API connection signed in through the official client is allowed, under these rules.

- A subscription stays the default. Each family has its own route: its subscription sign-in, or Local, which bills nothing.
- An API connection is a record of its own: connection ID, family, backend, the billing mode I chose, its owned client profile, Keep connected, readiness, a proof generation and the mode its client last reported. It holds no key. The client keeps the credential in the connection's own profile, and no key goes into arguments, logs, receipts or exports.
- An API connection runs a turn only for the thread or the crew role I assign it to, and the assignment takes explicit consent. A role's assignment does not reach its sibling roles. A thread's assignment reaches every role on that family. No assignment reaches another family.
- The catalog never counts an API connection as connected. Ranking, defaults and preselects read the catalog, so none of them reach one.
- An automatic move never lands on an API connection. A usage limit, a credit pause and the plan's handoff rule move work only to another family's own route. When nothing qualifies, the thread offers a manual choice.
- A turn on an assigned connection never moves to another connection on its own.
- A turn starts only when the mode the client last proved is the mode I chose, on an adapter that can run that mode in the connection's profile. The controller checks again right before the adapter sends. A mismatch, an unknown mode, Disconnect or Forget refuses the turn and nothing is sent. A change the adapter sees after sending stops the turn and leaves its cost unreported.
- Keep connected is off for a new API connection. After a restart no earlier proof counts. A kept connection keeps its assignments, and its client reads the mode again outside any turn. It replays nothing and starts no work. One not kept stays disconnected until I reconnect it.
- Disconnect ends availability and keeps the record and its assignments, so an assigned turn is refused with a reason. Forget removes the record and its assignments and asks the client to sign out the owned profile. It never touches a sign-in CrewKite does not own. Both stop a turn running on the connection. A proof from a turn or a restart leaves a disconnected connection as it is. My own check is the one that brings it back.
- Each API turn records its connection and its spend. Reported, estimated and unreported stay separate. An estimate names its basis and the date of its prices. A turn that reported nothing counts as unreported.
- The rail keeps one row per family. Each API connection gets its own line under its family, with its spend and never a percent. Unknown spend never reads as $0.
- Local keeps billing mode local and its own setup, and never gets an API line.

## Why

The failure I care about is a bill nobody chose. One route function decides which connection a turn uses, and the catalog the selection paths read never holds an API connection. A selection path added later inherits the rule without knowing it exists.

I ruled out treating an API connection as one more connected family with a lower rank. The ranking, the credit rule and the plan's handoff rule would each need an exception, and the one that forgets it spends money. I also ruled out moving a turn from one connection to another when it fails. A different key or account means a different payer.

The check right before sending costs one database read. Between the click and the send a proof can go stale: I disconnect, the client signs in with another account, or the app restarts. Admitting on the old proof would be the surprise the rule exists to stop.

Clients report cost differently. One reports a cost per turn, another only tokens, and a running session total counts a resumed turn twice unless it is split. Showing $0 for a turn nobody priced would be false on the one line meant to prevent surprises.

## Consequences

- An API connection does nothing until I assign it to a thread or a role.
- When an API connection hits its own limit, the turn stops and stays there. The limit card still offers the switch.
- Each adapter declares the billing modes it can run in a connection's profile. A family whose adapter declares no API mode refuses an assigned API turn with "Provider API billing is not verified for this client."
- CrewKite cannot tell when a key is swapped for another key of the same mode. It shows only the identity facts the client reports.
- A provider that needs a key CrewKite itself holds needs its own record, extending the device-encrypted pattern of [ADR 0043](0043-remember-the-local-token-on-this-device.md) to cloud keys.
