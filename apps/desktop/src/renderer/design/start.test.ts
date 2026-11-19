import assert from 'node:assert/strict';
import test from 'node:test';
import { DesignSystemRecordSchema, DesignSystemSourceSchema } from '@crewkite/contracts';
import { IMPORT_PROBES, type ImportAnswer, NEUTRAL_TEMPLATE, probeImports } from './start.ts';

// Claim: the empty editor offers the project's own style files. Each well-known path is asked for
// once, a path that is not there drops out, and a file that exists but does not read stays in the
// list with its line in plain words, so the person sees what to fix.
test('the import probe asks for each well-known path once and keeps the files that exist', async () => {
  for (const { path } of IMPORT_PROBES)
    assert.ok(DesignSystemRecordSchema.shape.path.safeParse(path).success, path);
  assert.deepEqual(
    [...new Set(IMPORT_PROBES.map(({ source }) => source))].sort(),
    [...DesignSystemSourceSchema.options].sort(),
  );

  const asked: string[] = [];
  const found = await probeImports(async ({ source, path }): Promise<ImportAnswer> => {
    asked.push(path);
    if (path === 'src/styles/tokens.css')
      return { draft: { source, path, system: NEUTRAL_TEMPLATE, skipped: 14 } };
    if (path === 'tokens.json')
      return {
        refused: 'design-file-invalid',
        next: 'tokens.json: Line 7: tokens.color.accent.$value: Invalid input: expected string, received number.',
      };
    if (path === 'DESIGN.md')
      return { draft: { source, path, system: NEUTRAL_TEMPLATE, skipped: 0 } };
    return { refused: 'design-file-missing', next: `${path} is not in the project.` };
  });
  assert.deepEqual(
    asked,
    IMPORT_PROBES.map(({ path }) => path),
  );
  assert.deepEqual(
    found.map((probe) =>
      'draft' in probe ? `${probe.path} ${probe.draft.skipped}` : `${probe.path}: ${probe.problem}`,
    ),
    [
      'tokens.json: Line 7: color.accent must be text, found a number.',
      'src/styles/tokens.css 14',
      'DESIGN.md 0',
    ],
  );
  // A probe whose answer never came is no file problem. The probe fails with its line.
  const lost = 'The controller did not answer. Import again once it is connected.';
  await assert.rejects(
    probeImports(
      async ({ source, path }): Promise<ImportAnswer> =>
        path === 'tokens.json'
          ? { refused: 'outcome-unknown', next: lost }
          : { refused: 'design-file-missing', next: `${path} is not in ${source}.` },
    ),
    { message: lost },
  );
});
