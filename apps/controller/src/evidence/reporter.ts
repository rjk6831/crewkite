import { relative } from 'node:path';
import type { TestEvent } from 'node:test/reporters';
import type { CheckEvent } from '@crewkite/contracts';

function encode(event: CheckEvent): string {
  return `${JSON.stringify(event)}\n`;
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
  }
  yield encode({ type: 'end' });
}
