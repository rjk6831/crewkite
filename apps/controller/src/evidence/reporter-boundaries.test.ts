import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestEvent } from 'node:test/reporters';
import report from './reporter.ts';

async function frames(events: unknown[]) {
  const source = async function* () {
    for (const event of events) yield event as TestEvent;
  };
  const rows: Record<string, unknown>[] = [];
  for await (const chunk of report(source())) rows.push(JSON.parse(chunk));
  return rows;
}

const failure = (error: unknown) => ({
  type: 'test:fail',
  data: { name: 'failed check', details: { type: 'test', error } },
});

async function diagnostic(error: unknown) {
  const rows = await frames([failure(error)]);
  const output = rows.filter((row) => row.type === 'output');
  assert.equal(output.length, 1);
  assert.equal(output[0].channel, 'stderr');
  assert.equal(typeof output[0].text, 'string');
  return output[0].text as string;
}

function filledCauses(value: string, padding = '') {
  let cause: unknown;
  for (let depth = 0; depth < 8; depth++) {
    cause = {
      name: (depth === 7 ? padding : '') + value,
      message: value,
      code: value,
      operator: value,
      actual: value,
      expected: value,
      stack: value,
      ...(cause ? { cause } : {}),
    };
  }
  return cause;
}

test('failure diagnostics preserve whole Unicode at field and aggregate byte limits', async () => {
  const cases = [
    { name: 'lone surrogates', error: { message: 'a\ud800b\udc00' }, retained: 'a�b�' },
    { name: 'input byte16384', error: { message: 'a'.repeat(16384) }, truncated: true },
    { name: 'input byte16385', error: { message: 'a'.repeat(16385) }, truncated: true },
    {
      name: 'supplementary codepoint after16369 ASCII bytes',
      error: { message: 'a'.repeat(16369) + '🪁'.repeat(10) },
      truncated: true,
    },
    {
      name: 'ASCII fills the aggregate byte16384 bound',
      error: filledCauses('a'.repeat(1024)),
      truncated: true,
      bytes: 16384,
    },
    ...[0, 1, 2, 3].map((padding) => ({
      name: `supplementary aggregate alignment${padding}`,
      error: filledCauses('🪁'.repeat(1001), 'a'.repeat(padding)),
      truncated: true,
      nearLimit: true,
    })),
  ];
  for (const scenario of cases) {
    const text = await diagnostic(scenario.error);
    assert.equal(text.isWellFormed(), true, scenario.name);
    const bytes = Buffer.byteLength(text, 'utf8');
    assert(bytes <= 16384, scenario.name);
    if ('retained' in scenario && scenario.retained !== undefined)
      assert(text.includes(scenario.retained), scenario.name);
    if ('truncated' in scenario) assert(text.endsWith('\n[truncated]'), scenario.name);
    if ('bytes' in scenario) assert.equal(bytes, scenario.bytes, scenario.name);
    if ('nearLimit' in scenario) assert(bytes >= 16381, scenario.name);
  }
});

test('failure diagnosis bounds cause traversal and ignores unreadable object coercion', async () => {
  const cycle = { message: 'cycle root', cause: undefined as unknown };
  cycle.cause = { message: 'cycle leaf', cause: cycle };
  const deep = { message: 'depth root', cause: undefined as unknown };
  let tail = deep;
  for (let depth = 0; depth < 20; depth++) {
    const cause = { message: `depth${depth}`, cause: undefined as unknown };
    tail.cause = cause;
    tail = cause;
  }
  let coercions = 0;
  const opaque = {
    toString() {
      coercions++;
      throw Error('Object coercion must not run.');
    },
  };
  const unreadable = { message: 'retained readable message', actual: opaque };
  Object.defineProperty(unreadable, 'cause', {
    get() {
      throw Error('Cause cannot be read.');
    },
  });
  for (const scenario of [
    { error: cycle, retained: ['cycle root', 'cycle leaf', '[truncated]'], missing: [] },
    { error: deep, retained: ['depth root', '[truncated]'], missing: ['depth19'] },
    { error: unreadable, retained: ['retained readable message'], missing: [] },
    {
      error: { name: 'ScalarError', code: 17, operator: 'equal', actual: false, expected: null },
      retained: ['ScalarError', 'code: 17', 'operator: equal', 'actual: false', 'expected: null'],
      missing: [],
    },
    { error: { actual: 1n << 100000n }, retained: ['[truncated]'], missing: [] },
  ]) {
    const text = await diagnostic(scenario.error);
    for (const retained of scenario.retained) assert(text.includes(retained), retained);
    for (const missing of scenario.missing) assert(!text.includes(missing), missing);
    assert(Buffer.byteLength(text, 'utf8') <= 16384);
    assert.equal(text.isWellFormed(), true);
  }
  assert.equal(coercions, 0);
});

test('failure diagnostics preserve existing output and leave passing tests quiet', async () => {
  const counts = { tests: 2, passed: 1, failed: 1, cancelled: 0, skipped: 0, todo: 0, suites: 0 };
  const rows = await frames([
    failure({ message: 'retained failure' }),
    { type: 'test:stdout', data: { message: 'existing stdout\n' } },
    { type: 'test:stderr', data: { message: 'existing stderr\n' } },
    {
      type: 'test:pass',
      data: { name: 'passed check', details: { type: 'test', error: Error('must stay quiet') } },
    },
    { type: 'test:summary', data: { success: false, counts } },
  ]);
  assert.deepEqual(rows, [
    { type: 'start', version: 1 },
    {
      type: 'test',
      file: '',
      name: 'failed check',
      kind: 'test',
      passed: false,
      skipped: false,
      todo: false,
    },
    { type: 'output', channel: 'stderr', text: 'message: retained failure' },
    { type: 'output', channel: 'stdout', text: 'existing stdout\n' },
    { type: 'output', channel: 'stderr', text: 'existing stderr\n' },
    {
      type: 'test',
      file: '',
      name: 'passed check',
      kind: 'test',
      passed: true,
      skipped: false,
      todo: false,
    },
    { type: 'summary', file: null, success: false, counts },
    { type: 'end' },
  ]);
});
