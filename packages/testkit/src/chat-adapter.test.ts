import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentEvent, ChatPermissionPolicy, ChatToolKind } from '@crewkite/contracts';
import { type ChatScriptStep, createScriptedChatAdapter } from './chat-adapter.ts';

const edit: ChatScriptStep = {
  kind: 'tool',
  callId: 'edit-1',
  toolKind: 'edit',
  title: 'Edit net.mjs',
  write: { path: 'net.mjs', content: 'export const net = 1;\n' },
};
const editAsk: ChatScriptStep = {
  kind: 'permission',
  requestId: 'ask-1',
  question: 'Edit net.mjs?',
};
const command: ChatScriptStep = {
  kind: 'tool',
  callId: 'run-1',
  toolKind: 'command',
  title: 'node net.mjs',
};

async function play(input: {
  steps: ChatScriptStep[];
  policy: ChatPermissionPolicy;
  grants?: ChatToolKind[];
  /** The person's answer, given when the ask arrives. Absent leaves the ask open. */
  answer?: string;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-fake-'));
  try {
    const adapter = createScriptedChatAdapter({ family: 'anthropic', turns: [input.steps] });
    const events: AgentEvent[] = [];
    const handle = adapter.startTurn(
      {
        turnId: 'turn-1',
        role: 'assistant',
        selection: { family: 'anthropic', model: 'model-a', effort: 'default' },
        prompt: 'Edit it.',
        systemContext: '',
        history: [],
        session: null,
        scratch: { directory, base: directory, projectName: 'shop' },
        permissionPolicy: input.policy,
        permissionGrants: input.grants,
      },
      (event) => {
        events.push(event);
        if (event.type === 'permission.requested' && input.answer)
          handle.respondPermission(event.requestId, input.answer);
      },
    );
    // An ask nobody answers parks the turn, so stopping it ends the run.
    if (!input.answer) setImmediate(() => setImmediate(() => handle.stop()));
    await handle.result;
    const asked = events.find((event) => event.type === 'permission.requested');
    const resolved = events.find((event) => event.type === 'permission.resolved');
    const completed = events.find((event) => event.type === 'tool.completed');
    return {
      callId: asked?.type === 'permission.requested' ? asked.callId : null,
      choice: resolved?.type === 'permission.resolved' ? resolved.choice : null,
      status: completed?.type === 'tool.completed' ? completed.status : null,
      landed: existsSync(join(directory, 'net.mjs')),
      content: existsSync(join(directory, 'net.mjs'))
        ? readFileSync(join(directory, 'net.mjs'), 'utf8')
        : null,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a scripted ask guards the tool after it, and the answer or the thread policy decides it', async () => {
  const cases: {
    claim: string;
    steps: ChatScriptStep[];
    policy: ChatPermissionPolicy;
    grants?: ChatToolKind[];
    answer?: string;
    callId: string;
    landed: boolean;
    choice: string | null;
    status: string | null;
  }[] = [
    {
      claim: 'Deny keeps the edit out and the tool card says denied',
      steps: [editAsk, edit],
      policy: 'ask',
      answer: 'deny',
      callId: 'edit-1',
      landed: false,
      choice: 'deny',
      status: 'denied',
    },
    {
      claim: 'Allow once lets the edit land',
      steps: [editAsk, edit],
      policy: 'ask',
      answer: 'allow-once',
      callId: 'edit-1',
      landed: true,
      choice: 'allow-once',
      status: 'ok',
    },
    {
      claim: 'allow-edits answers an edit without asking the person',
      steps: [editAsk, edit],
      policy: 'allow-edits',
      callId: 'edit-1',
      landed: true,
      choice: 'allow-once',
      status: 'ok',
    },
    {
      claim: 'allow-all answers an edit without asking the person',
      steps: [editAsk, edit],
      policy: 'allow-all',
      callId: 'edit-1',
      landed: true,
      choice: 'allow-once',
      status: 'ok',
    },
    {
      claim: 'a kind granted for the thread is allowed for the thread',
      steps: [editAsk, edit],
      policy: 'ask',
      grants: ['edit'],
      callId: 'edit-1',
      landed: true,
      choice: 'allow-thread',
      status: 'ok',
    },
    {
      claim: 'ask waits for the person, and the edit has not landed when the turn is stopped',
      steps: [editAsk, edit],
      policy: 'ask',
      callId: 'edit-1',
      landed: false,
      choice: null,
      status: null,
    },
    {
      claim: 'allow-edits still waits for the person on a command',
      steps: [{ ...editAsk, question: 'Run node net.mjs?' }, command],
      policy: 'allow-edits',
      callId: 'run-1',
      landed: false,
      choice: null,
      status: null,
    },
  ];
  for (const row of cases) {
    const got = await play(row);
    assert.equal(got.landed, row.landed, `${row.claim}: file`);
    assert.equal(got.choice, row.choice, `${row.claim}: choice`);
    assert.equal(got.status, row.status, `${row.claim}: tool status`);
    assert.equal(got.callId, row.callId, `${row.claim}: the ask names its call`);
  }
});
