import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import {
  type FakeWorkerEvent,
  FakeWorkerEventSchema,
  type FakeWorkerInput,
  FakeWorkerInputSchema,
  MAX_FRAME_BYTES,
  type ReviewResult,
  ReviewResultSchema,
} from '@crewkite/contracts';

function emit(event: FakeWorkerEvent) {
  process.stdout.write(`${JSON.stringify(FakeWorkerEventSchema.parse(event))}\n`);
}

function readCandidate(directory: string): string {
  const file = openSync(
    join(directory, 'net.mjs'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const state = fstatSync(file);
    if (!state.isFile() || state.nlink !== 1 || state.size > 65_536)
      throw new Error('Candidate source is unavailable.');
    const bytes = Buffer.alloc(65_537);
    let count = 0;
    while (count < bytes.length) {
      const received = readSync(file, bytes, count, bytes.length - count, null);
      if (received === 0) break;
      count += received;
    }
    if (count > 65_536) throw new Error('Candidate source exceeds the inspection limit.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
  } finally {
    closeSync(file);
  }
}

function inspect(input: Extract<FakeWorkerInput, { type: 'review' }>): ReviewResult {
  try {
    const source = readCandidate(input.scratchPath);
    const facts = [
      {
        present: /^export function netMinor\(subtotalMinor,\s*discountMinor\)/m.test(source),
        message: 'The fixture exports netMinor with both minor-amount inputs.',
      },
      {
        present: source.includes('Number.isSafeInteger') && /value\s*>=\s*0/.test(source),
        message: 'The fixture guards safe non-negative integer inputs.',
      },
      {
        present: /Math\.max\(0,\s*subtotalMinor\s*-\s*discountMinor\)/.test(source),
        message: 'The fixture clamps its subtraction at zero.',
      },
    ];
    const scope = {
      present:
        (source.match(/^export\b/gm) ?? []).length === 1 &&
        !/^\s*(?:import\b|.*require\s*\()/m.test(source),
      message: 'The fixture contains one export and no imported runtime.',
    };
    const methods = {
      'keep-it-simple': [facts[0], scope],
      'challenge-assumptions': [facts[1]],
      'second-opinion': [facts[2]],
      'round-robin': [facts[input.job.cycle - 1]],
    };
    const findings = methods[input.job.methodId].map((fact) => ({
      severity: fact.present ? ('info' as const) : ('blocking' as const),
      message: `${fact.present ? 'Found' : 'Missing'}: ${fact.message}`,
    }));
    return ReviewResultSchema.parse({
      job: input.job,
      outcome: findings.some((finding) => finding.severity === 'blocking') ? 'failed' : 'passed',
      findings,
      summary: `SCRIPTED ${input.job.methodId}, cycle ${input.job.cycle}. Fixed fixture patterns inspected. Received ${input.criteria.length} criteria and ${input.guidance?.principles.length ?? 0} principles. No model judgment or code execution.`,
    });
  } catch {
    return ReviewResultSchema.parse({
      job: input.job,
      outcome: 'blocked',
      findings: [
        {
          severity: 'blocking',
          message: 'A bounded regular UTF-8 net.mjs file is required for this scripted review.',
        },
      ],
      summary: 'SCRIPTED review blocked. Candidate inspection did not complete.',
    });
  }
}

let pending = Buffer.alloc(0);
let finished = false;
function fail() {
  if (finished) return;
  finished = true;
  process.stderr.write('Invalid scripted review input.\n');
  process.exitCode = 2;
  process.stdin.destroy();
}
process.stdin.on('data', (chunk: Buffer) => {
  if (finished) return;
  if (pending.length + chunk.length > MAX_FRAME_BYTES) return fail();
  pending = Buffer.concat([pending, chunk]);
  const end = pending.indexOf(10);
  if (end === -1) return;
  try {
    const input = FakeWorkerInputSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(0, end))),
    );
    if (input.type !== 'review' && input.type !== 'stop') return fail();
    if (input.type === 'review') {
      emit({ type: 'ready', attemptId: input.job.attemptId, generation: input.job.generation });
      emit({ type: 'review', result: inspect(input) });
    }
    emit({
      type: 'terminal',
      outcome: input.type === 'stop' ? 'stopped' : 'completed',
      reason: input.type === 'stop' ? 'Review stopped.' : 'Scripted review result retained.',
    });
    finished = true;
    process.stdin.destroy();
  } catch {
    fail();
  }
});
process.stdin.on('end', () => {
  if (!finished) fail();
});
process.stdin.on('error', fail);
