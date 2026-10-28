import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLI_JSON_LINE_SHAPE, type CliJsonLine, CliJsonLineSchema } from '@crewkite/contracts';
import { cliJsonLineShape } from '../../../../packages/contracts/src/cli-shape.ts';
import { createSyntheticRepository } from '../../../../packages/testkit/src/repository.ts';
import { printRequested, runCli } from '../main.ts';
import { startScriptedController } from '../scripted-controller.ts';
import { connectChat } from './connect.ts';
import { runPrint } from './scripting.ts';

const failure = {
  stage: 'stream' as const,
  kind: 'usage-limit' as const,
  message: 'The provider reached its usage limit.',
  providerMessage: null,
  method: null,
  code: null,
  resetsAt: null,
  nextAction: 'Continue on another provider.',
};

function capture(onOut: (text: string) => void = () => {}) {
  const io = { out: '', err: '' };
  return {
    io,
    output: {
      out: (text: string) => {
        io.out += text;
        onOut(text);
      },
      err: (text: string) => {
        io.err += text;
      },
    },
  };
}

test('print mode streams the reply, uses only a registered checkout and exits with its status', {
  timeout: 60_000,
}, async (t) => {
  const { home, repository, directory, stop } = await startScriptedController(t, [
    [{ kind: 'text', itemId: 'reply', chunks: ['The total ', 'is 2500.'] }],
    [{ kind: 'fail', stopReason: 'limit', failure }],
    [{ kind: 'wait' }],
    [{ kind: 'text', itemId: 'reply', chunks: ['Registered.'] }],
    [{ kind: 'wait' }],
  ]);
  const added = capture();
  assert.equal(await runCli(['project', 'add', repository, '--home', home], added.output), 0);
  // A permission policy in cli.json is never applied by itself.
  writeFileSync(join(home, 'cli.json'), JSON.stringify({ permissionPolicy: 'allow-all' }));
  const model = ['--model', 'anthropic/fixture-model', '--home', home];
  const plainEnv = { ...process.env, INIT_CWD: '' };
  // pnpm runs from the package root and names the caller's directory in INIT_CWD. A GIT_DIR from
  // the caller must not move the checkout.
  const env = { ...process.env, INIT_CWD: repository, GIT_DIR: tmpdir(), GIT_WORK_TREE: tmpdir() };
  const elsewhere = mkdtempSync(join(tmpdir(), 'crewkite-cwd-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));

  const cases = [
    {
      name: 'done',
      args: [] as string[],
      stdout: 'The total is 2500.\n',
      stderr: /Thread tsk_[\s\S]*Permission policy: ask/,
      code: 0,
      policy: 'ask',
    },
    {
      name: 'failed',
      args: ['--permission-policy', 'allow-edits'],
      stdout: '',
      stderr: /Permission policy: allow-edits[\s\S]*usage limit[\s\S]*another provider/,
      code: 1,
      policy: 'allow-edits',
    },
  ];
  for (const row of cases) {
    const run = capture();
    const code = await runPrint(
      ['-p', `Check the ${row.name} total`, ...row.args, ...model],
      run.output,
      connectChat,
      elsewhere,
      env,
    );
    assert.equal(code, row.code, `${row.name}: ${run.io.err}`);
    assert.equal(run.io.out, row.stdout, row.name);
    assert.match(run.io.err, row.stderr, row.name);
    const taskId = /Thread (tsk_\w+)/.exec(run.io.err)?.[1] ?? '';
    const client = await connectChat(home);
    assert.equal((await client.readThread(taskId)).thread.permissionPolicy, row.policy);
    client.transport.close();
  }

  // Stop from another command while the reply waits. The print run exits with the stopped code.
  const started = Promise.withResolvers<string>();
  const run = capture((text) => {
    for (const line of text.split('\n').filter(Boolean)) {
      const parsed = CliJsonLineSchema.parse(JSON.parse(line));
      if (parsed.kind === 'event' && parsed.event.type === 'agent.event')
        if (parsed.event.payload.type === 'turn.started') started.resolve(parsed.taskId);
    }
  });
  const printing = runPrint(
    ['-p', 'Wait for me', '--json', ...model],
    run.output,
    connectChat,
    repository,
    plainEnv,
  );
  const taskId = await started.promise;
  assert.equal(await runCli(['thread', 'stop', taskId, '--home', home], capture().output), 0);
  assert.equal(await printing, 3);

  // A checkout the controller does not hold is refused without registering it, and the refusal
  // names the flag that registers it. Arguments that do not parse are a usage error too.
  const other = createSyntheticRepository(join(directory, 'other')).directory;
  const refused = capture();
  assert.equal(
    await runPrint(['-p', 'Hello', ...model], refused.output, connectChat, other, plainEnv),
    2,
  );
  assert.match(refused.io.err, /not a registered project. Pass --register/);
  const client = await connectChat(home);
  assert.deepEqual(
    (await client.listProjects()).map((project) => project.name),
    ['shop'],
  );
  client.transport.close();
  const registered = capture();
  assert.equal(
    await runPrint(
      ['-p', 'Hello', '--register', ...model],
      registered.output,
      connectChat,
      other,
      plainEnv,
    ),
    0,
  );
  assert.match(registered.io.err, /Registered .*other as project/);
  for (const args of [
    ['-p', 'Hello', '--bogus', ...model],
    ['-p', 'Hello', '--permission-policy', 'always', ...model],
    ['thread', 'list', '--bogus'],
    ['task', 'list', '--bogus'],
  ])
    assert.equal(await runCli(args, capture().output), 2, args.join(' '));
  assert.equal(printRequested(['task', 'show', 'tsk_x', '-p']), false);
  assert.equal(printRequested(['--home', 'h', '-p', 'Hello']), true);

  // The controller goes away mid-reply. Print mode settles with a plain line and status 1.
  const lostStarted = Promise.withResolvers<void>();
  const lost = capture((text) => {
    if (text.includes('"turn.started"')) lostStarted.resolve();
  });
  const losing = runPrint(
    ['-p', 'Wait again', '--json', ...model],
    lost.output,
    (path) => connectChat(path, { reconnectDelaysMs: [] }),
    repository,
    plainEnv,
  );
  await lostStarted.promise;
  await stop();
  assert.equal(await losing, 1);
  assert.match(lost.io.out, /connection to the controller ended/);
});

test('thread commands with --json write only lines the published schema accepts', {
  timeout: 60_000,
}, async (t) => {
  const { home, repository } = await startScriptedController(t, [
    [
      { kind: 'tool', callId: 'read-1', toolKind: 'read', title: 'Read net.mjs' },
      { kind: 'permission', requestId: 'edit-1', question: 'Edit net.mjs?' },
      {
        kind: 'tool',
        callId: 'edit-1',
        toolKind: 'edit',
        title: 'Edit net.mjs',
        write: { path: 'net.mjs', content: 'export const net = 1;\n' },
      },
      { kind: 'text', itemId: 'reply', chunks: ['Edited.'] },
    ],
  ]);
  const projectRun = capture();
  assert.equal(
    await runCli(['project', 'add', repository, '--json', '--home', home], projectRun.output),
    0,
  );
  const projectId = JSON.parse(projectRun.io.out).result?.entity?.id;
  assert.ok(projectId, projectRun.io.out);

  // `v` names one fixed shape: a change to any line or embedded chat shape moves this hash.
  assert.equal(cliJsonLineShape(), CLI_JSON_LINE_SHAPE);
  const lines: CliJsonLine[] = [];
  const asked = Promise.withResolvers<{ taskId: string; requestId: string }>();
  const parse = (text: string) => {
    for (const line of text.split('\n').filter(Boolean)) {
      const parsed = CliJsonLineSchema.parse(JSON.parse(line));
      lines.push(parsed);
      if (
        parsed.kind === 'event' &&
        parsed.event.type === 'agent.event' &&
        parsed.event.payload.type === 'permission.requested'
      )
        asked.resolve({ taskId: parsed.taskId, requestId: parsed.event.payload.requestId });
    }
  };
  const watching = runCli(
    [
      'thread',
      'new',
      projectId,
      'Clamp the discount',
      '--model',
      'anthropic/fixture-model',
      '--watch',
      '--json',
      '--home',
      home,
    ],
    capture(parse).output,
  );
  const { taskId, requestId } = await asked.promise;
  const permit = capture(parse);
  assert.equal(
    await runCli(['thread', 'permit', taskId, requestId, '--json', '--home', home], permit.output),
    0,
  );
  assert.equal(await watching, 0);
  const end = lines.findLast((line) => line.kind === 'turn-end');
  assert.equal(end?.kind === 'turn-end' && end.status, 'done');
  assert.ok(
    lines.some((line) => line.kind === 'result' && line.command === 'ResolveChatPermission'),
  );

  for (const args of [['list'], ['show', taskId]]) {
    const run = capture(parse);
    assert.equal(await runCli(['thread', ...args, '--json', '--home', home], run.output), 0);
  }
  assert.ok(
    lines.some(
      (line) => line.kind === 'threads' && line.threads.some((row) => row.taskId === taskId),
    ),
  );
  assert.ok(lines.some((line) => line.kind === 'thread' && line.read.thread.taskId === taskId));

  // Accept makes a local branch. Push without --confirm sends nothing and says what it would do.
  const accept = capture(parse);
  assert.equal(
    await runCli(
      ['thread', 'accept', taskId, 'cli/clamp-discount', '--json', '--home', home],
      accept.output,
    ),
    0,
  );
  const push = capture(parse);
  assert.equal(await runCli(['thread', 'push', taskId, '--json', '--home', home], push.output), 2);
  const last = lines.at(-1);
  assert.match(
    last?.kind === 'error' ? last.message : '',
    /cli\/clamp-discount to origin[\s\S]*--confirm/,
  );
});
