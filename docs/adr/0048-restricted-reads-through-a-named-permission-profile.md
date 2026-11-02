# 0048. Restricted reads through a named permission profile, proven by the reply

- Status: Proposed
- Date: 2026-11-02

## Context

A read-only turn on the OpenAI client (Ask, Second opinion, Challenge, review, the orchestrator and a read-only slice) must not read files outside the scratch copy, such as the client's own memory files under my home folder. CrewKite asked for that with a restricted read sandbox on `turn/start`. The client removed that shape in 0.126.0 and answers it with `-32600` "readOnly.access is no longer supported". CrewKite's fallback matched only `-32602` with "unknown field", so on 0.163.0 every read-only turn failed before it started.

The version gate did not catch it. The table named 0.163.0 as both tested and minimum, and the card said it was the build CrewKite was tested with, but no read-only turn had run on it. The client ships a new minor about every week and renamed or removed the restricted read field four times between 0.125 and 0.163. A table of versions cannot keep up with that, and `--strict-config` turned every unknown launch key into an exit before the first reply.

## Decision

- A read-only thread runs under a permission profile named `crewkite-read`. `thread/start` carries it in `config`: `default_permissions = "crewkite-read"` and a filesystem table that reads `:minimal`, the scratch copy and the folder of each attached file. The thread gets no `sandbox` and `turn/start` gets no `sandboxPolicy`, because either one puts the client back on the older sandbox settings. The approval policy stays `never`. I do not use the per-request `permissions` field, which needs the experimental API on the whole session.
- The reply is the proof. `thread/start` and `thread/resume` must answer `activePermissionProfile.id = "crewkite-read"` and `sandbox.type = "readOnly"`. Any other answer runs the turn on the plain read-only sandbox under `untrusted`, where the client asks before each command and CrewKite allows only a command that provably reads inside the copy, and the thread gets one line that says so. A build older than 0.133.0 has no profiles and starts on that path. In both paths a command that names a path outside the copy stops the turn.
- Requests degrade one field at a time. Each request sends only fields the build knows, from a table of release boundaries in `features(version)`. A `-32600` or `-32602` that names a field CrewKite can drop sends the request once more without it, with a line in the thread. A second refusal, or one that names a field that decides access (`config`, `sandbox`, `sandboxPolicy`, `approvalPolicy`, `approvalsReviewer`, `developerInstructions`), ends the turn with the client's own words. A request the turn does not need never fails it.
- The launch drops `--strict-config`. One `config/read` after launch confirms the approval policy, the sandbox mode of a turn that edits, web search and plugins. A different value ends the turn. A key the reply leaves out is a warning that names it.
- The client version is information. Every build runs. The card says "Checked with 0.163.0 on 2 Nov 2026" and, for a later build, "newer than the last checked build". Only a failed connect-time read refuses the client.
- `pnpm protocol:check` runs a published build with no account and sends CrewKite's exact shapes against a thread that does not exist. The client checks a shape before it looks up the thread, so a refused shape and an accepted one answer differently. It also validates every request against the schema the build generates and compares the fields the build calls no longer supported with the keys CrewKite sends.
- Every request builder, the launch settings, the method sets and the error matchers live in `apps/controller/src/providers/openai/protocol.ts`.

## Why

The old shape failed closed for the wrong reason: the turn died, and nothing showed what the client would have accepted. A profile in thread config is what the current client documents for restricted reads, and the probes show it applying the same way from 0.133.0 to 0.166.0, including when my own config file sets another sandbox mode or another default profile.

I trust the reply over the request because the request only says what I asked for. A build that ignores the profile, renames it or applies a managed setting on top would otherwise run a read-only turn with whole-disk reads and no question. With the check, the worst case is the wide path: more questions and a stopped turn, never wider access.

Dropping one field at a time keeps a turn alive across a release that removes a nicety, such as `excludeTurns` behind the experimental flag on 0.133 to 0.150. Fields that decide access never drop, because a turn that loses one would run with more reach than I set.

Without `--strict-config` an unknown key no longer kills the process, so `config/read` has to prove the keys that matter. That costs one request per turn. I accept it.

## Consequences

- The narrow read depends on a feature the client calls beta. The protocol check runs the profile on every build it checks, and the wide path covers a build that drops it.
- A read-only turn on a build before 0.133.0 asks before most commands. That build still works.
- The wide path reads the whole disk inside the sandbox. CrewKite's command checks are what keep it in the copy, and a command they cannot prove stops the turn.
- The card no longer refuses a new major version of this client. A new major that changes the protocol fails at the connect-time read or the first request, with the request named.
- Release boundaries in `features(version)` come from probes of published builds. A boundary I have not probed is assumed present, and the replies decide.
- The live check is on macOS: one review turn, one ask turn, and a read of the client's sign-in file from the model's shell that the profile refuses.
