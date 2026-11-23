# 0061. Run the newest verified copy of each provider's client

- Status: Proposed
- Date: 2026-11-21

## Context

On my Mac the search path held the OpenAI client 0.163.0 while the OpenAI desktop app carried 0.169.0-alpha.11.1, and the Google desktop app carried a newer Google client than the one CrewKite found. CrewKite ran the first copy that passed its checks, so the cards missed models my account has. An older client lists older models.

The [ADR 0009 amendment](0009-native-client-trust-profile.md#amendment-2026-10-31) accepts a range of builds on the chat route, but it refuses a new major version until I test it, and a person who installs a newer client has no way to reach it from CrewKite. A release for every client update does not scale. The clients ship several builds a week.

## Decision

This rule holds for every cloud provider.

1. CrewKite finds every copy of the provider's client on the device: the search path, the provider's own desktop app bundle, and CrewKite's own copy under its state folder.
2. It runs the newest copy that passes the trust checks. The card says which copy and which version it runs.
3. When the provider has published a newer client than any copy on the device, CrewKite fetches it into its own folder under the state root. It never changes, updates or removes a client the person installed. It checks the download against the vendor's own signing identity or published checksum, never against a digest of one build kept in CrewKite's code. If a vendor publishes nothing CrewKite can verify, this step is left out for that provider.
4. Refresh on the card reads the models again, live, from the client CrewKite runs. A person who only uses the desktop app never needs a terminal.
5. No model name, client version or digest of one build decides what runs. A minimum version stays only where an older build cannot do the work, and the card says so.
6. The connect-time reads decide what a build may do, as [ADR 0048](0048-restricted-reads-through-a-named-permission-profile.md) does for the OpenAI client. A fetched build that fails them is not used. CrewKite keeps running the last copy that passed and says so on the card in one line.

This replaces the exact-pin trust rule of the ADR 0009 amendment for the chat route, including the refusal of a new major version. ADR 0009 itself stays as accepted. The writer profiles keep their exact pins and their qualification evidence.

## Why

The pin protected me from a build I had not tested. It also hid the newest models from anyone whose installed client was one release behind, and it made me the bottleneck for every update. The checks that matter do not depend on a version number. The file's owner and mode, the signature and the connect-time reads say whether a build is safe to run, and they say it for builds I have never seen.

I ruled out a table of approved digests for chat. Each entry covers one build, so the table is a release per update by another route. I ruled out running whatever the search path finds first, which is what failed on my Mac.

I chose to fetch only into CrewKite's own folder so that CrewKite never touches a client the person installed. That client may be tied to their own sign-in or their own update schedule.

## Consequences

- CrewKite runs client builds I have not tested. The signature check, the connect-time reads and the kept previous copy protect against that. A build that fails the reads costs the person the newer models until the next one passes, and the card says why.
- The status line names a copy that sits outside the search path, so a person can see which one runs.
- Fetching needs a download path with a verification step per vendor. A provider with no signing identity or published checksum I can check keeps the copies already on the device and gets no fetch.
- The minimum stays in the version table where an older build cannot do the work. Everything above it runs.
- The writer profiles still need a new qualification for a new build.
- OpenAI and Anthropic fetch on Check again, from the vendor's own host, only when a copy is already on the device, and only on macOS on Apple silicon. A fetched copy that fails its connect-time read is removed, the last good copy runs, and that version is not fetched again. For OpenAI the build goes on its second failed read in a row, because one failure can be a full disk. For Anthropic the first miss removes it. The OpenAI signature check covers every Mach-O file in the package, the fetch has a 30-minute total bound beside the 90-second stall bound, and the unpacked package is capped at 1 GiB. Only a controller whose home is the one its environment names fetches.
- I left Google out of step 3. Google signs its builds but publishes no checksum, and the only lists of the newest version are a registry on another host and the client's private updater service. CrewKite still runs the newest Google client copy it finds on the device for quota reads.
- The Google chat route stays on the fixed 1.4.0 bundle. Moving it needs changes to the writer profile's own pins and a live check that `agy acp` in a newer client speaks the same protocol, signs in the same way and still asks before every edit. Until then the Google model list is the 1.4.0 agent's list.
