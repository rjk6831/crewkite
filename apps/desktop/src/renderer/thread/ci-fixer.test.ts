import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { ChatBranchStatus, CommandResult } from '@crewkite/contracts';
import { sendJobToFixer, type ThreadSource } from './commands.ts';

const taskId = `tsk_${'0'.repeat(26)}`;
const commit = 'a'.repeat(40);
const art = `art_${'1'.repeat(26)}`;
const stored = readFileSync(new URL('./fixtures/job-log.txt', import.meta.url));
const artifact = { id: art, hash: 'b'.repeat(64), bytes: 0, mediaType: 'text/plain' };
const run: NonNullable<ChatBranchStatus['runs']>[number] = {
  id: '101',
  name: 'verify',
  status: 'completed',
  conclusion: 'failure',
  url: 'https://github.com/rjk6831/demo-shop/actions/runs/101',
  createdAt: '2026-10-24T08:00:00.000Z',
  attempt: 2,
  jobs: [],
};
const job = {
  id: '9002',
  name: 'test',
  status: 'completed',
  conclusion: 'failure',
  url: 'https://github.com/rjk6831/demo-shop/actions/runs/101/job/9002',
};

// A controller that answers a job-log read with the stored log, or refuses it.
function fake(log: Buffer | null) {
  const seen: { command: string; payload: Record<string, unknown> }[] = [];
  const source = {
    command: async (input: { command: string; payload: Record<string, unknown> }) => {
      seen.push({ command: input.command, payload: input.payload });
      if (input.command === 'ReadGitHub')
        return log
          ? ({
              outcome: 'applied',
              data: { operation: { stdout: { ...artifact, bytes: log.length } } },
            } as unknown as CommandResult)
          : ({ outcome: 'blocked', reason: 'operation-output-failed' } satisfies CommandResult);
      if (input.command === 'GetArtifactRange') {
        const offset = Number(input.payload.offset);
        const bytes =
          log?.subarray(offset, offset + Number(input.payload.limit)) ?? Buffer.alloc(0);
        return {
          outcome: 'applied',
          data: {
            kind: 'artifact-range',
            artifact: { ...artifact, bytes: log?.length ?? 0 },
            offset,
            encoding: 'base64',
            content: bytes.toString('base64'),
            eof: offset + bytes.length === (log?.length ?? 0),
            integrity: 'unverified-range',
          },
        } satisfies CommandResult;
      }
      return { outcome: 'applied' } satisfies CommandResult;
    },
  };
  return { source: source as unknown as ThreadSource, seen };
}

test('a failed job log reaches the fixer once, bound to the commit, run, attempt and job', async () => {
  const { source, seen } = fake(stored);
  const first = await sendJobToFixer(source, { taskId, commit, run, job });
  const again = await sendJobToFixer(source, { taskId, commit, run, job });
  assert.deepEqual(first, { sent: true });
  assert.equal(again.sent, false);
  const reads = seen.filter((call) => call.command === 'ReadGitHub');
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0]?.payload.request, {
    kind: 'job-log',
    repository: { host: 'github.com', owner: 'rjk6831', name: 'demo-shop' },
    headSha: commit,
    runId: '101',
    attempt: 2,
    jobId: '9002',
  });
  const sends = seen.filter((call) => call.command === 'SendChatMessage');
  assert.equal(sends.length, 1);
  const text = String(sends[0]?.payload.text);
  assert.equal(sends[0]?.payload.role, 'fixer');
  // The redacted line the controller stored stays redacted, and the failing assertion is there.
  assert.match(text, /> .*NPM_TOKEN: \[REDACTED\]/);
  assert.match(text, /> .*expected 10\.99 to equal 11/);
  assert.match(text, new RegExp(art));
});

test('a job log that cannot be read sends nothing and can be tried again', async () => {
  const lost = fake(null);
  const other = { ...job, id: '9003' };
  const unread = await sendJobToFixer(lost.source, { taskId, commit, run, job: other });
  assert.equal(unread.sent, false);
  assert.equal(lost.seen.filter((call) => call.command === 'SendChatMessage').length, 0);
  // Nothing was recorded as sent, so a later click reads again.
  const later = fake(stored);
  const retry = await sendJobToFixer(later.source, { taskId, commit, run, job: other });
  assert.equal(retry.sent, true);
  // A run whose attempt was never read has no log to bind to.
  const unknown = await sendJobToFixer(later.source, {
    taskId,
    commit,
    run: { ...run, id: '102', attempt: null },
    job,
  });
  assert.equal(unknown.sent, false);
});
