import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WRITING_RULES } from '@crewkite/contracts';
import { Store } from '../store/index.ts';
import { END_MARKER, START_MARKER, writingRulesExportCommand } from './writing-rules-export.ts';

const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
const projectId = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV';

function harness(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-rules-export-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'state.sqlite'));
  t.after(() => store.close());
  store.applyMigrations(migrations);
  const folder = join(directory, 'shop');
  mkdirSync(folder);
  const deps = { store, projectPath: (id: string) => (id === projectId ? folder : undefined) };
  const preview = (destination: string) => {
    const result = writingRulesExportCommand(deps, {
      command: 'PreviewWritingRulesExport',
      payload: { projectId, destination },
    } as never);
    assert(result.outcome === 'applied' && result.data?.kind === 'writing-rules-export');
    return result.data;
  };
  const write = (destination: string, previewHash: string, expectedDestination: string | null) =>
    writingRulesExportCommand(deps, {
      command: 'ExportWritingRules',
      payload: { projectId, destination, previewHash, expectedDestination, confirm: 'explicit' },
    } as never);
  const reason = (result: ReturnType<typeof write>) =>
    result.outcome === 'blocked' ? result.reason : result.outcome;
  return { store, folder, deps, preview, write, reason, directory };
}

test('an export writes exactly its preview and a patch replaces only the marked block', (t) => {
  const { store, folder, preview, write } = harness(t);
  const file = join(folder, 'AGENTS.md');

  const first = preview('AGENTS.md');
  assert.equal(first.mode, 'new-file');
  // Rule text for an export-only rule appears only after the person selects it.
  const exportOnly = WRITING_RULES.find((rule) => rule.surface === 'export-only');
  assert(exportOnly);
  assert(!first.preview.includes(exportOnly.text));
  assert.equal(write('AGENTS.md', first.previewHash, null).outcome, 'applied');
  assert.equal(readFileSync(file, 'utf8'), first.preview);

  // Selecting the export-only rule changes the next preview and puts its text in the block.
  store.transaction(() =>
    store.putWritingRule({
      ruleId: exportOnly.id,
      enabled: true,
      updatedAt: '2026-11-18T10:00:00.000Z',
    }),
  );
  const second = preview('AGENTS.md');
  assert.equal(second.mode, 'patch');
  assert(second.preview.includes(exportOnly.text));
  const kept = `Intro line\n\n${START_MARKER}\nold block\n${END_MARKER}\n\nTail line\n`;
  writeFileSync(file, kept);
  const third = preview('AGENTS.md');
  assert(third.preview.startsWith('Intro line\n\n'));
  assert(third.preview.endsWith(`${END_MARKER}\n\nTail line\n`));
  assert(!third.preview.includes('old block'));
  assert.equal(
    write('AGENTS.md', third.previewHash, third.destinationIdentity.sha256).outcome,
    'applied',
  );
  assert.equal(readFileSync(file, 'utf8'), third.preview);

  // A file with no block gets one appended after its own text, byte for byte.
  writeFileSync(file, 'Plain notes');
  const appended = preview('AGENTS.md');
  assert(appended.preview.startsWith('Plain notes\n\n'));
});

test('a stale preview and a file changed after the preview are each refused with nothing written', (t) => {
  const { store, folder, preview, write, reason } = harness(t);
  const file = join(folder, 'AGENTS.md');
  writeFileSync(file, 'mine\n');
  const shown = preview('AGENTS.md');

  // The file changed after the preview.
  writeFileSync(file, 'someone else\n');
  assert.equal(
    reason(write('AGENTS.md', shown.previewHash, shown.destinationIdentity.sha256)),
    'export-destination-changed',
  );
  assert.equal(readFileSync(file, 'utf8'), 'someone else\n');

  // The rules changed after the preview, so the shown text is no longer what would be written.
  const again = preview('AGENTS.md');
  store.transaction(() =>
    store.putWritingRule({
      ruleId: 'testing',
      enabled: false,
      updatedAt: '2026-11-18T10:00:00.000Z',
    }),
  );
  assert.equal(
    reason(write('AGENTS.md', again.previewHash, again.destinationIdentity.sha256)),
    'export-preview-stale',
  );
  assert.equal(readFileSync(file, 'utf8'), 'someone else\n');

  // A new file that appeared after a new-file preview is never replaced.
  const fresh = preview('NOTES.md');
  writeFileSync(join(folder, 'NOTES.md'), 'appeared\n');
  assert.equal(reason(write('NOTES.md', fresh.previewHash, null)), 'export-destination-changed');
  assert.equal(readFileSync(join(folder, 'NOTES.md'), 'utf8'), 'appeared\n');
});

test('a linked destination, a linked folder and a path outside the project are refused', (t) => {
  const { folder, directory, deps, reason } = harness(t);
  const outside = join(directory, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'AGENTS.md'), 'outside\n');
  symlinkSync(join(outside, 'AGENTS.md'), join(folder, 'AGENTS.md'));
  symlinkSync(outside, join(folder, 'linked'));

  const attempt = (destination: string) =>
    reason(
      writingRulesExportCommand(deps, {
        command: 'ExportWritingRules',
        payload: {
          projectId,
          destination,
          previewHash: '0'.repeat(64),
          expectedDestination: null,
          confirm: 'explicit',
        },
      } as never),
    );
  assert.equal(attempt('AGENTS.md'), 'export-path-unsafe');
  assert.equal(attempt('linked/new.md'), 'export-path-unsafe');
  assert.equal(attempt('../outside/new.md'), 'export-path-unsafe');
  assert.equal(readFileSync(join(outside, 'AGENTS.md'), 'utf8'), 'outside\n');
  assert.equal(existsSync(join(outside, 'new.md')), false);
});

// Claim: an export into a file that exists keeps that file's mode. A private file stays private
// and a script stays executable.
test('an export into an existing file keeps its mode', (t) => {
  const { folder, preview, write } = harness(t);
  for (const mode of [0o600, 0o755]) {
    const file = join(folder, `NOTES-${mode.toString(8)}.md`);
    writeFileSync(file, 'Plain notes\n');
    chmodSync(file, mode);
    const patch = preview(`NOTES-${mode.toString(8)}.md`);
    assert.equal(patch.mode, 'patch');
    assert.equal(
      write(`NOTES-${mode.toString(8)}.md`, patch.previewHash, patch.destinationIdentity.sha256)
        .outcome,
      'applied',
    );
    assert.equal(readFileSync(file, 'utf8'), patch.preview);
    assert.equal(statSync(file).mode & 0o777, mode, mode.toString(8));
  }
});
