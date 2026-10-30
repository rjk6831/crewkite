import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  ChatCatalogEntry,
  ChatFamily,
  ChatHandoffMode,
  ChatPlan,
  ChatPlanSlice,
} from '@crewkite/contracts';
import { createSyntheticRepository } from '@crewkite/testkit/repository';
import { assignPlan, type PlanFile, type PlanInputs, parsePlan } from './plan.ts';
import {
  laneCopy,
  laneFolder,
  prepareLaneCopy,
  readySlices,
  recordStep,
  replayLane,
} from './plan-lanes.ts';

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

test('ready slices start together with every dependency done, one per family, none while one is blocked', () => {
  type Row = { id: number; family: ChatFamily | null; depends: number[]; status: string };
  const card = (rows: Row[]) => ({
    slices: rows.map((row) => ({
      id: row.id,
      title: `Slice ${row.id}`,
      difficulty: 'medium' as const,
      depends: row.depends,
      readOnly: false,
      status: row.status as 'queued',
      assignment: row.family
        ? { family: row.family, model: `${row.family}-model`, reason: 'Ranked.' }
        : null,
      candidates: [],
      turnId: null,
    })),
  });
  const rows: {
    name: string;
    slices: Row[];
    busy: ChatFamily[];
    ready: number[];
  }[] = [
    {
      name: 'independent slices on two families start together',
      slices: [
        { id: 1, family: 'openai', depends: [], status: 'queued' },
        { id: 2, family: 'local', depends: [], status: 'queued' },
      ],
      busy: [],
      ready: [1, 2],
    },
    {
      name: 'two ready slices on one family run one after the other, in plan order',
      slices: [
        { id: 1, family: 'openai', depends: [], status: 'queued' },
        { id: 2, family: 'openai', depends: [], status: 'queued' },
      ],
      busy: [],
      ready: [1],
    },
    {
      name: 'a family answering elsewhere holds its slice back',
      slices: [
        { id: 1, family: 'openai', depends: [], status: 'queued' },
        { id: 2, family: 'local', depends: [], status: 'queued' },
      ],
      busy: ['openai'],
      ready: [2],
    },
    {
      name: 'a slice waits until every slice it depends on is done',
      slices: [
        { id: 1, family: 'openai', depends: [], status: 'done' },
        { id: 2, family: 'local', depends: [], status: 'running' },
        { id: 3, family: 'google', depends: [1, 2], status: 'queued' },
        { id: 4, family: 'anthropic', depends: [1], status: 'queued' },
      ],
      busy: ['local'],
      ready: [4],
    },
    {
      name: 'a slice with no family to run on never starts',
      slices: [
        { id: 1, family: null, depends: [], status: 'queued' },
        { id: 2, family: 'local', depends: [], status: 'queued' },
      ],
      busy: [],
      ready: [2],
    },
    {
      name: 'nothing starts while a slice is blocked',
      slices: [
        { id: 1, family: 'openai', depends: [], status: 'blocked' },
        { id: 2, family: 'local', depends: [], status: 'queued' },
      ],
      busy: [],
      ready: [],
    },
  ];
  for (const row of rows)
    assert.deepEqual(
      readySlices(card(row.slices), new Set(row.busy)).map((slice) => slice.id),
      row.ready,
      row.name,
    );
});

test('a slice replays only its own changes, and a blocked slice writes nothing until it is resolved', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-lanes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = createSyntheticRepository(join(directory, 'demo-shop'));
  const root = repository.directory;
  const base = repository.base;
  // The thread copy is the base plus slice 1's merged work, a.txt.
  const threadScratch = join(directory, 'chat', 'scratch');
  cpSync(root, threadScratch, { recursive: true, filter: (path) => !path.endsWith('/.git') });
  writeFileSync(join(threadScratch, 'a.txt'), 'slice one\n');
  const at = (path: string) =>
    existsSync(join(threadScratch, path)) ? readFileSync(join(threadScratch, path), 'utf8') : null;
  type Replayed = { applied: string[]; conflicts: string[]; dropped: string[]; skipped: string[] };
  const none = { conflicts: [], dropped: [], skipped: [] };
  type Step = { step: 'build' | 'review' | 'fix'; writes: Record<string, string> };
  const rows: {
    name: string;
    steps: Step[];
    /** The thread copy changes these paths after the slice copy was made. */
    thread?: Record<string, string>;
    /** What the orchestrator's resolve turn writes in the thread copy. */
    resolve?: Record<string, string>;
    want: Replayed;
    after?: Replayed;
    files: Record<string, string | null>;
  }[] = [
    {
      name: 'a builder with no review chain replays everything it changed',
      steps: [{ step: 'build', writes: { 'b.txt': 'two\n' } }],
      want: { ...none, applied: ['b.txt'] },
      files: { 'a.txt': 'slice one\n', 'b.txt': 'two\n' },
    },
    {
      // The fixer put a.txt back where the slice started, so a.txt is no longer the slice's own.
      name: 'a path a fixer reverts stops being its own, and a later review edit there stays out',
      steps: [
        { step: 'build', writes: { 'b.txt': 'two\n' } },
        { step: 'review', writes: { 'a.txt': 'reviewer\n' } },
        { step: 'fix', writes: { 'a.txt': 'slice one\n' } },
        { step: 'review', writes: { 'a.txt': 'reviewer again\n' } },
      ],
      want: { ...none, applied: ['b.txt'], dropped: ['a.txt'] },
      files: { 'a.txt': 'slice one\n', 'b.txt': 'two\n' },
    },
    {
      // Ownership is by path: a path the builder changed stays the slice's own.
      name: "a reviewer's edits outside the slice's own paths are left out, its merged file and a new one",
      steps: [
        { step: 'build', writes: { 'b.txt': 'two\n' } },
        {
          step: 'review',
          writes: { 'a.txt': 'reviewer\n', 'b.txt': 'reviewed\n', 'e.txt': 'extra\n' },
        },
      ],
      want: { ...none, applied: ['b.txt'], dropped: ['a.txt', 'e.txt'] },
      files: { 'a.txt': 'slice one\n', 'b.txt': 'reviewed\n', 'e.txt': null },
    },
    {
      name: "a fix after a review counts as the slice's own change, and the review's edit stays out",
      steps: [
        { step: 'build', writes: { 'b.txt': 'two\n' } },
        { step: 'review', writes: { 'a.txt': 'reviewer\n' } },
        { step: 'fix', writes: { 'b.txt': 'two fixed\n' } },
      ],
      want: { ...none, applied: ['b.txt'], dropped: ['a.txt'] },
      files: { 'a.txt': 'slice one\n', 'b.txt': 'two fixed\n' },
    },
    {
      name: 'a conflict writes none of the clean paths, and the resolve then writes them',
      steps: [{ step: 'build', writes: { 'net.mjs': 'slice\n', 'c.txt': 'clean\n' } }],
      thread: { 'net.mjs': 'thread\n' },
      resolve: { 'net.mjs': 'merged\n' },
      want: { ...none, applied: [], conflicts: ['net.mjs'] },
      after: { ...none, applied: ['c.txt'] },
      files: { 'net.mjs': 'merged\n', 'c.txt': 'clean\n' },
    },
    {
      name: 'a resolve that never ends done leaves the thread copy without the clean paths',
      steps: [{ step: 'build', writes: { 'net.mjs': 'slice\n', 'c.txt': 'clean\n' } }],
      thread: { 'net.mjs': 'thread\n' },
      want: { ...none, applied: [], conflicts: ['net.mjs'] },
      files: { 'net.mjs': 'thread\n', 'c.txt': null },
    },
  ];
  rows.forEach((row, index) => {
    const folder = laneFolder(threadScratch, index + 2);
    const saved = new Map(['net.mjs', 'b.txt', 'c.txt'].map((path) => [path, at(path)] as const));
    prepareLaneCopy({ root, base, threadScratch, folder });
    const reviewed = row.steps.some((step) => step.step === 'review');
    for (const { step, writes } of row.steps) {
      for (const [path, text] of Object.entries(writes))
        writeFileSync(join(laneCopy(folder), path), text);
      // The runner records each step of a lane that has a review chain.
      if (reviewed) recordStep({ root, base, folder, writer: step !== 'review' });
    }
    for (const [path, text] of Object.entries(row.thread ?? {}))
      writeFileSync(join(threadScratch, path), text);
    const input = { root, base, threadScratch, folder };
    assert.deepEqual(replayLane(input), row.want, row.name);
    if (row.resolve) {
      for (const [path, text] of Object.entries(row.resolve))
        writeFileSync(join(threadScratch, path), text);
      assert.deepEqual(replayLane({ ...input, resolved: true }), row.after, row.name);
    }
    for (const [path, text] of Object.entries(row.files)) assert.equal(at(path), text, row.name);
    // Each row starts from the same thread copy.
    for (const [path, text] of saved)
      if (text === null) rmSync(join(threadScratch, path), { force: true });
      else writeFileSync(join(threadScratch, path), text);
  });
});
