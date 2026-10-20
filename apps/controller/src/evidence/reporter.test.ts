import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestEvent } from 'node:test/reporters';
import report from './reporter.ts';

test('failed Node checks retain bounded causes without changing completions', async () => {
  let assertion: unknown;
  try {
    assert.equal('observed-source', 'retained-source', 'The retained source hash changed.');
  } catch (error) {
    assertion = error;
  }
  assert(assertion instanceof assert.AssertionError);
  const wrapped = Object.assign(new Error('test failed', { cause: assertion }), {
    code: 'ERR_TEST_FAILURE',
    failureType: 'testCodeFailure',
  });
  const oversized = new Error(`A long failure ${'🪁'.repeat(20000)}`);
  const cyclic = new Error('A small cyclic root');
  let tail = cyclic;
  for (let index = 0; index < 80; index++) {
    const cause = new Error(`Nested failure ${index}`);
    tail.cause = cause;
    tail = cause;
  }
  tail.cause = cyclic;
  const unusual = new Error('A failed check with an unreadable detail');
  Object.defineProperty(unusual, 'actual', {
    enumerable: true,
    get() {
      throw Error('This detail cannot be inspected.');
    },
  });
  for (const scenario of [
    {
      name: 'wrapped assertion',
      error: wrapped,
      expected: [
        'The retained source hash changed.',
        'ERR_ASSERTION',
        'strictEqual',
        'observed-source',
        'retained-source',
      ],
    },
    {
      name: 'ordinary cause',
      error: new Error('Verification stage failed.', {
        cause: new Error('Owned closure missing.'),
      }),
      expected: ['Verification stage failed.', 'Owned closure missing.'],
    },
    { name: 'large message', error: oversized, expected: ['A long failure', '[truncated]'] },
    {
      name: 'small cyclic cause',
      error: cyclic,
      expected: ['A small cyclic root', '[truncated]'],
    },
    {
      name: 'unreadable detail',
      error: unusual,
      expected: ['A failed check with an unreadable detail'],
    },
    { name: 'successful check', error: undefined, expected: [] },
  ]) {
    const passed = scenario.error === undefined;
    const counts = {
      tests: 1,
      passed: Number(passed),
      failed: Number(!passed),
      cancelled: 0,
      skipped: 0,
      todo: 0,
      suites: 0,
    };
    const summary = { success: passed, counts };
    const events = [
      {
        type: passed ? 'test:pass' : 'test:fail',
        data: {
          name: scenario.name,
          file: join(process.cwd(), 'source-check.test.mjs'),
          details: {
            type: 'test',
            duration_ms: 1,
            ...(scenario.error ? { error: scenario.error } : {}),
          },
        },
      },
      { type: 'test:stdout', data: { message: 'Existing check output.\n' } },
      {
        type: 'test:summary',
        data: { ...summary, file: join(process.cwd(), 'source-check.test.mjs') },
      },
      { type: 'test:summary', data: summary },
    ];
    const source = async function* () {
      for (const event of events) yield event as unknown as TestEvent;
    };
    const chunks: string[] = [];
    for await (const chunk of report(source())) chunks.push(chunk);
    const encoded = chunks.join('');
    assert(encoded.endsWith('\n'), scenario.name);
    const frames = encoded
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const diagnostic = frames.filter(
      (frame) => frame.type === 'output' && frame.channel === 'stderr',
    );
    const text = diagnostic.map((frame) => frame.text).join('\n');
    for (const expected of scenario.expected)
      assert(text.includes(expected), `${scenario.name} lost ${expected}`);
    assert(Buffer.byteLength(text, 'utf8') <= 16384, `${scenario.name} exceeded the byte bound`);
    assert.equal(text.isWellFormed(), true, scenario.name);
    for (const frame of diagnostic) {
      assert.deepEqual(Object.keys(frame).sort(), ['channel', 'text', 'type']);
      assert.equal(typeof frame.text, 'string');
    }
    if (passed) assert.equal(diagnostic.length, 0);
    assert.deepEqual(
      frames.filter((frame) => !(frame.type === 'output' && frame.channel === 'stderr')),
      [
        { type: 'start', version: 1 },
        {
          type: 'test',
          file: 'source-check.test.mjs',
          name: scenario.name,
          kind: 'test',
          passed,
          skipped: false,
          todo: false,
        },
        { type: 'output', channel: 'stdout', text: 'Existing check output.\n' },
        { type: 'summary', file: 'source-check.test.mjs', ...summary },
        { type: 'summary', file: null, ...summary },
        { type: 'end' },
      ],
      `${scenario.name} changed report completion semantics`,
    );
  }
});
