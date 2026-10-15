import { relative } from 'node:path';
import type { TestEvent } from 'node:test/reporters';

export type CheckEvent =
  | { type: 'start'; version: 1 }
  | {
      type: 'test';
      file: string;
      name: string;
      kind?: 'test' | 'suite';
      passed: boolean;
      skipped: boolean;
      todo: boolean;
    }
  | {
      type: 'summary';
      file: string | null;
      success: boolean;
      counts: {
        tests: number;
        passed: number;
        failed: number;
        cancelled: number;
        skipped: number;
        todo: number;
        suites: number;
      };
    }
  | { type: 'output'; channel: 'stdout' | 'stderr'; text: string }
  | { type: 'end' };

export default async function* report(source: AsyncIterable<TestEvent>) {
  yield `${JSON.stringify({ type: 'start', version: 1 })}\n`;
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
        counts: { ...counts, failed: Number('failed' in counts ? counts.failed : undefined) },
      };
    } else if (event.type === 'test:stdout' || event.type === 'test:stderr') {
      row = {
        type: 'output',
        channel: event.type === 'test:stdout' ? 'stdout' : 'stderr',
        text: event.data.message,
      };
    }
    if (row) yield `${JSON.stringify(row)}\n`;
  }
  yield `${JSON.stringify({ type: 'end' })}\n`;
}
