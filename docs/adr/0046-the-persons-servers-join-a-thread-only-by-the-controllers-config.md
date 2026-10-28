# 0046. The person's servers join a thread only by the controller's config

- Status: Proposed
- Date: 2026-10-28

## Context

[ADR 0044](0044-thread-tools-over-one-controller-owned-mcp-server.md) keeps every MCP source except the `crewkite` server off, so a cloud turn cannot use the tools I already have. I lose a database client, a documentation index and a ticket tracker inside CrewKite that my terminal client has. I want them back without handing a turn whatever happens to be installed.

Three things make that hard. A client runs some MCP tools without asking unless something stops it. A server describes its own tools, including annotations such as `readOnlyHint`, and a server can claim anything. A server's arguments and environment often hold keys.

## Decision

I added a list of my own MCP servers in Settings. A server joins a turn only when the controller writes it into that turn's config.

- I add a server by name, command and arguments. Arguments, secret arguments and environment variables are separate fields. Every environment value and every secret argument is a secret.
- A server is off for every thread. I turn it on from a thread's panel and pick one of three policies there: ask each time, allow reads, allow all.
- The controller decides the config for each turn, in the place that decides the thread tools. The thread tools server and the servers I turned on go into one config. Anthropic keeps `--strict-mcp-config`, so nothing else loads. Google keeps its own settings as ADR 0044 says and gets my servers added to `session/new`.
- A server's policy is cut to the thread's permission policy and never exceeds it: ask lets nothing through unasked, allow edits lets reads through, allow all lets the server's own policy stand.
- Under the reads policy a call runs without asking only when its tool name is on the list I wrote for that server, exact or ending in a star. The controller decides this from my list. A server's annotations count as a claim by the server, so they can only narrow: a `readOnlyHint` of false or a `destructiveHint` of true turns a listed read back into an ask, and a `readOnlyHint` of true changes nothing. No client forwards annotations on a permission ask today, so the narrowing is in the rule and in the tests and no adapter supplies hints yet.
- Each family either routes the calls through the controller's gate or the servers stay out:
  - Anthropic launches with `--permission-prompt-tool`, so a call that is not on the allow list reaches the controller. My servers' tools are never on it. The adapter answers a call from the policy cut for that server, and a thread policy of allow all or a thread grant says nothing about it. A tool of a server the turn did not start asks.
  - Google reports a call by its kind and title and does not name the server, so CrewKite cannot tell a server's call from a built in one, and an allow all or a kind grant would answer it. The servers join a Google turn only while the thread policy is ask and grants no kind. Every call then asks, whatever the server's policy says.
  - OpenAI sends MCP tool approvals as a request CrewKite does not handle yet. The servers stay off for OpenAI.
  - Local runs no MCP servers.
  - Review and advice turns read only, so no server joins them.
- A server left out of a turn writes one line to the turn trace that says why. The Settings card states the same per-family rules.
- A policy change in the middle of a turn answers no call of a Google turn that carries my servers, and no call the kinds do not name on other turns, so loosening a thread cannot raise a running server's policy.
- Secrets are stored the way the Local token is ([ADR 0043](0043-remember-the-local-token-on-this-device.md)): sealed by `safeStorage`, refused when the device has no real keychain, and never returned to the renderer. The window sees the plain arguments, the count of secret arguments and the variable names. Main supplies the resolved set to the controller with a read command that takes no receipt, and the controller keeps it in memory.
- The controller removes every secret value of the servers a turn started from the turn's events and from its failure text before they reach the thread or the trace. Values shorter than four characters are not matched, since they would match ordinary text.

## Why

The thread tools server stays unique because the controller can read its code. My own servers cannot be read that way, so the controller cannot vouch for what they do. What it can do is decide whether they are present, how a call to them is answered and what leaves the turn. That keeps [ADR 0002](0002-authority-in-deterministic-code.md): no prompt, flag or settings value grants a server anything. The grant is a row I wrote on this thread, cut by the policy I set on this thread.

I took the list of reads from the person because the only other source is the server. A name such as `get_` says nothing the server cannot also say about a tool that writes. Annotations come from the same place. Narrowing is safe because it can only cost me a question.

Google and OpenAI fall back to ask and off because the alternative is a client running a tool without asking the controller. A server that is absent is a smaller failure than an unasked call.

I put the secrets in the same store as the Local token because the reasoning in ADR 0043 holds: a sealed value on disk and no copy in the page. These secrets are closer to a provider credential than the Local token is, since they may open a hosted service. I accept that and keep them with the same limits, opt in per server by my act of adding them, and never shown again.

## Consequences

- Only a desktop session supplies servers. A controller started without the desktop has none, and the CLI sees none.
- For Anthropic no secret reaches the client's argument list. The config goes in a file with mode 0600 in the turn's private work folder, the client is given its path, and the file is deleted when the turn settles. The server process still receives its own arguments and variables, which another process of mine can read from the process list while it runs. The environment is the better field for a key. Google receives the entries over its protocol, not on a command line.
- The scrub removes a secret value as written. A secret that a server transforms before printing it is not matched.
- Google turns on a thread that allows anything do not get my servers, and OpenAI turns never do. The card and the trace say so. Using them there needs a client that sends the approval to the controller, and a new record.
- A call that I approve with allow for this thread names the one tool for the rest of that turn, as for every other tool.
- Fixtures cover the Anthropic config, the Google entries and the policy rules. No live run of any client against a real server is on record.
