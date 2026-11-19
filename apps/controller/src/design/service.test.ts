import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DesignSystem, Project } from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { createTestClock, createTestIds } from '@crewkite/testkit';
import { setup } from '../store/controller-fixture.ts';
import { Store } from '../store/index.ts';
import { DesignRefused, DesignSystems } from './service.ts';

const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));

const px = (value: number) => ({
  $type: 'dimension' as const,
  $value: { value, unit: 'px' as const },
});
const base: DesignSystem = {
  schema: 1,
  tokens: {
    color: { accent: { $type: 'color', $value: '#2f6feb' } },
    type: {},
    spacing: { sm: px(8) },
    radius: { sm: px(4) },
    shadow: {},
    motion: {},
  },
  components: [],
  rules: [],
};

/** A design service over a real store and a project folder of its own. */
function harness(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-design-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'state.sqlite'));
  t.after(() => store.close());
  store.applyMigrations(migrations);
  const clock = createTestClock();
  const project: Project = { id: createTestIds(clock.now())('prj'), name: 'shop', revision: 0 };
  store.transaction(() => store.put('project', project.id, 0, project));
  const folder = join(directory, 'shop');
  mkdirSync(folder);
  const design = new DesignSystems({
    store,
    now: clock.now,
    projectPath: (id) => (id === project.id ? folder : undefined),
  });
  // The controller runs every command in one store transaction. So do these calls.
  const save = (path: string, body: DesignSystem, expectedVersion: number) =>
    store.transaction(() =>
      design.save({ projectId: project.id, path, body, expectedVersion, confirm: 'explicit' }),
    );
  const refused = (run: () => unknown) => {
    try {
      run();
    } catch (failure) {
      if (failure instanceof DesignRefused) return failure.reason;
      throw failure;
    }
    return 'saved';
  };
  return { design, store, projectId: project.id, folder, directory, save, refused };
}

test('a save writes the file and the next version, and refuses a stale version or an edit on disk', (t) => {
  const { store, projectId, folder, directory, save, refused } = harness(t);
  const file = join(folder, 'design', 'system.json');

  const first = save('design/system.json', base, 0);
  assert(!('stale' in first));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), base);
  assert.deepEqual(
    [first.record.version, first.record.versionHash, first.record.delivery],
    [1, hashCanonical(base), true],
  );
  assert.deepEqual(first.added, ['color.accent', 'spacing.sm', 'radius.sm']);

  const rule = {
    id: 'tokens-only',
    text: 'Use tokens',
    do: ['Use color.accent'],
    dont: [],
    example: 'color: var(--accent)',
  };
  const next: DesignSystem = {
    ...base,
    tokens: {
      ...base.tokens,
      color: { accent: { $type: 'color', $value: '#0055ff' } },
      spacing: { sm: px(8), md: px(16) },
      radius: {},
    },
    rules: [rule],
  };
  const second = save('design/system.json', next, 1);
  assert(!('stale' in second));
  assert.deepEqual(
    [second.added, second.changed, second.removed],
    [['spacing.md', 'rule:tokens-only'], ['color.accent'], ['radius.sm']],
  );
  assert.equal(store.designSystemVersion(projectId, 2)?.versionHash, hashCanonical(next));
  assert.equal(store.designSystem(projectId)?.versionHash, hashCanonical(next));

  assert.deepEqual(save('design/system.json', base, 1), { stale: 2 });

  // Someone edits the file by hand. Saving over it would lose that edit, so it refuses and the
  // edit stays. Saving the file's own content records it as the next version.
  const edited = JSON.stringify(base, null, 2);
  writeFileSync(file, edited);
  assert.equal(
    refused(() => save('design/system.json', next, 2)),
    'design-file-changed',
  );
  assert.equal(readFileSync(file, 'utf8'), edited);
  assert.equal(
    refused(() => save('design/system.json', base, 2)),
    'saved',
  );

  // A link inside the project can point anywhere. Nothing is written through it.
  const outside = join(directory, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(folder, 'linked'));
  assert.equal(
    refused(() => save('linked/system.json', base, 3)),
    'design-path-unsafe',
  );
  assert.equal(existsSync(join(outside, 'system.json')), false);
  assert.equal(store.designSystem(projectId)?.version, 3);
});

test('a read reports the file as current, changed, invalid with its line, or missing', (t) => {
  const { design, projectId, folder, save } = harness(t);
  assert.deepEqual(design.read(projectId).read, {
    projectId,
    record: null,
    system: null,
    file: null,
    preview: null,
  });
  save('design-system.json', base, 0);
  const file = join(folder, 'design-system.json');
  const edited: DesignSystem = { ...base, tokens: { ...base.tokens, spacing: {} } };
  // Line 7 holds color.accent's value.
  const invalid = JSON.stringify(base, null, 2).replace('"#2f6feb"', '12');
  const cases: [string, string | null, string, DesignSystem, RegExp | undefined][] = [
    ['as saved', JSON.stringify(base), 'current', base, undefined],
    ['edited on disk', JSON.stringify(edited), 'changed', edited, undefined],
    [
      'invalid',
      invalid,
      'invalid',
      base,
      /^design-system\.json: Line 7: tokens\.color\.accent\.\$value: /,
    ],
    ['missing', null, 'missing', base, undefined],
  ];
  for (const [name, text, state, shown, problem] of cases) {
    if (text === null) rmSync(file);
    else writeFileSync(file, text);
    const { read, next } = design.read(projectId);
    assert.equal(read.file, state, name);
    assert.deepEqual(read.system, shown, name);
    if (problem) assert.match(next ?? '', problem, name);
    else assert.equal(next, undefined, name);
  }
});

test('turning delivery off changes the record and records no version', async (t) => {
  const { controller, command, draft, source } = await setup(t);
  const { projectId } = draft.payload as { projectId: string };
  const run = (name: string, payload: unknown, revision?: number) =>
    controller.execute(command(name, payload, revision), 'local-owner');
  const saved = await run(
    'SaveDesignSystem',
    { projectId, path: 'design-system.json', body: base, expectedVersion: 0, confirm: 'explicit' },
    0,
  );
  assert.equal(saved.data?.kind, 'design-system-saved');
  assert(saved.data?.kind === 'design-system-saved');
  assert.ok(existsSync(join(source.directory, 'design-system.json')));

  assert.equal(
    (await run('SetDesignSystemDelivery', { projectId, enabled: false }, 0)).outcome,
    'applied',
  );
  const read = await run('ReadDesignSystem', { projectId });
  assert(read.data?.kind === 'design-system');
  assert.deepEqual(read.data.record, { ...saved.data.record, delivery: false });
  assert.equal(read.data.file, 'current');
  assert.equal(controller.store.designSystemVersion(projectId, 2), undefined);
});

test('a preview declaration round trips, and an address off this computer or a shell is refused', async (t) => {
  const { controller, command, draft } = await setup(t);
  const { projectId } = draft.payload as { projectId: string };
  const run = (name: string, payload: unknown) =>
    controller.execute(command(name, payload, 0), 'local-owner');
  const read = async () => {
    const result = await controller.execute(
      command('ReadDesignSystem', { projectId }),
      'local-owner',
    );
    assert(result.data?.kind === 'design-system');
    return result.data.preview;
  };
  const views = [
    { name: 'home', path: '/' },
    { name: 'cart', path: '/cart?step=2' },
  ];
  const preview = { command: 'pnpm  dev', url: 'http://localhost:5173/', views };
  // The images are judged by the saved system, so a project needs one first.
  assert.equal(
    (await run('SetDesignPreview', { projectId, preview })).reason,
    'design-system-not-found',
  );
  await run('SaveDesignSystem', {
    projectId,
    path: 'design-system.json',
    body: base,
    expectedVersion: 0,
    confirm: 'explicit',
  });
  assert.equal((await run('SetDesignPreview', { projectId, preview })).outcome, 'applied');
  const kept = { command: 'pnpm dev', url: 'http://localhost:5173', views };
  assert.deepEqual(await read(), kept);

  const refusals: [string, unknown, string][] = [
    ['a LAN address', { ...kept, url: 'http://192.168.1.20:5173' }, 'invalid-command'],
    ['a lookalike host', { ...kept, url: 'http://localhost.example.com' }, 'invalid-command'],
    [
      'a view on another host',
      { ...kept, views: [{ name: 'home', path: '//example.com/' }] },
      'invalid-command',
    ],
    ['a shell', { ...kept, command: 'sh -c vite' }, 'preview-command-refused'],
  ];
  for (const [name, value, reason] of refusals) {
    assert.equal(
      (await run('SetDesignPreview', { projectId, preview: value })).reason,
      reason,
      name,
    );
    assert.deepEqual(await read(), kept, name);
  }
  assert.equal((await run('SetDesignPreview', { projectId, preview: null })).outcome, 'applied');
  assert.equal(await read(), null);
});
