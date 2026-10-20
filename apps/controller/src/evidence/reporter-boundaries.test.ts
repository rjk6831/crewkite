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
  assert(output.length > 0);
  for (const row of output) {
    assert.deepEqual(Object.keys(row).sort(), ['channel', 'text', 'type']);
    assert.equal(row.channel, 'stderr');
    assert.equal(typeof row.text, 'string');
    assert.equal((row.text as string).isWellFormed(), true);
  }
  return output.map((row) => row.text as string).join('');
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
    { name: 'input byte16384', error: { message: 'a'.repeat(16384) } },
    { name: 'input byte16385', error: { message: 'a'.repeat(16385) }, truncated: true },
    {
      name: 'supplementary codepoint after16369 ASCII bytes',
      error: { message: 'a'.repeat(16369) + '🪁'.repeat(10) },
      truncated: true,
    },
    {
      name: 'ASCII exceeds the aggregate byte bound',
      error: filledCauses('a'.repeat(1024)),
      truncated: true,
    },
    ...[0, 1, 2, 3].map((padding) => ({
      name: `supplementary aggregate alignment${padding}`,
      error: filledCauses('🪁'.repeat(1001), 'a'.repeat(padding)),
      truncated: true,
    })),
  ];
  for (const scenario of cases) {
    const text = await diagnostic(scenario.error);
    assert.equal(text.isWellFormed(), true, scenario.name);
    const bytes = Buffer.byteLength(text, 'utf8');
    assert(bytes <= 16384, scenario.name);
    if ('retained' in scenario && scenario.retained !== undefined)
      assert(text.includes(scenario.retained), scenario.name);
    if ('truncated' in scenario) assert(text.includes('[truncated]'), scenario.name);
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
    { error: cycle, retained: ['cycle root', 'cycle leaf', '[truncated]'] },
    { error: deep, retained: ['depth root'], lastCause: 'depth19' },
    { error: unreadable, retained: ['retained readable message'] },
    {
      error: { name: 'ScalarError', code: 17, operator: 'equal', actual: false, expected: null },
      retained: ['ScalarError', '17', 'equal', 'false', 'null'],
    },
    { error: { actual: 1n << 100000n }, retained: ['[truncated]'] },
  ]) {
    const text = await diagnostic(scenario.error);
    for (const retained of scenario.retained) assert(text.includes(retained), retained);
    if (
      'lastCause' in scenario &&
      scenario.lastCause !== undefined &&
      !text.includes(scenario.lastCause)
    )
      assert(text.includes('[truncated]'));
    assert(Buffer.byteLength(text, 'utf8') <= 16384);
    assert.equal(text.isWellFormed(), true);
  }
  assert.equal(coercions, 0);
});

test('failure diagnostics preserve existing output and leave passing tests quiet', async () => {
  const counts = { tests: 2, passed: 1, failed: 1, cancelled: 0, skipped: 0, todo: 0, suites: 0 };
  const passed = {
    type: 'test:pass',
    data: { name: 'passed check', details: { type: 'test', error: Error('must stay quiet') } },
  };
  const rows = await frames([
    failure({ message: 'retained failure' }),
    { type: 'test:stdout', data: { message: 'existing stdout\n' } },
    { type: 'test:stderr', data: { message: 'existing stderr\n' } },
    passed,
    { type: 'test:summary', data: { success: false, counts } },
  ]);
  const diagnostics = rows.filter(
    (row) => row.type === 'output' && row.channel === 'stderr' && row.text !== 'existing stderr\n',
  );
  assert(diagnostics.length > 0);
  for (const row of diagnostics) {
    assert.deepEqual(Object.keys(row).sort(), ['channel', 'text', 'type']);
    assert.equal(typeof row.text, 'string');
  }
  const text = diagnostics.map((row) => row.text as string).join('');
  assert(text.includes('retained failure'));
  assert(!text.includes('must stay quiet'));
  assert(Buffer.byteLength(text, 'utf8') <= 16384);
  assert.equal(text.isWellFormed(), true);
  assert.deepEqual(
    rows.filter((row) => !diagnostics.includes(row)),
    [
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
    ],
  );
  assert.deepEqual(
    (await frames([passed])).filter((row) => row.type === 'output'),
    [],
  );
});
