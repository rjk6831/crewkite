import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ChatCatalogEntry,
  ChatFamily,
  ChatHandoffMode,
  ChatPlan,
  ChatPlanSlice,
} from '@crewkite/contracts';
import { assignPlan, type PlanFile, type PlanInputs, parsePlan } from './plan.ts';

const NOW = Date.parse('2026-10-28T00:00:00.000Z');
const hours = (value: number) => new Date(NOW + value * 3_600_000).toISOString();

function entry(family: ChatFamily, percent: number | null, resetsIn: number | null) {
  return {
    family,
    connected: true,
    reason: null,
    models: [
      { model: `${family}-model`, label: family, efforts: ['default'], defaultEffort: 'default' },
    ],
    defaultModel: `${family}-model`,
    remaining: [
      {
        windowId: 'weekly',
        label: 'weekly',
        percent,
        resetsAt: resetsIn === null ? null : hours(resetsIn),
        observedAt: hours(0),
      },
    ],
    accepts: null,
  } satisfies ChatCatalogEntry;
}

const slice = (
  id: number,
  difficulty: ChatPlanSlice['difficulty'],
  files: string[] = [],
  hint?: ChatPlanSlice['hint'],
): ChatPlanSlice => ({
  id,
  title: `Slice ${id}`,
  brief: 'Do the part.',
  files,
  depends: id > 1 ? [id - 1] : [],
  difficulty,
  readOnly: false,
  ...(hint ? { hint } : {}),
});

// The real fit check lives with the Local adapter. This one fits up to 12,000 bytes and no image.
const fits: PlanInputs['localSliceFits'] = (files, _context, image) =>
  !image && files.reduce((sum, file) => sum + file.bytes, 0) <= 12_000;

test('assignment is a pure function of connected families, allowances, difficulty and Local fit', () => {
  const builder = { family: 'anthropic', model: 'anthropic-pinned', effort: 'default' } as const;
  const all = [
    entry('openai', 60, 10),
    entry('anthropic', 40, 2),
    entry('google', 60, 10),
    entry('local', null, null),
  ];
  const files: Record<string, PlanFile> = {
    'src/small.ts': { bytes: 4000, image: false },
    'src/big.ts': { bytes: 40_000, image: false },
    'docs/shot.png': { bytes: 900, image: true },
  };
  const rows: {
    name: string;
    slices: ChatPlanSlice[];
    families?: ChatCatalogEntry[];
    mode?: ChatHandoffMode;
    localContext?: number | null;
    want: [string, string, string][];
    candidates?: string[];
  }[] = [
    {
      name: 'easy fits Local, hard stays on the builder',
      slices: [slice(1, 'easy', ['src/small.ts']), slice(2, 'hard', ['src/big.ts'])],
      want: [
        [
          'local',
          'local-model',
          'Slice 1 (easy) assigned to Local: 5,478 token room, Local first.',
        ],
        [
          'anthropic',
          'anthropic-pinned',
          'Slice 2 (hard) assigned to Anthropic: the crew builder, ranked 3 of 3 by Most allowance left.',
        ],
      ],
      // Local does not fit slice 2, so it is no candidate there.
      candidates: ['openai', 'google', 'anthropic'],
    },
    {
      name: 'easy that does not fit goes to the top-ranked family',
      slices: [slice(1, 'easy', ['src/big.ts'])],
      want: [
        [
          'openai',
          'openai-model',
          "Slice 1 (easy) assigned to OpenAI: the files do not fit Local's 5,478 token room, first by Most allowance left.",
        ],
      ],
    },
    {
      name: 'an image never goes to Local',
      slices: [slice(1, 'easy', ['docs/shot.png'])],
      want: [
        [
          'openai',
          'openai-model',
          'Slice 1 (easy) assigned to OpenAI: Local takes no image file, first by Most allowance left.',
        ],
      ],
    },
    {
      name: 'the hint breaks a tie between equal families',
      slices: [slice(1, 'easy', ['docs/shot.png'], { family: 'google' })],
      want: [
        [
          'google',
          'google-model',
          'Slice 1 (easy) assigned to Google: Local takes no image file, first by Most allowance left. The plan hint broke a tie.',
        ],
      ],
    },
    {
      name: 'the hint never adds a family at zero',
      slices: [slice(1, 'medium', [], { family: 'google' })],
      families: [entry('openai', 60, 10), entry('anthropic', 0, 2), entry('google', 0, 10)],
      localContext: null,
      want: [
        [
          'openai',
          'openai-model',
          "Slice 1 (medium) assigned to OpenAI: the builder's family Anthropic does not rank, first by Most allowance left.",
        ],
      ],
      candidates: ['openai'],
    },
    {
      name: 'Resets soonest puts the builder first and Local stays out without a context',
      slices: [slice(1, 'easy', ['src/small.ts'])],
      mode: 'resets-first',
      localContext: null,
      want: [
        [
          'anthropic',
          'anthropic-pinned',
          'Slice 1 (easy) assigned to Anthropic: Local reports no context length, first by Resets soonest.',
        ],
      ],
    },
    {
      name: 'no Local connected',
      slices: [slice(1, 'easy')],
      families: [entry('openai', 60, 10), entry('google', 70, 10)],
      want: [
        [
          'google',
          'google-model',
          'Slice 1 (easy) assigned to Google: Local is not connected, first by Most allowance left.',
        ],
      ],
    },
    {
      name: 'nothing ranks',
      slices: [slice(1, 'hard')],
      families: [entry('openai', 0, 10)],
      want: [],
      candidates: [],
    },
  ];
  for (const row of rows) {
    const plan: ChatPlan = { planId: 'p1', goal: 'Ship it.', slices: row.slices };
    const inputs: PlanInputs = {
      families: row.families ?? all,
      mode: row.mode ?? 'most-left',
      now: NOW,
      builder,
      localContext: row.localContext === undefined ? 8192 : row.localContext,
      localSliceFits: fits,
      files,
    };
    const cards = assignPlan(plan, inputs);
    // Same inputs, same card.
    assert.deepEqual(assignPlan(plan, inputs), cards, row.name);
    assert.deepEqual(
      cards.flatMap((card) =>
        card.assignment
          ? [[card.assignment.family, card.assignment.model, card.assignment.reason]]
          : [],
      ),
      row.want,
      row.name,
    );
    assert.ok(
      cards.every((card) => card.status === 'queued' && card.turnId === null),
      row.name,
    );
    if (row.candidates)
      assert.deepEqual(
        cards.at(-1)?.candidates.map((value) => value.family),
        row.candidates,
        row.name,
      );
  }

  // The plan block: the last fenced json block tagged plan counts, and a bad one says why.
  const block = (body: string) => `Here is the plan.\n\n\`\`\`json plan\n${body}\n\`\`\`\n`;
  const plan = { planId: 'p1', goal: 'Ship it.', slices: [slice(1, 'easy')] };
  assert.deepEqual(parsePlan(block(JSON.stringify(plan))), { plan });
  assert.deepEqual(parsePlan('No block.'), {
    error: 'The reply has no fenced json block tagged plan.',
  });
  assert.match(
    (parsePlan(block('{')) as { error: string }).error,
    /^The plan block is not valid JSON\./,
  );
  const cycle = { ...plan, slices: [slice(1, 'easy'), { ...slice(2, 'easy'), depends: [2] }] };
  assert.deepEqual(parsePlan(block(JSON.stringify(cycle))), {
    error:
      'The plan does not match the schema. Slice dependencies must name other slices of the plan, once each, without a cycle.',
  });
  const outside = { ...plan, slices: [slice(1, 'easy', ['../etc/passwd'])] };
  assert.match(
    (parsePlan(block(JSON.stringify(outside))) as { error: string }).error,
    /slices\.0\.files\.0: A plan names files by their path inside the scratch copy\./,
  );
});
