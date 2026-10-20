import { relative } from 'node:path';
import type { TestEvent } from 'node:test/reporters';
import type { CheckEvent } from '@crewkite/contracts';

function encode(event: CheckEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function readField(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function formatError(error: unknown): string {
  const lines: string[] = [];
  const seen = new Set<object>();
  let omitted = false;
  const field = (name: string, value: unknown) => {
    if (value === undefined) return;
    let scalar: string;
    if (typeof value === 'symbol') {
      scalar = String(value);
    } else if (typeof value === 'string') scalar = value;
    else if (typeof value === 'bigint') {
      const limit = 1n << 1024n;
      if (value < -limit || value > limit) {
        omitted = true;
        scalar = '[large bigint]';
      } else scalar = String(value);
    } else if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      scalar = String(value);
    } else return;
    let prefix = '';
    let count = 0;
    for (const point of scalar) {
      if (count === 1024) {
        omitted = true;
        break;
      }
      prefix += point;
      count++;
    }
    lines.push(`${name}: ${prefix}`);
  };
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if ((typeof current !== 'object' || current === null) && typeof current !== 'function') {
      field('Error', current);
      break;
    }
    if (seen.has(current)) {
      omitted = true;
      break;
    }
    seen.add(current);
    for (const key of ['name', 'message', 'code', 'operator', 'actual', 'expected', 'stack']) {
      field(key, readField(current, key));
    }
    const cause = readField(current, 'cause');
    if (cause === undefined) break;
    if (depth === 7) {
      omitted = true;
      break;
    }
    lines.push('Caused by:');
    current = cause;
  }
  const text = (lines.join('\n') || 'Error: unavailable failure details.').toWellFormed();
  const maximum = 16384;
  if (!omitted && Buffer.byteLength(text, 'utf8') <= maximum) return text;
  const marker = '\n[truncated]';
  const budget = maximum - Buffer.byteLength(marker, 'utf8');
  let prefix = '';
  let bytes = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point, 'utf8');
    if (bytes + size > budget) break;
    prefix += point;
    bytes += size;
  }
  return prefix + marker;
}

export default async function* report(source: AsyncIterable<TestEvent>) {
  yield encode({ type: 'start', version: 1 });
  for await (const event of source) {
    let row: CheckEvent | undefined;
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const { data } = event;
      row = {
        type: 'test',
        file: data.file ? relative(process.cwd(), data.file) : '',
        name: data.name,
        kind: data.details.type,
        passed: event.type === 'test:pass',
        skipped: !!data.skip,
        todo: !!data.todo,
      };
    } else if (event.type === 'test:summary') {
      const counts = event.data.counts;
      row = {
        type: 'summary',
        file: event.data.file ? relative(process.cwd(), event.data.file) : null,
        success: event.data.success,
        counts: {
          tests: counts.tests,
          passed: counts.passed,
          failed: Number('failed' in counts ? counts.failed : undefined),
          cancelled: counts.cancelled,
          skipped: counts.skipped,
          todo: counts.todo,
          suites: counts.suites,
        },
      };
    } else if (event.type === 'test:stdout' || event.type === 'test:stderr') {
      row = {
        type: 'output',
        channel: event.type === 'test:stdout' ? 'stdout' : 'stderr',
        text: event.data.message,
      };
    }
    if (row) yield encode(row);
    if (event.type === 'test:fail') {
      yield encode({
        type: 'output',
        channel: 'stderr',
        text: formatError(event.data.details.error),
      });
    }
  }
  yield encode({ type: 'end' });
}
