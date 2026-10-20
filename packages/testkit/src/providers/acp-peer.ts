import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const acpPeerCases = [
  'complete',
  'fresh-no-mcp',
  'session-update',
  'permission',
  'hunk',
  'hunk-sequential',
  'hunk-control',
  'hunk-drift',
  'hunk-after-mismatch',
  'permanent',
  'ambiguous',
  'changed-action',
  'bad-action',
  'large-action',
  'cancel',
  'cancel-permission',
  'cancel-late',
  'eof-cancel',
  'bad-ack',
  'model-ack-drift',
  'mode-ack-drift',
  'lost-mode-ack',
  'corrected-model-ack',
  'corrected-mode-ack',
  'missing-mode',
  'missing-thought',
  'drift',
  'bad-version',
  'bad-frame',
  'duplicate',
  'descendant',
  'no-close',
  'usage-refusal',
  'activity-locations',
  'after-terminal',
  'late-permission',
  'open-tools',
  'pending-end',
  'late-message',
  'open-edits',
  'hunk-open',
  'outside-edit',
  'outside-completed',
  'outside-kind-flip',
  'outside-reverse-flip',
  'outside-open-flip',
  'permission-outside-completed',
  'outside-permission-completed',
  'outside-no-reject',
  'outside-two-rejects',
  'outside-execute',
  'hunk-brain-write',
] as const;
export type AcpPeerCase = (typeof acpPeerCases)[number];

/** Each transition follows a received message; the peer uses no clock or network. */
export function runAcpPeer(scenario: AcpPeerCase, fresh = false) {
  assert(acpPeerCases.includes(scenario));
  let cwd = '',
    promptId: string | number | undefined,
    submitted = false,
    suppliedSnapshot = false,
    hunkStep = 0;
  const config = [
    {
      id: 'model-slot',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'fixture-model',
      options: [
        { value: 'fixture-model', name: 'Model' },
        { value: 'fixture-other', name: 'Other' },
      ],
    },
    ...(scenario === 'missing-thought'
      ? []
      : [
          {
            id: 'thought-slot',
            name: 'Thought',
            category: 'thought_level',
            type: 'select',
            currentValue: 'fixture-low',
            options: [{ value: 'fixture-low', name: 'Low' }],
          },
        ]),
    ...(scenario === 'missing-mode'
      ? []
      : [
          {
            id: 'mode-slot',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'fixture-open',
            options: [
              { value: 'fixture-review', name: 'Review' },
              { value: 'fixture-open', name: 'Open' },
            ],
          },
        ]),
  ];
  function emit(value: object) {
    const line = `${JSON.stringify(value)}\n`;
    process.stdout.write(line.slice(0, 11));
    process.stdout.write(line.slice(11));
  }
  const result = (id: string | number, value: object) =>
    emit({ jsonrpc: '2.0', id, result: value });
  const update = (value: object) =>
    emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'fixture-session', update: value },
    });
  function terminal(stopReason: string) {
    assert(promptId !== undefined);
    result(promptId, { stopReason });
  }
  function requestHunk() {
    hunkStep++;
    const path = join(cwd, 'net.mjs');
    const oldText = String(hunkStep - 1),
      newText = String(hunkStep);
    const tool = {
      toolCallId: `fixture-hunk-${hunkStep}`,
      title: 'Run replace_file_content?',
      kind: 'edit',
      status: 'pending',
      rawInput: {
        TargetFile: path,
        TargetContent: oldText,
        ReplacementContent: newText,
        ...(scenario === 'hunk-control' ? { AllowMultiple: true } : {}),
      },
      content: [{ type: 'diff', path, oldText, newText, _meta: { kind: 'modify' } }],
      locations: [{ path }],
    };
    update({ sessionUpdate: 'tool_call', ...tool });
    emit({
      jsonrpc: '2.0',
      id: `permission-${hunkStep}`,
      method: 'session/request_permission',
      params: {
        sessionId: 'fixture-session',
        toolCall: tool,
        options: [
          { optionId: 'once', name: 'Once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      },
    });
  }
  // The server announces a note write into its own data directory, then asks permission.
  // The variants change what the request offers or which tool asks.
  function requestBrainWrite() {
    const path = join(cwd, '..', 'brain', 'conversation', 'task.md');
    const tool = {
      toolCallId: 'fixture-brain-write',
      ...(scenario === 'outside-execute'
        ? { name: 'private prose', _meta: { mcp: { tool: 'catalog_tool' } } }
        : {}),
      title: scenario === 'outside-execute' ? 'private prose' : 'Run write_to_file?',
      kind: scenario === 'outside-execute' ? 'execute' : 'edit',
      status: scenario === 'outside-permission-completed' ? 'completed' : 'pending',
      rawInput:
        scenario === 'outside-execute'
          ? { arguments: JSON.stringify({ task_status: 'done' }) }
          : { TargetFile: path, CodeContent: '# Tasks\n' },
      locations: [{ path }],
    };
    // Here the path first appears in the permission request.
    update({
      sessionUpdate: 'tool_call',
      ...tool,
      ...(scenario === 'outside-permission-completed' ? { locations: undefined } : {}),
    });
    const allow = { optionId: 'once', name: 'Once', kind: 'allow_once' };
    const deny = { optionId: 'deny', name: 'Deny', kind: 'reject_once' };
    emit({
      jsonrpc: '2.0',
      id: 'permission-brain',
      method: 'session/request_permission',
      params: {
        sessionId: 'fixture-session',
        toolCall: tool,
        options:
          scenario === 'outside-no-reject'
            ? [allow]
            : scenario === 'outside-two-rejects'
              ? [allow, deny, { optionId: 'deny-too', name: 'Deny too', kind: 'reject_once' }]
              : [allow, deny],
      },
    });
  }
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        assert.deepEqual(message.params.clientCapabilities, {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        });
        if (scenario === 'bad-frame') {
          process.stdout.write(Buffer.from([255, 10]));
          return;
        }
        result(message.id, {
          protocolVersion: scenario === 'bad-version' ? 2 : 1,
          agentInfo: { name: 'fixture', version: '1.4.0' },
          agentCapabilities: { sessionCapabilities: scenario === 'no-close' ? {} : { close: {} } },
          authMethods: [{ id: 'oauth-personal', name: 'Personal' }],
        });
      } else if (message.method === 'authenticate') {
        assert.equal(message.params.methodId, 'oauth-personal');
        result(message.id, {});
      } else if (message.method === 'session/new') {
        cwd = message.params.cwd;
        assert(Array.isArray(message.params.mcpServers));
        // Task sessions switch off broad file tools. Fresh tasks do not need an MCP server.
        if (message.params._meta)
          assert.equal(
            message.params.mcpServers.length,
            fresh || scenario === 'fresh-no-mcp' ? 0 : 1,
          );
        suppliedSnapshot =
          message.params._meta?.antigravity?.disabledTools?.includes('view_file') === true;
        if (message.params._meta)
          assert.deepEqual(message.params._meta, {
            antigravity: {
              ...(suppliedSnapshot ? { enabledTools: ['edit_file', 'finish'] } : {}),
              disabledTools: [
                'create_file',
                'invoke_subagent',
                'task_context',
                ...(suppliedSnapshot
                  ? [
                      'view_file',
                      'list_directory',
                      'search_directory',
                      'find_file',
                      'run_command',
                      'search_web',
                    ]
                  : []),
              ],
            },
          });
        else assert.equal(message.params.mcpServers.length, 0);
        for (const server of message.params.mcpServers) {
          assert.deepEqual(server.env, []);
          assert(!Object.hasOwn(server, 'cwd'));
        }
        if (scenario === 'session-update') {
          process.stdout.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fixture-session', configOptions: config } })}\n${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'available_commands_update', availableCommands: [] } } })}\n`,
          );
        } else result(message.id, { sessionId: 'fixture-session', configOptions: config });
      } else if (message.method === 'session/set_config_option') {
        const option = config.find((v) => v.id === message.params.configId);
        assert(option);
        assert(option.options.some((v) => v.value === message.params.value));
        option.currentValue =
          scenario === 'bad-ack' && option.id === 'model-slot'
            ? 'fixture-other'
            : message.params.value;
        if (
          (scenario === 'corrected-model-ack' && option.id === 'model-slot') ||
          (scenario === 'corrected-mode-ack' && option.id === 'mode-slot')
        ) {
          const bad = structuredClone(config);
          const changed = bad.find((v) => v.id === option.id);
          assert(changed);
          changed.currentValue = option.id === 'model-slot' ? 'fixture-other' : 'fixture-open';
          const ack = { jsonrpc: '2.0', id: message.id, result: { configOptions: bad } };
          const corrected = {
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'fixture-session',
              update: { sessionUpdate: 'config_option_update', configOptions: config },
            },
          };
          process.stdout.write(`${JSON.stringify(ack)}\n${JSON.stringify(corrected)}\n`);
        } else if (
          (scenario === 'model-ack-drift' && option.id === 'model-slot') ||
          (scenario === 'mode-ack-drift' && option.id === 'mode-slot')
        ) {
          const ack = {
            jsonrpc: '2.0',
            id: message.id,
            result: { configOptions: structuredClone(config) },
          };
          config[0].currentValue = 'fixture-other';
          const drift = {
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'fixture-session',
              update: { sessionUpdate: 'config_option_update', configOptions: config },
            },
          };
          process.stdout.write(`${JSON.stringify(ack)}\n${JSON.stringify(drift)}\n`);
        } else
          result(message.id, {
            configOptions:
              scenario === 'lost-mode-ack' && option.id === 'model-slot'
                ? config.filter((v) => v.id !== 'mode-slot')
                : config,
          });
      } else if (message.method === 'session/prompt') {
        assert(!submitted);
        const prompt = message.params.prompt[0].text;
        assert(Buffer.byteLength(prompt, 'utf8') <= 65536);
        if (scenario.startsWith('hunk')) assert(suppliedSnapshot);
        if (suppliedSnapshot)
          assert(prompt.endsWith(JSON.stringify(readFileSync(join(cwd, 'net.mjs'), 'utf8'))));
        submitted = true;
        promptId = message.id;
        assert.equal(config.find((v) => v.id === 'mode-slot')?.currentValue, 'fixture-review');
        update({
          sessionUpdate: 'usage_update',
          used: 12,
          size: 1024,
          cost: { amount: 1, currency: 'USD' },
        });
        update({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'private thought fixture' },
        });
        if (
          [
            'hunk-brain-write',
            'outside-permission-completed',
            'outside-no-reject',
            'outside-two-rejects',
            'outside-execute',
          ].includes(scenario)
        ) {
          requestBrainWrite();
        } else if (scenario.startsWith('hunk')) {
          requestHunk();
        } else if (scenario === 'drift') {
          config[0].currentValue = 'fixture-other';
          update({ sessionUpdate: 'config_option_update', configOptions: config });
        } else if (
          [
            'permission',
            'permanent',
            'ambiguous',
            'changed-action',
            'bad-action',
            'large-action',
            'permission-outside-completed',
            'cancel-permission',
            'pending-end',
          ].includes(scenario)
        ) {
          const rawInput = {
            path: join(cwd, 'net.mjs'),
            oldText: 'export const total = 0;\n',
            newText: scenario === 'large-action' ? 'x'.repeat(4096) : 'export const total = 1;\n',
            ...(scenario === 'bad-action' ? { command: 'hidden effect' } : {}),
          };
          const toolCall = {
            toolCallId: 'fixture-tool',
            name: 'fixture-replace',
            kind: 'edit',
            status: 'pending',
            rawInput,
          };
          if (scenario !== 'permission-outside-completed')
            update({ sessionUpdate: 'tool_call', ...toolCall });
          emit({
            jsonrpc: '2.0',
            id: 'permission-1',
            method: 'session/request_permission',
            params: {
              sessionId: 'fixture-session',
              toolCall:
                scenario === 'permission-outside-completed'
                  ? toolCall
                  : { toolCallId: 'fixture-tool' },
              options: [
                {
                  optionId: 'once',
                  name: 'Once',
                  kind: scenario === 'permanent' ? 'allow_always' : 'allow_once',
                },
                ...(scenario === 'ambiguous'
                  ? [{ optionId: 'other', name: 'Other', kind: 'allow_once' }]
                  : []),
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          });
          if (scenario === 'changed-action')
            update({
              sessionUpdate: 'tool_call_update',
              toolCallId: 'fixture-tool',
              rawInput: { ...rawInput, newText: 'changed' },
            });
          if (scenario === 'pending-end') terminal('end_turn');
        } else if (['cancel', 'cancel-late', 'eof-cancel'].includes(scenario)) {
          update({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'fixture-ready-to-cancel' },
          });
        } else if (scenario === 'usage-refusal') terminal('refusal');
        else if (scenario === 'activity-locations') {
          // Read-only tools report the scratch root and paths outside it.
          for (const [toolCallId, kind, path] of [
            ['fixture-search', 'search', cwd],
            ['fixture-read', 'read', join(cwd, '..', 'outside.md')],
          ]) {
            update({
              sessionUpdate: 'tool_call',
              toolCallId,
              title: kind,
              kind,
              status: 'in_progress',
              locations: [{ path }],
            });
            update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
          }
          terminal('end_turn');
        } else if (scenario === 'outside-edit') {
          update({
            sessionUpdate: 'tool_call',
            toolCallId: 'fixture-outside-delete',
            title: 'delete',
            kind: 'delete',
            status: 'completed',
            locations: [{ path: join(cwd, '..', 'outside.md') }],
          });
          terminal('end_turn');
        } else if (
          [
            'outside-completed',
            'outside-kind-flip',
            'outside-reverse-flip',
            'outside-open-flip',
          ].includes(scenario)
        ) {
          // The edit is never offered for permission and its next update does not name the
          // path again. The variants change the kind between the two updates, in either
          // direction. The reverse case reports completion before the edit kind, then
          // changes the status. One other case leaves the tool open at the end of the turn.
          const kindChanges: Record<
            | 'outside-completed'
            | 'outside-kind-flip'
            | 'outside-reverse-flip'
            | 'outside-open-flip',
            readonly [string, string | undefined]
          > = {
            'outside-completed': ['edit', undefined],
            'outside-kind-flip': ['edit', 'other'],
            'outside-reverse-flip': ['other', 'edit'],
            'outside-open-flip': ['edit', 'other'],
          };
          const [announced, reported] = kindChanges[scenario as keyof typeof kindChanges];
          update({
            sessionUpdate: 'tool_call',
            toolCallId: 'fixture-outside-edit',
            title: 'edit',
            kind: announced,
            status: scenario === 'outside-reverse-flip' ? 'completed' : 'in_progress',
            locations: [{ path: join(cwd, '..', 'outside.md') }],
          });
          update({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'fixture-outside-edit',
            ...(scenario === 'outside-open-flip'
              ? {}
              : { status: scenario === 'outside-reverse-flip' ? 'failed' : 'completed' }),
            ...(reported ? { kind: reported } : {}),
          });
          terminal('end_turn');
        } else if (scenario === 'open-tools' || scenario === 'open-edits') {
          // Tools that stay open across the turn end.
          for (const kind of scenario === 'open-tools'
            ? ['read', 'search', 'execute']
            : ['edit', 'delete', 'move'])
            update({
              sessionUpdate: 'tool_call',
              toolCallId: `fixture-open-${kind}`,
              title: kind,
              kind,
              status: 'in_progress',
            });
          terminal('end_turn');
        } else {
          writeFileSync(join(cwd, 'net.mjs'), 'export const total = 1;\n');
          if (scenario === 'descendant') {
            // Keep the parent alive to reap its owned child before the group disappears.
            const child = spawn(
              process.execPath,
              [
                '-e',
                'const {MessageChannel}=require("node:worker_threads");const p=new MessageChannel();p.port1.on("message",()=>{});process.on("SIGTERM",()=>{});process.send("ready");',
              ],
              { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] },
            );
            process.on('SIGTERM', () => {
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            });
            child.once('close', () => {
              input.close();
              process.stdin.destroy();
            });
            child.once('message', (message) => {
              assert.equal(message, 'ready');
              terminal('end_turn');
            });
          } else {
            terminal('end_turn');
            if (scenario === 'duplicate') terminal('end_turn');
          }
        }
      } else if (message.method === 'session/cancel') {
        if (scenario === 'eof-cancel') {
          process.stdin.destroy();
          input.close();
          return;
        }
        if (scenario === 'cancel-late')
          update({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'late inert output' },
          });
        terminal('cancelled');
      } else if (message.method === 'session/close') {
        // Close follows the terminal response, so these messages trail the finished turn.
        if (scenario === 'after-terminal') {
          update({ sessionUpdate: 'usage_update', used: 24, size: 1024 });
          emit({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: 'private-close-failure' },
          });
          return;
        }
        if (scenario === 'late-message')
          update({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'private-late-text' },
          });
        if (scenario === 'late-permission')
          emit({
            jsonrpc: '2.0',
            id: 'permission-late',
            method: 'session/request_permission',
            params: {
              sessionId: 'fixture-session',
              toolCall: { toolCallId: 'fixture-late' },
              options: [{ optionId: 'once', name: 'Once', kind: 'allow_once' }],
            },
          });
        result(message.id, {});
      } else if (message.id === 'permission-late')
        assert.equal(message.result?.outcome?.outcome, 'cancelled');
      else if (message.id === 'permission-brain') {
        if (['outside-no-reject', 'outside-two-rejects', 'outside-execute'].includes(scenario))
          // Without exactly one reject option, or from a tool that is no edit, the turn cancels.
          assert.equal(message.result?.outcome?.outcome, 'cancelled');
        else {
          // The reply must pick the reject option.
          assert.deepEqual(message.result, { outcome: { outcome: 'selected', optionId: 'deny' } });
          if (scenario === 'outside-permission-completed') {
            // The completed request remains decisive after a later failed update under
            // another kind.
            update({
              sessionUpdate: 'tool_call_update',
              toolCallId: 'fixture-brain-write',
              status: 'failed',
              kind: 'other',
            });
            terminal('end_turn');
          } else {
            // The tool fails and the turn goes on.
            update({
              sessionUpdate: 'tool_call_update',
              toolCallId: 'fixture-brain-write',
              status: 'failed',
              rawOutput: 'Rejected by user',
            });
            requestHunk();
          }
        }
      } else if (message.id === 'permission-1' || message.id === 'permission-2') {
        if (message.result?.outcome?.outcome === 'selected') {
          assert.equal(message.result.outcome.optionId, 'once');
          writeFileSync(
            join(cwd, 'net.mjs'),
            `export const total = ${scenario === 'hunk-after-mismatch' ? 2 : hunkStep || 1};\n`,
          );
          // The approved edit can stay open and report a different kind.
          update({
            sessionUpdate: 'tool_call_update',
            toolCallId: hunkStep ? `fixture-hunk-${hunkStep}` : 'fixture-tool',
            ...(scenario === 'permission-outside-completed'
              ? {
                  status: 'completed',
                  kind: 'other',
                  locations: [{ path: join(cwd, '..', 'outside.md') }],
                }
              : scenario === 'hunk-open'
                ? { status: 'in_progress', kind: 'other' }
                : { status: 'completed' }),
          });
          if (hunkStep === 1 && ['hunk-sequential', 'hunk-drift'].includes(scenario)) {
            if (scenario === 'hunk-drift')
              writeFileSync(join(cwd, 'net.mjs'), 'private change 1\n');
            requestHunk();
          } else terminal('end_turn');
        } else assert.equal(message.result?.outcome?.outcome, 'cancelled');
      } else throw Error('Unsupported fixture request.');
    } catch {
      process.exitCode = 2;
      process.stdin.destroy();
      input.close();
    }
  });
  input.once('close', () => process.stdin.destroy());
}
