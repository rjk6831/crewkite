import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatAnalyticsReadSchema } from '@crewkite/contracts';
import { runCli } from '../main.ts';
import { startScriptedController } from '../scripted-controller.ts';
import { connectChat } from './connect.ts';
import { runPrint } from './scripting.ts';

// Claim: `crewkite usage thread` and `usage project` show what the controller derived for a real
// thread, write the same read as a new CSV file and never replace an existing file.
test('usage thread and project read the controller and save a new csv', {
  timeout: 60_000,
}, async (t) => {
  const { home, repository, directory } = await startScriptedController(t, [
    [{ kind: 'text', itemId: 'reply', chunks: ['Done.'] }],
  ]);
  const capture = () => {
    const io = { out: '', err: '' };
    return {
      io,
      output: {
        out: (text: string) => {
          io.out += text;
        },
        err: (text: string) => {
          io.err += text;
        },
      },
    };
  };
  const added = capture();
  assert.equal(
    await runCli(['project', 'add', repository, '--json', '--home', home], added.output),
    0,
  );
  const projectId = JSON.parse(added.io.out).result?.entity?.id as string;
  const printed = capture();
  assert.equal(
    await runPrint(
      ['-p', 'Say done', '--model', 'anthropic/fixture-model', '--home', home],
      printed.output,
      connectChat,
      repository,
      { ...process.env, INIT_CWD: '' },
    ),
    0,
    printed.io.err,
  );
  const taskId = /Thread (tsk_\w+)/.exec(printed.io.err)?.[1] ?? '';

  const json = capture();
  assert.equal(await runCli(['usage', 'thread', taskId, '--json', '--home', home], json.output), 0);
  const { kind, ...body } = JSON.parse(json.io.out);
  assert.equal(kind, 'chat-analytics');
  const read = ChatAnalyticsReadSchema.parse(body);
  assert.deepEqual(
    [read.scope, read.turns, read.openTurns, read.handoffs, read.checksRun, read.branchesAccepted],
    ['thread', 1, 0, 0, 0, 0],
  );
  // The scripted client reports no tokens, so they read as unknown and never as zero.
  assert.deepEqual([read.tokensIn, read.tokensOut, read.tokenTurns], [null, null, 0]);

  const text = capture();
  assert.equal(await runCli(['usage', 'project', projectId, '--home', home], text.output), 0);
  assert.match(text.io.out, /Turns 1\. Handoffs 0\./);
  assert.match(text.io.out, /Tokens in unknown, out unknown\./);
  assert.match(text.io.out, /anthropic {2}1/);

  // The file is new, holds one row for the turn and survives a second request for its name.
  const file = join(directory, 'usage.csv');
  const saved = capture();
  assert.equal(
    await runCli(['usage', 'thread', taskId, '--csv', file, '--home', home], saved.output),
    0,
  );
  const lines = readFileSync(file, 'utf8').replace(/^﻿/, '').trimEnd().split('\r\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^[^,]+,0,assistant,anthropic,fixture-model,done,/);
  const again = capture();
  assert.equal(
    await runCli(['usage', 'thread', taskId, '--csv', file, '--home', home], again.output),
    2,
  );
  assert.match(again.io.err, /That file exists/);
  assert.equal(readFileSync(file, 'utf8').split('\r\n').length, 3);
  assert.equal(
    readdirSync(directory).some((name) => name.startsWith('.crewkite-usage-')),
    false,
  );

  // A wrong shape of argument or a thread that is not there does nothing and says so.
  for (const args of [
    ['usage', 'thread'],
    ['usage', 'thread', 'not-an-id'],
    ['usage', 'project', taskId],
    ['usage', 'thread', 'tsk_00000000000000000000000009'],
  ]) {
    const refused = capture();
    assert.equal(await runCli([...args, '--home', home], refused.output), 2, args.join(' '));
  }
  assert.equal(existsSync(join(directory, 'missing.csv')), false);
});
