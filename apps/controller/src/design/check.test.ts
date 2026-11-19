import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type {
  ChatThreadRead,
  ChatTurn,
  CommandResult,
  DesignFinding,
  DesignSystem,
  Event,
  Task,
} from '@crewkite/contracts';
import { type ChatScriptStep, createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import type { Controller } from '../commands/controller.ts';
import { git } from '../host/source.ts';
import { setup } from '../store/controller-fixture.ts';

const selection = { family: 'openai', model: 'fixture-model', effort: 'default' } as const;
const px = (value: number) => ({
  $type: 'dimension' as const,
  $value: { value, unit: 'px' as const },
});
const system: DesignSystem = {
  schema: 1,
  tokens: {
    color: { accent: { $type: 'color', $value: '#2f6feb' } },
    type: { ui: { $type: 'fontFamily', $value: ['Inter', 'sans-serif'] } },
    spacing: { '2': px(4), '4': px(8), '6': px(12) },
    radius: { '2': px(4) },
    shadow: {},
    motion: {},
  },
  components: [],
  rules: [],
};
const reply = (text: string): ChatScriptStep[] => [{ kind: 'text', itemId: 'r', chunks: [text] }];
const listOf = (result: CommandResult) => {
  assert(result.data?.kind === 'design-findings', result.next);
  return result.data.findings;
};

function next(controller: Pick<Controller, 'store'>, match: (event: Event) => boolean) {
  return new Promise<Event>((resolve) => {
    const stop = controller.store.subscribe((event) => {
      if (!match(event)) return;
      stop();
      resolve(event);
    });
  });
}

/**
 * A project whose base commit holds src/base.css with a raw color, a saved design system, and a
 * thread after one turn. Tests then write the scratch copy the way a provider edit would.
 */
async function project(t: TestContext, turns: ChatScriptStep[][]) {
  const adapter = createScriptedChatAdapter({ family: 'openai', turns });
  const context = await setup(t, {
    chatAdapters: new Map([['openai', adapter]]),
    identity: { name: 'Fixture owner', email: 'owner@example.invalid' },
  });
  const { controller, command, source, draft } = context;
  mkdirSync(join(source.directory, 'src'));
  writeFileSync(
    join(source.directory, 'src/base.css'),
    '.page {\n  color: #ff0000;\n  gap: var(--gap);\n}\n',
  );
  git(source.directory, ['add', '--', 'src/base.css']);
  git(source.directory, ['commit', '-qm', 'fixture'], undefined, {
    name: 'Fixture',
    email: 'fixture@example.invalid',
    at: '2026-10-15T18:00:00Z',
  });
  const { projectId } = draft.payload as { projectId: string };
  const task = (await controller.execute(draft, 'local-owner')).entity as Task;
  const run = (name: string, payload: object) =>
    controller.execute(command(name, payload, task.revision), 'local-owner');
  const read = (name: string, payload: object) =>
    controller.execute(command(name, payload), 'local-owner');
  const save = (body: DesignSystem, expectedVersion: number) =>
    controller.execute(
      command(
        'SaveDesignSystem',
        { projectId, path: 'design-system.json', body, expectedVersion, confirm: 'explicit' },
        0,
      ),
      'local-owner',
    );
  assert.equal((await save(system, 0)).outcome, 'applied');
  const done = next(
    controller,
    (event) => event.type === 'chat.turn' && (event.payload as ChatTurn).state === 'done',
  );
  await run('SendChatMessage', { taskId: task.id, text: 'Style the card.', selection });
  await done;
  const scratch = adapter.requests[0]?.scratch.directory as string;
  const write = (text: string) => writeFileSync(join(scratch, 'src/card.css'), text);
  const check = async () => listOf(await run('RunDesignCheck', { taskId: task.id }));
  const by = (findings: DesignFinding[], found: string) =>
    findings.find((finding) => finding.found === found)?.id as string;
  return { controller, adapter, task, run, read, save, write, check, by };
}

test('the design check reports values in changed files with file, line, rule and nearest token, and fails on a changed file it cannot read', {
  timeout: 30000,
}, async (t) => {
  const { controller, task, read, write, check } = await project(t, [reply('Built the card.')]);
  // The changed file declares an alias that only the unchanged base file reads with a spacing
  // property, so the alias is caught only when the whole copy goes to the scanner.
  const card = ':root {\n  --gap: 13px;\n}\n.card {\n  padding: 10px;\n  color: #2f6fea;\n}\n';
  write(card);

  const findings = await check();
  assert.deepEqual(
    findings.map(({ file, line, rule, found, nearestToken, state }) => ({
      file,
      line,
      rule,
      found,
      nearestToken,
      state,
    })),
    [
      {
        file: 'src/card.css',
        line: 2,
        rule: 'off-scale-spacing',
        found: '13px',
        nearestToken: 'spacing.6',
        state: 'open',
      },
      {
        file: 'src/card.css',
        line: 5,
        rule: 'off-scale-spacing',
        found: '10px',
        nearestToken: 'spacing.6',
        state: 'open',
      },
      {
        file: 'src/card.css',
        line: 6,
        rule: 'raw-color',
        found: '#2f6fea',
        nearestToken: 'color.accent',
        state: 'open',
      },
    ],
  );
  const listed = await read('ReadDesignFindings', { taskId: task.id });
  assert.deepEqual(listOf(listed), findings);
  assert.equal(
    listed.data?.kind === 'design-findings' && listed.data.versionHash,
    controller.store.designSystem(task.projectId)?.versionHash,
  );

  // Past 1 MiB the file is not read, and past 64 nested levels the scanner skips it. Either way its
  // findings stay as they were, the run cannot pass, and the run names the file.
  write(`${card}/*${'x'.repeat(1024 * 1024)}*/\n`);
  assert.deepEqual(await check(), findings);
  write(`${card}.deep {\n  padding: ${'calc('.repeat(65)}1px${')'.repeat(65)};\n}\n`);
  assert.deepEqual(await check(), findings);
  const thread = (await read('ReadChatThread', { taskId: task.id })).data as ChatThreadRead;
  const unread = {
    label: 'Design system',
    trigger: 'manual',
    status: 'failed',
    reason:
      '3 values go around the design system. 1 changed file was too large or unreadable and not checked.',
    named: ['Not checked: src/card.css'],
  };
  assert.deepEqual(
    thread.thread.checks?.runs.map(({ label, trigger, status, reason, tail }) => ({
      label,
      trigger,
      status,
      reason,
      named: tail.match(/^Not checked: .*$/gm),
    })),
    [
      {
        label: 'Design system',
        trigger: 'manual',
        status: 'failed',
        reason: '3 values go around the design system.',
        named: null,
      },
      unread,
      unread,
    ],
  );
  // The thread never read its project checks, so the first run read them for the list beside it.
  assert.notEqual(thread.thread.checks?.detectedAt ?? null, null);
});

test('allow once covers only the value it was given for, and findings sent to the fixer ride on one fixer turn', {
  timeout: 30000,
}, async (t) => {
  // The fixer folds both rules into one: the padding is fixed, and one of the two blues is gone.
  const fixed = '.note {\n  padding: var(--space-6);\n  margin: 13px;\n  color: #2f6fea;\n}\n';
  const { controller, adapter, task, run, read, write, check, by } = await project(t, [
    reply('Built the card.'),
    reply('Tightened the card.'),
    [
      {
        kind: 'tool',
        callId: 'w',
        toolKind: 'edit',
        title: 'Write src/card.css',
        write: { path: 'src/card.css', content: fixed },
      },
      ...reply('Fixed the padding.'),
    ],
    reply('The margin stays for now.'),
    reply('Clean.\nFindings: 0'),
  ]);
  write(
    '.card {\n  padding: 10px;\n  margin: 13px;\n  color: #2f6fea;\n}\n.note {\n  color: #2f6fea;\n}\n',
  );
  const findings = await check();
  const resolve = (found: string, action: string, reason?: string) =>
    run('ResolveDesignFinding', {
      findingId: by(findings, found),
      action,
      ...(reason ? { reason } : {}),
    });

  assert.equal((await resolve('#2f6fea', 'allow-once')).reason, 'invalid-command');
  const allowed = await resolve('#2f6fea', 'allow-once', 'The client keeps this blue.');
  assert.deepEqual(
    listOf(allowed).map(({ found, state, reason }) => ({ found, state, reason })),
    [
      { found: '10px', state: 'open', reason: null },
      { found: '13px', state: 'open', reason: null },
      { found: '#2f6fea', state: 'allowed', reason: 'The client keeps this blue.' },
      { found: '#2f6fea', state: 'open', reason: null },
    ],
  );
  for (const found of ['10px', '13px', '10px'])
    assert.equal((await resolve(found, 'send-to-fixer')).outcome, 'applied');

  const finished = next(
    controller,
    (event) =>
      event.type === 'conversation.entry' &&
      /^Crew (finished|stopped)/.test((event.payload as { text: string }).text),
  );
  await run('ConfigureChatThread', {
    taskId: task.id,
    crew: {
      name: 'Pair',
      members: [
        { role: 'builder', selection },
        { role: 'reviewer', selection },
      ],
    },
    flightMode: 'glide',
  });
  await run('SendChatMessage', { taskId: task.id, text: 'Tighten the card.', selection });
  // The gate after each write fails on the values left, and the second fix is the last.
  assert.equal(
    ((await finished).payload as { text: string }).text,
    'Crew finished: 1 review round, 2 fixes.',
  );
  const fixers = adapter.requests.filter((request) => request.role === 'fixer');
  const listed = (index: number) => fixers[index]?.prompt.match(/^- src\/card\.css:.*$/gm);
  assert.equal(fixers.length, 2);
  // The gate after the builder sends the open blue on with the two the person sent, and leaves
  // the allowed blue alone. Each rides on the one fixer turn once.
  assert.deepEqual(listed(0), [
    '- src/card.css:2: spacing off the scale 10px. Use spacing.6.',
    '- src/card.css:3: spacing off the scale 13px. Use spacing.6.',
    '- src/card.css:7: raw color #2f6fea. Use color.accent.',
  ]);
  // The fix leaves one blue, on the allowed line, and the check cannot tell which one went. So the
  // allowance resolves, and the blue left goes to the fixer again with the margin.
  assert.deepEqual(listed(1), [
    '- src/card.css:3: spacing off the scale 13px. Use spacing.6.',
    '- src/card.css:4: raw color #2f6fea. Use color.accent.',
  ]);
  assert.deepEqual(
    listOf(await read('ReadDesignFindings', { taskId: task.id })).map(
      ({ found, line, state, reason }) => ({ found, line, state, reason }),
    ),
    [
      { found: '13px', line: 3, state: 'sent', reason: null },
      { found: '#2f6fea', line: 4, state: 'sent', reason: null },
    ],
  );
});

test('saving a version that newly holds a found value marks that finding updated', {
  timeout: 30000,
}, async (t) => {
  const { controller, task, run, read, save, write, check, by } = await project(t, [
    reply('Built the card.'),
  ]);
  write(
    '.card {\n  color: #123456;\n  border-color: rgb(18 52 86);\n  border-radius: 6px;\n  background: #2f6feb;\n}\n',
  );
  const findings = await check();
  const checked = controller.store.designSystem(task.projectId)?.versionHash;
  const drafted = await run('ResolveDesignFinding', {
    findingId: by(findings, '#123456'),
    action: 'update-system',
  });
  assert.match(
    listOf(drafted).find((finding) => finding.found === '#123456')?.reason ?? '',
    /^Draft open\./,
  );

  const brand = { $type: 'color', $value: '#123456' } as const;
  const tokens = { ...system.tokens, color: { ...system.tokens.color, brand } };
  assert.equal((await save({ ...system, tokens }, 1)).outcome, 'applied');
  const listed = await read('ReadDesignFindings', { taskId: task.id });
  // The literal equal to a token that version 1 already held stays open: its fix is to use it.
  assert.deepEqual(
    listOf(listed).map(({ found, state, reason, versionHash }) => ({
      found,
      state,
      reason,
      versionHash,
    })),
    [
      {
        found: '#123456',
        state: 'updated',
        reason: 'Version 2 holds this value as color.brand.',
        versionHash: checked,
      },
      {
        found: 'rgb(18 52 86)',
        state: 'updated',
        reason: 'Version 2 holds this value as color.brand.',
        versionHash: checked,
      },
      { found: '6px', state: 'open', reason: null, versionHash: checked },
      { found: '#2f6feb', state: 'open', reason: null, versionHash: checked },
    ],
  );
  assert.equal(listed.data?.kind === 'design-findings' && listed.data.versionHash, checked);
});
