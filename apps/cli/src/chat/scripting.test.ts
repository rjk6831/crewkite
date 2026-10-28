import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CliJsonLine, CliJsonLineSchema } from '@crewkite/contracts';
import { runCli } from '../main.ts';
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

test('print mode streams the reply to stdout and exits with the status of its turn', {
  timeout: 60_000,
}, async (t) => {
  const { home, repository } = await startScriptedController(t, [
    [{ kind: 'text', itemId: 'reply', chunks: ['The total ', 'is 2500.'] }],
    [{ kind: 'fail', stopReason: 'limit', failure }],
    [{ kind: 'wait' }],
  ]);
  const added = capture();
  assert.equal(await runCli(['project', 'add', repository, '--home', home], added.output), 0);

  const cases = [
    { name: 'done', stdout: 'The total is 2500.\n', stderr: /Thread tsk_/, code: 0 },
    { name: 'failed', stdout: '', stderr: /usage limit[\s\S]*another provider/, code: 1 },
  ];
  for (const row of cases) {
    const run = capture();
    const code = await runPrint(
      ['-p', `Check the ${row.name} total`, '--home', home],
      run.output,
      connectChat,
      repository,
    );
    assert.equal(code, row.code, `${row.name}: ${run.io.err}`);
    assert.equal(run.io.out, row.stdout, row.name);
    assert.match(run.io.err, row.stderr, row.name);
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
    ['-p', 'Wait for me', '--json', '--home', home],
    run.output,
    connectChat,
    repository,
  );
  const taskId = await started.promise;
  assert.equal(await runCli(['thread', 'stop', taskId, '--home', home], capture().output), 0);
  assert.equal(await printing, 3);
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
    ['thread', 'new', projectId, 'Clamp the discount', '--watch', '--json', '--home', home],
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
