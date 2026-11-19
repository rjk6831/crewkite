import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PlanRecipe } from '@crewkite/contracts';
import { createTestIds } from '../../../../packages/testkit/src/index.ts';
import { installedTools } from '../../../controller/src/store/controller-fixture.ts';
import { runCli } from '../main.ts';
import { startScriptedController } from '../scripted-controller.ts';

function capture() {
  const seen = { out: '', err: '' };
  return {
    seen,
    output: {
      out: (text: string) => {
        seen.out += text;
      },
      err: (text: string) => {
        seen.err += text;
      },
    },
  };
}

const pick = { family: 'anthropic', model: 'model-b', effort: 'default' } as const;
const recipe = (name: string): PlanRecipe => ({
  schema: 1,
  name,
  description: 'Tidy one module.',
  shape: 'change',
  crew: {
    name: 'Pair',
    members: [
      { role: 'orchestrator', selection: pick },
      { role: 'builder', selection: pick },
    ],
  },
  run: {
    flightMode: 'glide',
    permissionPolicy: 'allow-edits',
    handoff: { auto: true, mode: 'resets-first' },
    maxSlices: 3,
  },
  checks: [{ command: 'node --test' }],
  trigger: { kind: 'manual' },
  budget: null,
  work: null,
});

test('recipe list, show and run print the table lines and refuse an unknown or ambiguous name', {
  timeout: 60_000,
}, async (t) => {
  // Only git on PATH, so a run cannot find gh or a provider client.
  const tools = mkdtempSync(join(tmpdir(), 'ck-cli-recipes-'));
  const saved = process.env.PATH;
  process.env.PATH = installedTools(tools, 'git');
  t.after(() => {
    process.env.PATH = saved;
    rmSync(tools, { recursive: true, force: true });
  });
  const { home, repository, controller } = await startScriptedController(t, [
    [{ kind: 'text', itemId: 'r', chunks: ['Nothing to split.'] }],
  ]);
  const run = async (...args: string[]) => {
    const { seen, output } = capture();
    const code = await runCli([...args, '--home', home], output);
    return { code, ...seen };
  };
  const added = await run('project', 'add', repository);
  const project = /Project (prj_[0-9A-Z]{26})/.exec(added.out)?.[1] ?? '';
  assert.ok(project);

  const empty = await run('recipe', 'list', '--project', project);
  assert.deepEqual([empty.code, empty.out], [0, 'No recipes in this project.\n']);

  const ids = createTestIds(new Date(0).toISOString());
  const save = async (path: string, name: string) => {
    const saved = await controller.execute(
      {
        protocol: 1,
        key: ids('cmd'),
        actor: { id: 'terminal', kind: 'cli' },
        command: 'SaveRecipe',
        payload: {
          projectId: project,
          path,
          body: recipe(name),
          expectedVersion: 0,
          confirm: 'explicit',
        },
        expectedRevision: 0,
      },
      'local-owner',
    );
    assert.equal(saved.outcome, 'applied', JSON.stringify(saved));
  };
  await save('.crewkite/recipes/tidy.json', 'Tidy');
  await save('.crewkite/recipes/other.json', 'Tidy');
  await save('.crewkite/recipes/solo.json', 'Solo');

  const listed = await run('recipe', 'list');
  assert.equal(listed.code, 0);
  assert.equal(
    listed.out,
    [
      'NAME  STARTS  LOOP  FILE  PATH',
      'Tidy  Manual              .crewkite/recipes/other.json',
      'Solo  Manual              .crewkite/recipes/solo.json',
      'Tidy  Manual              .crewkite/recipes/tidy.json',
      '',
    ].join('\n'),
  );

  const shown = await run('recipe', 'show', 'Solo');
  assert.equal(shown.code, 0);
  assert.equal(
    shown.out,
    [
      'Solo  version 1  .crewkite/recipes/solo.json',
      'Tidy one module.',
      '',
      'Run type   Changes files',
      'Flight     Glide   Permissions Allow edits   Most slices 3',
      'On a limit Move to another provider, Resets soonest',
      '',
      'Crew',
      '  orchestrator  Anthropic  model-b  default',
      '  builder  Anthropic  model-b  default',
      '',
      'Checks',
      '  node --test',
      '',
      'Starts     Manual',
      '',
    ].join('\n'),
  );

  // Rows: the sentence each refusal prints to stderr, and the exit status for nothing done.
  const refusals: [string[], string][] = [
    [['show', 'Nothing'], 'No recipe matches "Nothing".\n'],
    [['show', 'Tidy'], 'More than one recipe matches "Tidy". Use its path.\n'],
    [['run', 'Tidy', 'Go.'], 'More than one recipe matches "Tidy". Use its path.\n'],
    [['show', 'Tidy', 'one'], 'Quote a name that has spaces.\n'],
    [['run', 'Tidy', 'one', 'Go.'], 'Quote a name that has spaces.\n'],
    [['run', 'Solo', 'Tidy', 'it.'], 'Quote a request that has spaces.\n'],
  ];
  for (const [args, says] of refusals) {
    const refused = await run('recipe', ...args);
    assert.deepEqual([refused.code, refused.out, refused.err], [2, '', says], args.join(' '));
  }

  const started = await run('recipe', 'run', '.crewkite/recipes/tidy.json', 'Tidy it.');
  const thread = /^Started Tidy as thread (tsk_[0-9A-Z]{26})\.\n/.exec(started.out)?.[1] ?? '';
  assert.ok(thread, started.out);
  assert.deepEqual(
    [started.code, started.out.split('\n').slice(1).join('\n')],
    [0, `Follow it with: crewkite thread watch ${thread}\n`],
  );

  const asJson = await run('recipe', 'run', 'Solo', 'Tidy it.', '--json');
  const line = JSON.parse(asJson.out);
  assert.deepEqual(
    [asJson.code, line.kind, line.command, line.outcome, line.data.run.origin],
    [0, 'result', 'RunRecipe', 'applied', 'manual'],
  );
});
