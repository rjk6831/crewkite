# Native task context

This source-only connector shares one selected CrewKite task with the native Antigravity interactive CLI through workspace MCP configuration, or with the app through a workspace plugin. The native client owns inference, model selection, effort, approvals and Stop. CrewKite starts no provider process. The consumer headless profile remains unavailable.

## Prepare a scratch workspace

Use the source checkout with its installed dependencies and Node 24. Keep the selected task's controller running. Find its exact task ID through the normal task list. The task needs a saved run and source identity. A prepared run is sufficient; no provider Start is required. A task without a retained candidate shares an empty patch. Choose a new scratch directory whose parent already exists, outside the original project checkout.

```sh
node apps/controller/src/providers/google/native-extension/prepare.ts \
  --client cli \
  --home /absolute/path/to/crewkite/home \
  --task '<existing-task-id>' \
  --workspace /absolute/path/to/new-scratch-workspace \
  --expires-at '<future-UTC-ISO-time>' \
  --share-task-context
```

The explicit command authorizes sharing that task's title, outcome, criteria, saved source identity and complete retained patch. Expiry must be within the next hour. The combined context and patch must fit 64 KiB. Truncated, binary or oversized patches refuse preparation. No unrelated task history, provider credentials or controller token is copied into the context.

Preparation creates a private scratch workspace and an ignored `.crewkite-context/` sidecar. `--client cli` writes the [workspace MCP configuration](https://antigravity.google/docs/mcp#global-and-workspace-server-configs) at `.agents/mcp_config.json`. Start the native interactive CLI yourself in that workspace and inspect `/mcp`. No plugin install command is needed. `--client app` writes `.agents/plugins/crewkite-context/` containing `plugin.json` and `mcp_config.json`. Existing workspaces and configurations are refused without changes. Nothing is installed globally, and no native client is launched. The generated configuration pins the current Node executable and this source connector, so keep both available.

For the app, open the scratch workspace yourself in Antigravity. Its [workspace plugin documentation](https://antigravity.google/docs/plugins#manual-plugin-installation) describes App and IDE discovery under `.agents/plugins/`. Inspect the loaded plugin and tools in the native UI before sharing work. Both targets use a [local stdio MCP server](https://antigravity.google/docs/mcp#MCP-configuration-structure), with no URL, OAuth or account configuration. App plugin loading remains unqualified. Folder-only plugin discovery is not claimed for the CLI.

## Observed CLI behavior

On 17 October 2026, native interactive CLI 1.4.0 loaded all three tools from the workspace MCP configuration. One synthetic prepared task supplied its context and an empty retained patch. Each named tool call received one-call approval, and the result tool saved 306 bytes of text labelled `UNVERIFIED` in the connector sidecar. The controller snapshot stayed unchanged, with no controller intent, controller submission or candidate created. The native process exited with code zero after 270.898 seconds, and its owned group was absent. The controller also closed normally. Source, index, refs, configuration and capability bytes stayed unchanged.

This qualifies that context-only CLI exchange. The app plugin and nonempty retained-patch transfer still need connected qualification. It establishes no native Stop behavior, enforced model or effort setting, full provider route or single-interface workflow. The consumer headless profile stays restricted.

## Available tools

| Tool | Result |
|------|--------|
| `task_context` | The selected task and its exact saved revision, run, source and candidate identities |
| `retained_patch` | The complete retained patch and artifact identity, labelled unverified |
| `submit_unverified_result` | One NUL-free UTF-8 text result of at most 32 KiB in `.crewkite-context/result.unverified.json` |

Every tool checks the current task against the saved binding before returning data or saving a result. Revision, run, source, candidate or referenced artifact drift refuses access. Expiry and cancelled requests refuse late results. A native conversation ID is optional correlation text and supplies no authentication or authority. The native-owned stdio process scopes this capability; conversations sharing that server can access the same selected context.

The sidecar is local, unverified output. It creates no candidate, writer lease, check, review, approval or accepted branch in CrewKite. No controller mutation command is exposed. Review the result manually through the existing workflow. Arbitrary task, artifact and path selection is unsupported.

The first connector process consumes the prepared session. A native server restart requires a newly prepared scratch workspace. Closing the connection, cancelling a request or letting access expire stops connector access only. Native inference may continue; use the native app's Stop control. Deleting the plugin or closing its process supplies no OS quiescence evidence.

The workspace uses same-user local-code trust. Private files and a checksum protect the selected configuration from accidental changes. They provide no filesystem sandbox against the native app or other code running as that user. The native app's own file and tool permissions remain in force. Do not submit secrets in the result text.
