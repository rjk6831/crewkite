import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ChatTurnRequest } from '../../chat/adapter.ts';
import { clientRecord, forgetClientRecord } from '../client-record.ts';
import { chatArguments } from './chat.ts';
import { forgetProbes, probeClient } from './client-probe.ts';
import { forgetFlags, knownFlags, PASSED_FLAGS } from './protocol.ts';
import { anthropicUsageReaderPlan } from './usage-reader.ts';

// A help text that lists every flag CrewKite passes except the two optional ones a release could
// drop. The flag names sit at the start of an option line, as the client prints them.
const help = (without: readonly string[]) =>
  `Usage: claude [options]\n\nOptions:\n${PASSED_FLAGS.filter((flag) => !without.includes(flag))
    .map((flag) => `  ${flag} <value>  What it does`)
    .join('\n')}\n`;

const request = {
  selection: { model: 'probe', effort: 'high' },
  readOnly: true,
  permissionPolicy: 'ask',
  subagents: false,
  mcp: { servers: [] },
} as unknown as ChatTurnRequest;

test('a build that does not list an optional flag runs without it and its value, and a flag that limits the client is never dropped', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'crewkite-probe-'));
  const sha256 = 'c'.repeat(64);
  t.after(() => {
    rmSync(home, { recursive: true });
    forgetFlags();
    forgetProbes();
    forgetClientRecord('anthropic');
  });
  probeClient({
    executable: '/never-executed/claude',
    sha256,
    version: '2.1.330',
    environment: { HOME: home, CREWKITE_HOME: home },
    // --restricted is one the build lacks too. The probe says so and keeps it in the argument list.
    help: () => help(['--effort', '--include-partial-messages', '--restricted']),
  });
  const chat = chatArguments(request, null, [], null, () => '{}', knownFlags(sha256));
  assert.equal(chat.dropped.join(), '--include-partial-messages,--effort');
  assert.equal(chat.argv.includes('--include-partial-messages'), false);
  assert.equal(chat.argv.includes('--effort'), false);
  assert.equal(chat.argv.includes('high'), false);
  assert.equal(chat.argv.includes('--permission-mode'), true);
  // The usage read takes the same list from the digest of the build it launches.
  const usage = anthropicUsageReaderPlan({
    clientSha256: sha256,
    clientVersion: '2.1.330',
    sessionId: '46eb17cd-01e8-480d-99f4-a741f189715d',
  }).argv;
  assert.equal(usage.includes('--restricted'), true);
  assert.equal(usage.includes('--no-chrome'), true);
  // A build nobody probed keeps every flag, and the client's own reply decides.
  assert.equal(chatArguments(request, null, [], null, () => '{}', null).dropped.length, 0);
  assert.match(clientRecord('anthropic', '2.1.330')?.probe ?? '', /does not list --restricted/);
});
