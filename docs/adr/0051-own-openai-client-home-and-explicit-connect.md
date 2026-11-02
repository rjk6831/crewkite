# 0051. The OpenAI client runs in a home of its own, and every provider connects explicitly

- Status: Proposed
- Date: 2026-11-03

## Context

CrewKite ran the OpenAI client with my own home and client configuration folder, so every saved thread it opened landed in the client's own desktop app on my computer, grouped by a scratch folder per thread. Hiding them took the client's experimental project registry, and whether the desktop app reads it is not public. Sharing my sign-in file with a second home does not work either, because the client rewrites that file when it refreshes the token.

The same launch also started provider work before I had asked for it. On a fresh device the controller read quotas, listed models and ran Google setup steps as soon as it found a client.

## Decision

CrewKite runs the OpenAI client in its own home, a private folder under `<CrewKite home>/providers/openai/`, for every process it starts: chat turns, quota reads, model reads and sign-in. One function in `apps/controller/src/providers/openai/native-discovery.ts` builds that environment. The home signs in once through the client's own app-server sign-in, started by Connect on the OpenAI card, and the client keeps and refreshes the sign-in there. Sign out on the card goes through the same app-server. Nothing reads or copies my own sign-in file, and a configuration folder I set for my own use is ignored. [Provider routes](../providers.md#openai) names the methods.

Every provider connects once per device, by a click. The controller keeps one connected-once record per provider. Without it no quota read, model read, sign-in check or Google setup step runs on its own. With it, every launch reconnects that provider with no click. Anthropic keeps the client's own home and sign-in. Local reconnects the saved endpoint, with the remembered token when the runtime's auth is on and with the endpoint alone when it is off. A card asks again only when that provider's own credential expired or was revoked.

## Why

A separate home is the one way to keep CrewKite's threads out of my own client app that does not depend on an experimental API or on how the app groups threads. It costs a second sign-in, once per device, and that sign-in uses the client's own flow, so CrewKite never handles a token.

Explicit connect makes the first launch quiet and makes consent a recorded fact the launch can check. I ruled out treating an installed, signed-in client as consent: finding a client says nothing about whether I want CrewKite to use it.

## Consequences

- A device upgraded from an earlier build has no record yet, so each provider needs one click after the upgrade.
- The OpenAI client's threads, config and logs for CrewKite live under the CrewKite home. My own client config does not apply to CrewKite's turns.
- Finding a client and reading its version still run at launch, because the cards show what is installed.
- Sign-out and Local Disconnect clear the record, so the next launch asks again.
