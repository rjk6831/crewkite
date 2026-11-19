import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type ChatFamily,
  type ChatThread,
  ChatTurnSchema,
  type DesignSystem,
  type Project,
  WRITING_RULES,
} from '@crewkite/contracts';
import { writingRuleDigest } from '@crewkite/contracts/hash';
import { createDemoFixtures, createTestClock, createTestIds } from '@crewkite/testkit';
import { createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import { createSyntheticRepository } from '@crewkite/testkit/repository';
import { ArtifactFiles } from '../artifacts/index.ts';
import { designBrief, designBriefHash } from '../design/brief.ts';
import { DesignSystems } from '../design/service.ts';
import { RemoteEffects } from '../github/effects.ts';
import { Store } from '../store/index.ts';
import { fitWritingRules, MANDATORY_OBLIGATIONS, resolveWritingRules } from './prompt.ts';
import { ChatService } from './service.ts';

const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
const text = (id: string) => WRITING_RULES.find((rule) => rule.id === id)?.text ?? '';

const px = (value: number) => ({ value, unit: 'px' as const });
/** A small system of every kind of entry. Only the accent differs between versions. */
const designSystem = (accent: string): DesignSystem => ({
  schema: 1,
  tokens: {
    color: {
      text: { $type: 'color', $value: '#1f2328' },
      accent: { $type: 'color', $value: accent, $description: 'Links and primary buttons' },
    },
    type: { body: { $type: 'fontFamily', $value: ['Inter', 'sans-serif'] } },
    spacing: {
      md: { $type: 'dimension', $value: px(16) },
      sm: { $type: 'dimension', $value: px(8) },
    },
    radius: { md: { $type: 'dimension', $value: px(6) } },
    shadow: {
      card: {
        $type: 'shadow',
        $value: {
          color: 'rgb(0 0 0 / 0.1)',
          offsetX: px(0),
          offsetY: px(1),
          blur: px(3),
          spread: px(0),
        },
      },
    },
    motion: { fast: { $type: 'duration', $value: { value: 150, unit: 'ms' } } },
  },
  components: [
    {
      id: 'button',
      name: 'Button',
      do: ['One primary button per view.'],
      dont: ['Use color as the only signal.'],
      example: '<Button variant="primary">Save</Button>',
    },
  ],
  rules: [
    {
      id: 'labels',
      text: 'Labels use sentence case.',
      do: [],
      dont: [],
      example: 'Save changes\n\nDiscard draft',
    },
  ],
});
/** The brief's first line. Nothing else a turn receives contains it. */
const briefHead = designBrief(designSystem('#000')).split('\n')[0];
/** The brief inside a context: from its first line up to the next blank line. */
function briefIn(context: string): string {
  const at = context.indexOf(briefHead);
  if (at < 0) return '';
  const end = context.indexOf('\n\n', at);
  return context.slice(at, end < 0 ? undefined : end);
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** A thread in a real controller store with one scripted adapter per family. */
function harness(t: TestContext, switches: () => { ruleId: string; enabled: boolean }[]) {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-rules-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const clock = createTestClock();
  const ids = createTestIds(clock.now());
  const fixtures = createDemoFixtures(clock.now());
  const repository = createSyntheticRepository(join(directory, 'demo-shop'));
  const store = new Store(join(directory, 'state.sqlite'));
  t.after(() => store.close());
  store.applyMigrations(migrations);
  const project: Project = {
    id: fixtures.task.projectId,
    name: 'demo-shop',
    revision: 0,
  };
  store.transaction(() => {
    store.put('project', project.id, 0, project);
    store.put('task', fixtures.task.id, 0, fixtures.task);
  });
  const reply = [{ kind: 'text' as const, itemId: 'reply', chunks: ['Done.'] }];
  const families: ChatFamily[] = ['openai', 'anthropic', 'google', 'local'];
  const adapters = new Map(
    families.map((family) => [
      family,
      createScriptedChatAdapter({
        family,
        turns: Array.from({ length: 8 }, () => reply),
      }),
    ]),
  );
  const service = new ChatService({
    store,
    artifacts: new ArtifactFiles(join(directory, 'artifacts')),
    home: directory,
    googleTermsAcknowledged: () => true,
    now: clock.now,
    id: (prefix) => (prefix === 'trn' ? `trn_${ids('msg').slice(4)}` : ids(prefix)),
    emit: (type, taskId, revision, payload) =>
      store.append({
        protocol: 1,
        id: ids('evt'),
        at: clock.now(),
        taskId,
        revision,
        type,
        payload,
      }),
    adapters,
    resolveEnvironment: () => ({}),
    projectPath: () => repository.directory,
    writingRules: switches,
    resolveSelection: (_taskId, value) => value ?? null,
    catalog: () => ({ families: [] }),
    remoteEffects: new RemoteEffects({
      store,
      home: directory,
      now: clock.now,
      id: () => ids('rfx'),
      projectPath: () => repository.directory,
    }),
  });
  const run = async (
    start: (effects: (() => void)[]) => void,
    settledEvent: (event: { type: string; payload: unknown }) => boolean,
  ) => {
    const done = new Promise<void>((resolve) => {
      const stop = store.subscribe((event) => {
        if (!settledEvent(event)) return;
        stop();
        resolve();
      });
    });
    const effects: (() => void)[] = [];
    store.transaction(() => start(effects));
    for (const effect of effects) effect();
    await done;
  };
  const idle = (event: { type: string; payload: unknown }) => {
    if (event.type !== 'chat.thread') return false;
    const thread = event.payload as ChatThread;
    return thread.activeTurnId === null && thread.queued.length === 0;
  };
  // A side question never holds the thread, so its own turn ending is the signal.
  const answered = (event: { type: string; payload: unknown }) =>
    event.type === 'chat.turn' && (event.payload as { state: string }).state === 'done';
  const send = (
    family: ChatFamily,
    message: string,
    role: 'assistant' | 'reviewer' = 'assistant',
  ) =>
    run(
      (effects) =>
        service.sendMessage(
          {
            taskId: fixtures.task.id,
            text: message,
            role,
            attachments: [],
            files: [],
            selection: { family, model: `${family}-model`, effort: 'default' },
          },
          effects,
        ),
      idle,
    );
  const ask = (family: ChatFamily, question: string) =>
    run(
      (effects) =>
        service.ask(
          {
            taskId: fixtures.task.id,
            family,
            model: `${family}-model`,
            question,
          },
          effects,
        ),
      answered,
    );
  const turns = () =>
    store.db
      .prepare('SELECT body FROM chat_turns ORDER BY sequence')
      .all()
      .map((row) => ChatTurnSchema.parse(JSON.parse(row.body as string)));
  const design = new DesignSystems({
    store,
    now: clock.now,
    projectPath: () => repository.directory,
  });
  // The controller runs every command in one store transaction. So do these calls.
  const saveDesign = (body: DesignSystem) => {
    const saved = store.transaction(() =>
      design.save({
        projectId: project.id,
        path: 'design-system.json',
        body,
        expectedVersion: store.designSystem(project.id)?.version ?? 0,
        confirm: 'explicit',
      }),
    );
    assert.ok('record' in saved);
    return saved.record;
  };
  const deliver = (enabled: boolean) =>
    store.transaction(() => design.setDelivery(project.id, enabled));
  return { send, ask, adapters, turns, saveDesign, deliver, folder: repository.directory };
}

test('a resumed Anthropic or Google writing turn carries the enabled rules and an ask turn carries none', {
  timeout: 60_000,
}, async (t) => {
  const { send, ask, adapters } = harness(t, () => []);
  for (const family of ['anthropic', 'google'] as const) {
    await send(family, `First on ${family}.`);
    await send(family, `Second on ${family}.`);
    await ask(family, `Question on ${family}.`);
    const [first, second, asked] = adapters.get(family)?.requests ?? [];
    assert.ok(first.systemContext.includes(text('ladder')), `${family} first context`);
    assert.notEqual(second.session, null, `${family} resumes`);
    assert.ok(second.prompt.includes(text('ladder')), `${family} per-turn block`);
    assert.ok(second.prompt.includes(MANDATORY_OBLIGATIONS), `${family} obligations`);
    assert.equal(second.prompt.includes(text('survey-delegation')), false, `${family} default off`);
    for (const rule of WRITING_RULES) {
      assert.equal(asked.systemContext.includes(rule.text), false, `${family} ask context`);
      assert.equal(asked.prompt.includes(rule.text), false, `${family} ask prompt`);
    }
  }
});

test('a rule switched off starts a new session and its text is gone from what is sent', {
  timeout: 60_000,
}, async (t) => {
  let rows: { ruleId: string; enabled: boolean }[] = [];
  const { send, adapters } = harness(t, () => rows);
  for (const family of ['anthropic', 'google', 'openai'] as const) {
    rows = [];
    await send(family, `First on ${family}.`);
    await send(family, `Second on ${family}.`);
    rows = [{ ruleId: 'testing', enabled: false }];
    await send(family, `Third on ${family}.`);
    await send(family, `Fourth on ${family}.`);
    const [, second, third, fourth] = adapters.get(family)?.requests ?? [];
    if (family !== 'openai') assert.ok(second.prompt.includes(text('testing')));
    assert.notEqual(second.session, null, `${family} resumed before the change`);
    assert.equal(third.session, null, `${family} starts a new session`);
    assert.ok(third.systemContext.includes(text('ladder')), `${family} keeps the others`);
    assert.ok(third.systemContext.includes(MANDATORY_OBLIGATIONS), `${family} keeps obligations`);
    for (const request of [third, fourth])
      assert.equal(
        `${request.systemContext}\n${request.prompt}`.includes(text('testing')),
        false,
        `${family} drops the rule`,
      );
    assert.notEqual(fourth.session, null, `${family} resumes on the new set`);
  }
});

test('a writing turn records the digest of the enabled settings rules and never an export-only rule', {
  timeout: 60_000,
}, async (t) => {
  const { send, adapters, turns } = harness(t, () => [
    { ruleId: 'session-switch', enabled: true },
    { ruleId: 'bounded-output', enabled: false },
    { ruleId: 'survey-delegation', enabled: true },
  ]);
  await send('anthropic', 'Write it.');
  const enabled = WRITING_RULES.filter(
    (rule) =>
      rule.surface === 'settings' &&
      (rule.id === 'survey-delegation' || (rule.defaultEnabled && rule.id !== 'bounded-output')),
  ).map((rule) => rule.id);
  const [turn] = turns();
  assert.deepEqual(turn.rules?.enabled, enabled);
  assert.equal(turn.rules?.digest, writingRuleDigest(enabled));
  const sent = adapters.get('anthropic')?.requests[0].systemContext ?? '';
  assert.equal(sent.includes(text('session-switch')), false);
  assert.ok(sent.includes(text('survey-delegation')));
});

test('rules that leave no room under the context limit refuse the turn with a plain line', () => {
  const { section } = resolveWritingRules([]);
  const bytes = Buffer.byteLength(section);
  assert.doesNotThrow(() => fitWritingRules(section, [], bytes));
  assert.throws(() => fitWritingRules(section, [], bytes - 1), /do not fit the 64 KiB/);
});

test('a writing turn on each family receives the same design brief from the saved version and records it', {
  timeout: 60_000,
}, async (t) => {
  const { send, ask, adapters, turns, saveDesign, folder } = harness(t, () => []);
  const saved = designSystem('#2f6feb');
  const record = saveDesign(saved);
  // An edit on disk is not a version, so turns keep receiving the saved one.
  writeFileSync(join(folder, 'design-system.json'), JSON.stringify(designSystem('#ff0000')));
  const families: ChatFamily[] = ['openai', 'anthropic', 'google', 'local'];
  for (const family of families) await send(family, `Write it on ${family}.`);
  await ask('google', 'What does the accent color do?');
  assert.deepEqual(
    families.map((family) =>
      sha256(briefIn(adapters.get(family)?.requests[0].systemContext ?? '')),
    ),
    families.map(() => designBriefHash(saved)),
  );
  const slot = {
    version: record.version,
    versionHash: record.versionHash,
    briefBytes: Buffer.byteLength(designBrief(saved)),
  };
  assert.deepEqual(
    turns().map((turn) => [turn.role, turn.designSystem]),
    [...families.map(() => ['assistant', slot]), ['ask', null]],
  );
  const asked = adapters.get('google')?.requests[1];
  assert.equal(`${asked?.systemContext}\n${asked?.prompt}`.includes(briefHead), false);
});

test('with no design system or with its delivery off, a writing turn receives no brief and records none', {
  timeout: 60_000,
}, async (t) => {
  const { send, adapters, turns, saveDesign, deliver } = harness(t, () => []);
  await send('local', 'Before any design system.');
  saveDesign(designSystem('#2f6feb'));
  deliver(false);
  await send('local', 'With delivery off.');
  const requests = adapters.get('local')?.requests ?? [];
  assert.equal(requests.length, 2);
  for (const request of requests)
    assert.equal(`${request.systemContext}\n${request.prompt}`.includes(briefHead), false);
  assert.deepEqual(
    turns().map((turn) => turn.designSystem),
    [null, null],
  );
});

test('a new saved version or a delivery switch starts a new session on the next writing turn', {
  timeout: 60_000,
}, async (t) => {
  const { send, adapters, turns, saveDesign, deliver } = harness(t, () => []);
  const accents = ['#110000', '#220000', '#330000', '#440000', '#550000', '#660000'];
  let current = designSystem(accents[0]);
  saveDesign(current);
  for (const [index, family] of (['anthropic', 'google', 'openai'] as const).entries()) {
    deliver(true);
    await send(family, `First on ${family}.`);
    await send(family, `Second on ${family}.`);
    const old = designBrief(current);
    current = designSystem(accents[index + 1]);
    const record = saveDesign(current);
    await send(family, `Third on ${family}.`);
    await send(family, `Fourth on ${family}.`);
    deliver(false);
    await send(family, `Fifth on ${family}.`);
    const [, second, third, fourth, fifth] = adapters.get(family)?.requests ?? [];
    assert.notEqual(second.session, null, `${family} resumed before the change`);
    assert.equal(third.session, null, `${family} starts a new session on a new version`);
    assert.equal(
      briefIn(third.systemContext),
      designBrief(current),
      `${family} gets the new brief`,
    );
    for (const request of [third, fourth])
      assert.equal(
        `${request.systemContext}\n${request.prompt}`.includes(old),
        false,
        `${family} drops the old brief`,
      );
    assert.notEqual(fourth.session, null, `${family} resumes on the new version`);
    assert.deepEqual(turns().at(-2)?.designSystem, {
      version: record.version,
      versionHash: record.versionHash,
      briefBytes: Buffer.byteLength(designBrief(current)),
    });
    assert.equal(fifth.session, null, `${family} starts a new session with delivery off`);
    assert.equal(`${fifth.systemContext}\n${fifth.prompt}`.includes(briefHead), false);
  }
});

test('a resumed Anthropic or Google writing turn carries the design brief and records its size, and a resumed OpenAI turn does not repeat it', {
  timeout: 60_000,
}, async (t) => {
  const { send, adapters, turns, saveDesign } = harness(t, () => []);
  const saved = designSystem('#2f6feb');
  // A font name outside ASCII makes the brief's bytes differ from its length in characters.
  saved.tokens.type.body = { $type: 'fontFamily', $value: ['Söhne', 'sans-serif'] };
  saveDesign(saved);
  const brief = designBrief(saved);
  const bytes = Buffer.byteLength(brief);
  const families = [
    { family: 'anthropic', repeats: true },
    { family: 'google', repeats: true },
    { family: 'openai', repeats: false },
  ] as const;
  for (const { family, repeats } of families) {
    await send(family, `First on ${family}.`);
    await send(family, `Second on ${family}.`);
    await send(family, `Review on ${family}.`, 'reviewer');
    const [first, second, review] = adapters.get(family)?.requests ?? [];
    assert.equal(briefIn(first.systemContext), brief, `${family} new session`);
    assert.equal(first.prompt.includes(briefHead), false, `${family} new session message`);
    assert.notEqual(second.session, null, `${family} resumes`);
    assert.equal(briefIn(second.prompt), repeats ? brief : '', `${family} resumed message`);
    assert.equal(`${review.systemContext}\n${review.prompt}`.includes(briefHead), false);
    assert.deepEqual(
      turns()
        .filter((turn) => turn.selection.family === family)
        .map((turn) => [turn.role, turn.designSystem?.briefBytes]),
      [
        ['assistant', bytes],
        ['assistant', bytes],
        ['reviewer', undefined],
      ],
      `${family} records the size`,
    );
  }
});
