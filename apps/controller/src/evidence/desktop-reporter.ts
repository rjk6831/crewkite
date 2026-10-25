import { writeSync } from 'node:fs';
import { relative } from 'node:path';
import type { CheckEvent } from '@crewkite/contracts';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

const file = 'e2e/thread.spec.ts';
function expectedJourney(): { file: typeof file; title: string } | undefined {
  const text = process.env.CREWKITE_CHECK_JOURNEY;
  if (!text || Buffer.byteLength(text) > 1024) return;
  try {
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'file,title' ||
      !('file' in value) ||
      value.file !== file ||
      !('title' in value) ||
      typeof value.title !== 'string' ||
      value.title.length === 0 ||
      value.title.length > 200 ||
      [...value.title].some((character) => character.charCodeAt(0) < 32 || character === '\x7f')
    )
      return;
    return { file, title: value.title };
  } catch {
    return;
  }
}

function emit(event: CheckEvent): void {
  writeSync(1, `${JSON.stringify(event)}\n`);
}

export default class DesktopReporter implements Reporter {
  private readonly expected = expectedJourney();
  private failed = !this.expected;
  private begins = 0;
  private ends = 0;
  private completed = 0;
  private passed = 0;
  private skipped = 0;
  private cancelled = 0;
  private testId: string | undefined;

  printsToStdio(): boolean {
    return true;
  }

  private matches(test: TestCase): boolean {
    return (
      !!this.expected &&
      relative(process.cwd(), test.location.file) === this.expected.file &&
      test.title === this.expected.title
    );
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.begins += 1;
    if (this.begins === 1) emit({ type: 'start', version: 1 });
    const tests = suite.allTests();
    if (this.begins !== 1 || tests.length !== 1 || !this.matches(tests[0])) {
      this.failed = true;
      return;
    }
    this.testId = tests[0].id;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.completed += 1;
    this.passed += Number(result.status === 'passed');
    this.skipped += Number(result.status === 'skipped');
    this.cancelled += Number(result.status === 'interrupted');
    if (
      this.begins !== 1 ||
      this.ends !== 0 ||
      this.completed !== 1 ||
      !this.matches(test) ||
      test.id !== this.testId ||
      test.expectedStatus !== 'passed' ||
      result.status !== 'passed' ||
      result.retry !== 0 ||
      result.errors.length !== 0
    )
      this.failed = true;
    if (this.completed === 1 && this.matches(test))
      emit({
        type: 'test',
        file,
        name: test.title,
        kind: 'test',
        passed: result.status === 'passed',
        skipped: result.status === 'skipped',
        todo: false,
      });
  }

  onError(): void {
    this.failed = true;
  }

  onEnd(result: FullResult): void {
    this.ends += 1;
    if (this.ends !== 1 || result.status !== 'passed') this.failed = true;
  }

  async onExit(): Promise<void> {
    if (this.ends !== 1) return;
    const success = !this.failed && this.begins === 1 && this.completed === 1;
    const counts = {
      tests: this.completed,
      passed: this.passed,
      failed: this.completed - this.passed - this.skipped - this.cancelled,
      cancelled: this.cancelled,
      skipped: this.skipped,
      todo: 0,
      suites: 0,
    };
    emit({ type: 'summary', file, success, counts });
    emit({ type: 'summary', file: null, success, counts });
    emit({ type: 'end' });
  }
}
