import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import { setup } from '../store/controller-fixture.ts';

const selection = { family: 'openai', model: 'fixture-model', effort: 'default' } as const;

/**
 * A registered project whose default crew pins the orchestrator to a scripted family that answers
 * every turn with `answer`. The project holds one style file.
 */
async function project(t: TestContext, answer: string) {
  const adapter = createScriptedChatAdapter({
    family: 'openai',
    turns: [[{ kind: 'text', itemId: 'answer', chunks: [answer] }]],
  });
  const { controller, command, draft, source } = await setup(t, {
    chatAdapters: new Map([['openai', adapter]]),
  });
  const { projectId } = draft.payload as { projectId: string };
  const run = (name: string, payload: object) =>
    controller.execute(command(name, payload, 0), 'local-owner');
  const crew = {
    id: 'design',
    name: 'Design',
    members: [
      { role: 'builder', selection: null },
      { role: 'orchestrator', selection },
    ],
    flightMode: 'manual',
  };
  assert.equal((await run('SaveCrew', { crew })).outcome, 'applied');
  assert.equal((await run('SetDefaultCrew', { id: 'saved:design' })).outcome, 'applied');
  mkdirSync(join(source.directory, 'src'), { recursive: true });
  writeFileSync(join(source.directory, 'src', 'theme.css'), ':root { --accent: #0f766e; }\n');
  const status = () =>
    execFileSync('git', ['status', '--porcelain'], { cwd: source.directory }).toString();
  return { controller, command, projectId, adapter, run, status };
}

test('a description runs one read-only orchestrator turn, and its answer becomes a draft with skipped values and nothing saved', async (t) => {
  const answer = `Here is a calm draft.

\`\`\`json
{
  "schema": 1,
  "tokens": {
    "color": {
      "accent": { "$type": "color", "$value": "#0f766e" },
      "muted": { "$type": "color", "$value": 12 }
    },
    "spacing": {
      "sm": { "$type": "dimension", "$value": { "value": 8, "unit": "px" } },
      "md": { "$type": "dimension", "$value": "16px" }
    },
    "typography": { "body": { "$type": "typography", "$value": {} } }
  },
  "components": [
    { "id": "button", "name": "Button", "do": ["One primary button per view."], "dont": [], "example": "<button>Save</button>" }
  ],
  "rules": [
    { "id": "calm", "text": "Keep surfaces quiet.", "do": [], "dont": ["Gradients."], "example": "A grey card with one teal button." },
    { "id": "calm", "text": "A second rule under the same ID.", "do": [], "dont": [], "example": "x" },
    { "id": "no-example", "text": "A rule with no example.", "do": [], "dont": [] }
  ]
}
\`\`\``;
  const { controller, command, projectId, adapter, run, status } = await project(t, answer);
  const before = status();
  const description = 'Calm and quiet, one teal accent, 8 px spacing.';

  const result = await run('DraftDesignSystem', { projectId, description });

  // Skipped: a number as a color, a dimension written as text, a group the contract has no
  // place for, a repeated rule ID and a rule with no example.
  assert.deepEqual(result.data, {
    kind: 'design-system-draft',
    source: 'description',
    path: null,
    system: {
      schema: 1,
      tokens: {
        color: { accent: { $type: 'color', $value: '#0f766e' } },
        type: {},
        spacing: { sm: { $type: 'dimension', $value: { value: 8, unit: 'px' } } },
        radius: {},
        shadow: {},
        motion: {},
      },
      components: [
        {
          id: 'button',
          name: 'Button',
          do: ['One primary button per view.'],
          dont: [],
          example: '<button>Save</button>',
        },
      ],
      rules: [
        {
          id: 'calm',
          text: 'Keep surfaces quiet.',
          do: [],
          dont: ['Gradients.'],
          example: 'A grey card with one teal button.',
        },
      ],
    },
    skipped: 5,
  });
  const read = await controller.execute(command('ReadDesignSystem', { projectId }), 'local-owner');
  assert.equal(read.data?.kind === 'design-system' && read.data.record, null);
  assert.equal(status(), before);

  assert.equal(adapter.requests.length, 1);
  const request = adapter.requests[0] as (typeof adapter.requests)[number] & {
    threadTools?: boolean;
    mcp?: unknown;
  };
  assert.equal(request.role, 'orchestrator');
  assert.deepEqual(request.selection, selection);
  assert.deepEqual(
    [request.readOnly, request.permissionPolicy, request.permissionGrants, request.threadTools],
    [true, 'ask', [], false],
  );
  assert.equal(request.mcp, undefined);
  assert.match(request.prompt, /Calm and quiet, one teal accent/);
  assert.match(request.prompt, /^- src\/theme\.css$/m);
  // The turn ran in a folder of its own, gone once the answer came back.
  assert.equal(existsSync(request.scratch.directory), false);
});

test('an unreadable answer refuses, and a retried key runs no second turn', async (t) => {
  const { controller, command, projectId, adapter } = await project(
    t,
    'A calm palette with one teal accent would suit this project.',
  );
  const draft = command(
    'DraftDesignSystem',
    { projectId, description: 'Calm, one teal accent.' },
    0,
  );
  const refused = {
    outcome: 'blocked',
    reason: 'design-draft-unreadable',
    next: 'The draft could not be read. Try again or start from a template.',
  };

  // The second send arrives while the first is still waiting on the model.
  const both = await Promise.all([
    controller.execute(draft, 'local-owner'),
    controller.execute(draft, 'local-owner'),
  ]);
  assert.deepEqual(both, [refused, refused]);
  assert.deepEqual(await controller.execute(draft, 'local-owner'), refused);
  assert.equal(adapter.requests.length, 1);
});
