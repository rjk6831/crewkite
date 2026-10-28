import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  CommandResult,
  Event,
  ExtensionCommandResult,
  ExtensionsRead,
  Task,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { installSampleExtension, sampleExtensionId } from '@crewkite/testkit/extensions';
import { setup } from '../store/controller-fixture.ts';
import { checkManifest } from './manifest.ts';

const manifest = (fields: object = {}) => ({
  id: 'probe',
  name: 'Probe',
  version: '1.0.0',
  contract: '1.0.0',
  entry: 'index.mjs',
  authority: ['thread.read'],
  commands: [{ id: 'look', title: 'Look' }],
  threadActions: [{ id: 'look', title: 'Look', command: 'look' }],
  ...fields,
});

test('a manifest is refused for a bad version, an unknown authority or another contract major', () => {
  const rows: [string, unknown, string | null][] = [
    ['a valid manifest is accepted', manifest(), null],
    ['a version that is not three numbers', manifest({ version: '1.0' }), 'bad-version'],
    ['a version with a suffix', manifest({ version: '1.0.0-beta' }), 'bad-version'],
    ['a missing version', manifest({ version: undefined }), 'bad-version'],
    ['a contract that is not a version', manifest({ contract: 'latest' }), 'bad-contract'],
    [
      'an authority CrewKite does not have',
      manifest({ authority: ['thread.read', 'limits.raise'] }),
      'unknown-authority',
    ],
    [
      'reading other threads is no authority',
      manifest({ authority: ['threads.read-all'] }),
      'unknown-authority',
    ],
    ['an older contract major', manifest({ contract: '0.9.0' }), 'contract-major-mismatch'],
    ['a newer contract major', manifest({ contract: '2.0.0' }), 'contract-major-mismatch'],
    ['a newer contract minor', manifest({ contract: '1.1.0' }), 'contract-too-new'],
    [
      'a slot that runs an undeclared command',
      manifest({ threadActions: [{ id: 'x', title: 'X', command: 'missing' }] }),
      'invalid-manifest',
    ],
    [
      'event kinds without the event authority',
      manifest({ eventKinds: ['seen'] }),
      'invalid-manifest',
    ],
    ['an entry outside the folder', manifest({ entry: '../index.mjs' }), 'invalid-manifest'],
    ['an unknown field', manifest({ limits: { queue: 99 } }), 'invalid-manifest'],
    ['a folder that names another extension', manifest({ id: 'other' }), 'folder-mismatch'],
    ['not an object', ['probe'], 'invalid-manifest'],
  ];
  for (const [claim, raw, refusal] of rows) {
    const checked = checkManifest(raw, 'probe', '1.0.0');
    assert.equal(checked.ok ? null : checked.refusal, refusal, claim);
    if (!checked.ok) assert.ok(checked.line.length > 0 && !/[\u2013\u2014]/.test(checked.line));
  }
  const major = checkManifest(manifest({ contract: '2.0.0' }), 'probe', '1.0.0');
  assert.equal(
    major.ok ? '' : major.line,
    'Built for extension contract 2.x. This CrewKite offers 1.x, so it stays off until the extension is updated.',
    'a contract major bump reads as one plain line',
  );
});

// The probe tries every way out of its context that the test can name.
const probeModule = `
let kept;
export const commands = {
  look: (context) => ({ text: JSON.stringify({
    context: Object.keys(context).sort(),
    thread: context.thread ? Object.keys(context.thread).sort() : null,
  }) }),
  other: (context) => ({ text: context.thread.read(context.input).taskId }),
  retitle: (context) => { context.thread.taskId = context.input; return { text: 'moved' }; },
  raise: () => ({ text: 'raised', limits: { queue: 99, turnMinutes: 600 } }),
  builtin: (context) => {
    try { context.emit('chat.thread', { text: 'spoofed' }); } catch { return { text: 'refused' }; }
    return { text: 'emitted' };
  },
  probed: (context) => { context.emit('probed', { text: 'seen' }); return { text: 'emitted' }; },
  later: async () => ({ text: 'late' }),
  thenable: () => ({ get then() { throw new Error('then getter'); } }),
  keep: (context) => { kept = context; return { text: 'kept' }; },
  reuse: () => {
    try { kept.thread.read(); return { text: 'leaked read' }; } catch {}
    try { kept.emit('probed', { text: 'late' }); return { text: 'leaked emit' }; } catch {}
    return { text: 'expired' };
  },
};
`;
const blindModule = `
export const commands = {
  look: (context) => ({ text: typeof context.thread?.read + ' ' + typeof context.emit }),
};
`;

function install(home: string, folder: string, fields: object, module: string) {
  const directory = join(home, 'extensions', folder);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify(manifest({ id: folder, ...fields })),
  );
  writeFileSync(join(directory, 'index.mjs'), module);
}

test('an extension command passes the built-in checks and reaches only its own thread with no limit to raise', async (t) => {
  const context = await setup(t);
  const { controller, command, draft, directory } = context;
  const home = join(directory, 'home');
  const mine = (await controller.execute(draft, 'local-owner')).entity as Task;
  const other = (
    await controller.execute(
      command('CreateTask', { ...(draft.payload as object), title: 'Other thread' }, 0),
      'local-owner',
    )
  ).entity as Task;
  const commandIds = [
    'look',
    'other',
    'retitle',
    'raise',
    'builtin',
    'probed',
    'later',
    'thenable',
    'keep',
    'reuse',
  ];
  install(
    home,
    'probe',
    {
      authority: ['thread.read', 'thread.event'],
      eventKinds: ['probed'],
      commands: commandIds.map((id) => ({ id, title: id })),
    },
    probeModule,
  );
  install(home, 'blind', { authority: [] }, blindModule);
  const read = async () =>
    (await controller.execute(command('ReadExtensions', {}), 'local-owner'))
      .data as ExtensionsRead & { kind: 'extensions' };
  const hashOf = async (id: string) =>
    (await read()).extensions.find((item) => item.manifest?.id === id)?.manifestHash ?? '';
  const run = (payload: object, principal = 'local-owner', key?: string) => {
    const value = command('RunExtensionCommand', payload, 0);
    return controller.execute(key ? { ...value, key } : value, principal);
  };
  const output = (result: CommandResult) =>
    (result.data as ExtensionCommandResult | undefined)?.output.text;
  const events: Event[] = [];
  const stop = controller.subscribe((event) => events.push(event));
  t.after(stop);

  // Off by default: nothing runs and no slot shows.
  assert.equal((await read()).slots.length, 0, 'no extension is on by default');
  assert.equal(
    (await run({ extensionId: 'probe', commandId: 'look', taskId: mine.id })).reason,
    'extension-off',
    'an extension that is off runs nothing',
  );
  assert.equal(
    (
      await controller.execute(
        command(
          'ConfigureExtension',
          {
            extensionId: 'probe',
            enabled: true,
            manifestHash: 'a'.repeat(64),
          },
          0,
        ),
        'local-owner',
      )
    ).reason,
    'extension-manifest-changed',
    'turning on names the manifest the person was shown',
  );
  for (const id of ['probe', 'blind'])
    assert.equal(
      (
        await controller.execute(
          command(
            'ConfigureExtension',
            { extensionId: id, enabled: true, manifestHash: await hashOf(id) },
            0,
          ),
          'local-owner',
        )
      ).outcome,
      'applied',
    );

  const before = hashCanonical(controller.store.get<Task>('task', mine.id));
  const rows: [string, object, Partial<CommandResult>, string?][] = [
    [
      'another principal is refused like any built-in command',
      { extensionId: 'probe', commandId: 'look', taskId: mine.id },
      { outcome: 'denied', reason: 'unauthenticated-actor' },
    ],
    [
      'an unknown task is refused before the extension runs',
      { extensionId: 'probe', commandId: 'look', taskId: `tsk_${'0'.repeat(25)}9` },
      { outcome: 'blocked', reason: 'task-not-found' },
    ],
    [
      'a command the manifest does not declare is refused',
      { extensionId: 'blind', commandId: 'other', taskId: mine.id },
      { outcome: 'blocked', reason: 'extension-command-unknown' },
    ],
    [
      'the context holds only the declared authority',
      { extensionId: 'probe', commandId: 'look', taskId: mine.id },
      { outcome: 'applied' },
      JSON.stringify({
        context: ['commandId', 'contract', 'emit', 'extensionId', 'input', 'thread'],
        thread: ['read', 'taskId'],
      }),
    ],
    [
      'without thread.read or thread.event the context has neither',
      { extensionId: 'blind', commandId: 'look', taskId: mine.id },
      { outcome: 'applied' },
      'undefined undefined',
    ],
    [
      'the reader returns the thread the command ran on, whatever it is asked',
      { extensionId: 'probe', commandId: 'other', taskId: mine.id, input: other.id },
      { outcome: 'applied' },
      mine.id,
    ],
    [
      'the context cannot be pointed at another thread',
      { extensionId: 'probe', commandId: 'retitle', taskId: mine.id, input: other.id },
      { outcome: 'blocked', reason: 'extension-failed' },
    ],
    [
      'a result that carries limits is refused',
      { extensionId: 'probe', commandId: 'raise', taskId: mine.id },
      { outcome: 'blocked', reason: 'extension-output-invalid' },
    ],
    [
      'a built-in event kind cannot be emitted',
      { extensionId: 'probe', commandId: 'builtin', taskId: mine.id },
      { outcome: 'applied' },
      'refused',
    ],
    [
      'an asynchronous command is refused',
      { extensionId: 'probe', commandId: 'later', taskId: mine.id },
      { outcome: 'blocked', reason: 'extension-async-unsupported' },
    ],
    [
      'a then getter that throws is an extension failure',
      { extensionId: 'probe', commandId: 'thenable', taskId: mine.id },
      { outcome: 'blocked', reason: 'extension-failed' },
    ],
    [
      'a command can keep its context',
      { extensionId: 'probe', commandId: 'keep', taskId: mine.id },
      { outcome: 'applied' },
      'kept',
    ],
    [
      'a kept context reads and emits nothing once its command returned',
      { extensionId: 'probe', commandId: 'reuse', taskId: other.id },
      { outcome: 'applied' },
      'expired',
    ],
  ];
  for (const [claim, payload, expected, text] of rows) {
    const result = await run(
      payload,
      claim.startsWith('another principal') ? 'someone-else' : 'local-owner',
    );
    assert.equal(result.outcome, expected.outcome, claim);
    if (expected.reason) assert.equal(result.reason, expected.reason, claim);
    if (text !== undefined) assert.equal(output(result), text, claim);
  }
  assert.equal(
    hashCanonical(controller.store.get<Task>('task', mine.id)),
    before,
    'no extension command changed the task, its revision or its limits',
  );
  assert.deepEqual(
    events.filter((event) => event.type !== 'extension.event').map((event) => event.type),
    [],
    'no extension command wrote a built-in event',
  );

  // A declared kind lands once, on the thread the command ran on.
  const key = context.id('cmd');
  const emitted = await run(
    { extensionId: 'probe', commandId: 'probed', taskId: mine.id },
    'local-owner',
    key,
  );
  assert.equal(emitted.outcome, 'applied');
  const own = events.filter((event) => event.type === 'extension.event');
  assert.equal(own.length, 1, 'a declared event kind is emitted once');
  assert.equal(own[0]?.taskId, mine.id, 'the event belongs to the thread the command ran on');
  assert.equal(
    (await run({ extensionId: 'probe', commandId: 'probed', taskId: mine.id }, 'local-owner', key))
      .outcome,
    'already-applied',
    'a retry with the same key answers from its receipt',
  );
  assert.equal(events.filter((event) => event.type === 'extension.event').length, 1);
  assert.equal(
    (await run({ extensionId: 'probe', commandId: 'look', taskId: mine.id }, 'local-owner', key))
      .reason,
    'idempotency-key-reused',
    'a reused key with changed content is refused',
  );
  assert.equal(
    (await run({ extensionId: 'probe', commandId: 'look', taskId: mine.id }, 'local-owner'))
      .outcome,
    'applied',
  );
  assert.equal(
    (
      await controller.execute(
        command('RunExtensionCommand', { extensionId: 'probe', commandId: 'look' }, 1),
        'local-owner',
      )
    ).outcome,
    'stale-revision',
    'a command without a thread needs revision zero',
  );

  // The choice is written after the commit, so a failed commit leaves the extension as it was.
  const save = controller.store.saveReceipt;
  controller.store.saveReceipt = () => {
    throw Error('receipt write failed');
  };
  await assert.rejects(
    controller.execute(
      command(
        'ConfigureExtension',
        { extensionId: 'blind', enabled: false, manifestHash: await hashOf('blind') },
        0,
      ),
      'local-owner',
    ),
  );
  controller.store.saveReceipt = save;
  assert.equal(
    (await read()).extensions.find((item) => item.folder === 'blind')?.state,
    'on',
    'a configure whose commit failed changes no choice',
  );
});

test('the sample thread action loads only while the sample extension is on and its contract matches', async (t) => {
  const { controller, command, draft, directory } = await setup(t);
  const home = join(directory, 'home');
  const task = (await controller.execute(draft, 'local-owner')).entity as Task;
  const folder = installSampleExtension(home);
  const read = async () =>
    (await controller.execute(command('ReadExtensions', {}), 'local-owner'))
      .data as ExtensionsRead & { kind: 'extensions' };
  const configure = async (enabled: boolean) =>
    controller.execute(
      command(
        'ConfigureExtension',
        {
          extensionId: sampleExtensionId,
          enabled,
          manifestHash:
            (await read()).extensions.find((item) => item.folder === sampleExtensionId)
              ?.manifestHash ?? 'f'.repeat(64),
        },
        0,
      ),
      'local-owner',
    );
  const turnOn = async (id: string) =>
    controller.execute(
      command(
        'ConfigureExtension',
        {
          extensionId: id,
          enabled: true,
          manifestHash:
            (await read()).extensions.find((item) => item.folder === id)?.manifestHash ??
            'f'.repeat(64),
        },
        0,
      ),
      'local-owner',
    );
  const stateOf = async (id: string) =>
    (await read()).extensions.find((item) => item.folder === id);
  const count = () =>
    controller.execute(
      command(
        'RunExtensionCommand',
        { extensionId: sampleExtensionId, commandId: 'count-messages', taskId: task.id },
        0,
      ),
      'local-owner',
    );
  const actions = async () =>
    (await read()).slots.filter((slot) => slot.slot === 'thread-action').map((slot) => slot.id);

  const listed = await read();
  assert.equal(listed.extensions[0]?.state, 'off', 'the sample is listed off');
  assert.equal(listed.extensions[0]?.manifest?.name, 'Thread stats', 'the manifest is shown');
  assert.deepEqual(await actions(), [], 'no thread action while off');
  assert.equal((await count()).reason, 'extension-off');

  assert.equal((await configure(true)).outcome, 'applied');
  assert.deepEqual(await actions(), ['count'], 'the thread action shows once on');
  const counted = await count();
  assert.equal(
    (counted.data as ExtensionCommandResult).output.text,
    'This thread has 0 recent messages.',
    'the action runs on its thread',
  );

  assert.equal((await configure(false)).outcome, 'applied');
  assert.deepEqual(await actions(), [], 'turning it off removes the action');
  assert.equal((await count()).reason, 'extension-off', 'and stops the command');

  assert.equal((await configure(true)).outcome, 'applied');
  // Consent covers every file in the folder: a sibling module or a package.json turns it off.
  for (const [name, body] of [
    ['helper.mjs', 'export const extra = 1;\n'],
    ['package.json', '{ "type": "commonjs" }\n'],
  ] as const) {
    writeFileSync(join(folder, name), body);
    assert.equal(
      (await stateOf(sampleExtensionId))?.state,
      'changed',
      `a new ${name} turns it off`,
    );
    assert.equal((await count()).reason, 'extension-off', `and stops the command after ${name}`);
    rmSync(join(folder, name));
    assert.equal((await stateOf(sampleExtensionId))?.state, 'on', `removing ${name} restores it`);
  }
  symlinkSync(join(folder, 'index.mjs'), join(folder, 'linked.mjs'));
  assert.equal(
    (await stateOf(sampleExtensionId))?.refusal,
    'folder-unsupported',
    'a link in the folder is refused',
  );
  rmSync(join(folder, 'linked.mjs'));
  const crowded = join(home, 'extensions', 'crowded');
  cpSync(folder, crowded, { recursive: true });
  const crowdedManifest = join(crowded, 'manifest.json');
  writeFileSync(
    crowdedManifest,
    JSON.stringify({ ...JSON.parse(readFileSync(crowdedManifest, 'utf8')), id: 'crowded' }),
  );
  for (let index = 0; index < 256; index += 1) writeFileSync(join(crowded, `f${index}.txt`), '');
  assert.equal(
    (await stateOf('crowded'))?.refusal,
    'folder-unsupported',
    'a folder over the bound is refused',
  );
  rmSync(crowded, { recursive: true });

  // A file that changes while the module loads refuses the load, and the run needs a restart.
  install(
    home,
    'shifty',
    {},
    `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./late.txt', import.meta.url), 'changed');
export const commands = { look: () => ({ text: 'shifty' }) };
`,
  );
  assert.equal(
    (await turnOn('shifty')).reason,
    'extension-changed-while-loading',
    'a folder that changed during the load stays off',
  );
  assert.equal((await stateOf('shifty'))?.state, 'off');
  assert.equal((await turnOn('shifty')).reason, 'extension-restart-needed');

  // A load failure is recorded, so a fixed module asks for a restart.
  install(home, 'broken', {}, `throw new Error('broken at load');\n`);
  assert.equal((await turnOn('broken')).reason, 'extension-load-failed');
  writeFileSync(
    join(home, 'extensions', 'broken', 'index.mjs'),
    `export const commands = { look: () => ({ text: 'fixed' }) };\n`,
  );
  assert.equal(
    (await turnOn('broken')).reason,
    'extension-restart-needed',
    'a module fixed after a failed load needs a restart',
  );

  const path = join(folder, 'manifest.json');
  writeFileSync(
    path,
    JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), contract: '2.0.0' }),
  );
  const bumped = await stateOf(sampleExtensionId);
  assert.equal(bumped?.state, 'refused', 'a contract major bump turns the extension off');
  assert.equal(bumped?.refusal, 'contract-major-mismatch');
  assert.match(bumped?.line ?? '', /^Built for extension contract 2\.x\./);
  assert.deepEqual(await actions(), [], 'and removes its action');
  assert.equal((await count()).reason, 'extension-not-found');
});
