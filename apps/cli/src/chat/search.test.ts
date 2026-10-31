import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CliJsonLine, CliJsonLineSchema } from '@crewkite/contracts';
import { runCli } from '../main.ts';
import { startScriptedController } from '../scripted-controller.ts';

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
const lines = (text: string): CliJsonLine[] =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => CliJsonLineSchema.parse(JSON.parse(line)));

test('crewkite search prints one line per thread, then a summary, and refuses what it cannot run', {
  timeout: 60_000,
}, async (t) => {
  const { home, repository } = await startScriptedController(t, [
    [
      { kind: 'tool', callId: 'run-1', toolKind: 'command', title: 'Run quokka-checks' },
      { kind: 'text', itemId: 'reply', chunks: ['The platypus fix ', 'is in.'] },
    ],
  ]);
  const added = capture();
  assert.equal(
    await runCli(['project', 'add', repository, '--json', '--home', home], added.output),
    0,
  );
  const projectId = JSON.parse(added.io.out).result?.entity?.id;
  const made = capture();
  assert.equal(
    await runCli(
      [
        'thread',
        'new',
        projectId,
        'Find the walrus bug',
        '--model',
        'anthropic/fixture-model',
        '--watch',
        '--home',
        home,
      ],
      made.output,
    ),
    0,
    made.io.err,
  );
  const listed = capture();
  assert.equal(await runCli(['thread', 'list', '--json', '--home', home], listed.output), 0);
  const [threads] = lines(listed.io.out);
  const taskId = threads.kind === 'threads' ? (threads.threads[0]?.taskId ?? '') : '';
  assert.ok(taskId, listed.io.out);

  const json = capture();
  assert.equal(
    await runCli(['search', 'walrus', 'bug', '--json', '--home', home], json.output),
    0,
    json.io.err,
  );
  const [group, summary, ...rest] = lines(json.io.out);
  assert.equal(rest.length, 0);
  assert.ok(group.kind === 'result' && summary.kind === 'result');
  assert.equal(group.command, 'SearchChatHistory');
  assert.equal(group.taskId, taskId);
  const data = group.data as { query: string; hits: { kind: string; turnId: string | null }[] };
  assert.equal(data.query, 'walrus bug');
  assert.ok(data.hits.some((hit) => hit.kind === 'message' && hit.turnId));
  assert.equal(summary.taskId, null);
  assert.deepEqual(summary.data, { query: 'walrus bug', threads: 1, more: false, tooShort: false });

  const text = capture();
  assert.equal(await runCli(['search', 'quokka-checks', '--home', home], text.output), 0);
  assert.match(text.io.out, new RegExp(`^${taskId}  .*\\n  tool +.*quokka-checks`, 'm'));

  const none = capture();
  assert.equal(
    await runCli(['search', 'nothingmatchesthis', '--json', '--home', home], none.output),
    0,
  );
  const [empty, ...after] = lines(none.io.out);
  assert.equal(after.length, 0);
  assert.ok(empty.kind === 'result' && empty.taskId === null);
  assert.equal((empty.data as { threads: number }).threads, 0);

  const short = capture();
  assert.equal(await runCli(['search', 'go', '--home', home], short.output), 0);
  assert.match(short.io.err, /three characters/);

  for (const args of [
    ['search'],
    ['search', '   '],
    ['search', 'walrus', '--limit', '99'],
    ['search', 'walrus', '--per-thread', '0'],
    ['search', 'walrus', '--bogus'],
  ]) {
    const refused = capture();
    assert.equal(await runCli([...args, '--home', home], refused.output), 2, args.join(' '));
    assert.equal(refused.io.out, '');
  }
});
