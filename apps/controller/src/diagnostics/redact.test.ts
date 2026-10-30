import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactDiagnosticText, redactDiagnosticValue } from './redact.ts';

const home = '/home/ann';

test('diagnostic redaction removes keys, bearer tokens, secret assignments, home paths and emails', () => {
  const cases: { name: string; input: string; gone: string[]; kept: string[] }[] = [
    {
      name: 'key',
      input: 'failed with sk-test1234567890',
      gone: ['sk-test1234567890'],
      kept: ['failed with'],
    },
    {
      name: 'bearer token',
      input: 'Authorization: Bearer abc.def-ghi',
      gone: ['abc.def-ghi'],
      kept: ['Bearer [redacted]'],
    },
    {
      name: 'secret assignment',
      input: 'API_KEY=hunter2value and "access_token": "quoted-value"',
      gone: ['hunter2value', 'quoted-value'],
      kept: ['API_KEY=[redacted]'],
    },
    {
      name: 'home path',
      input: 'cwd /home/ann/work and /home/annette/work',
      gone: ['/home/ann/work'],
      kept: ['~/work', '/home/annette/work'],
    },
    {
      name: 'email',
      input: 'owner ann.lee+tag@example.com wrote',
      gone: ['ann.lee+tag@example.com'],
      kept: ['owner [redacted] wrote'],
    },
    {
      name: 'value split across a JSON line',
      input: '{\n  "apiToken":\n    "line-split-value"\n}',
      gone: ['line-split-value'],
      kept: ['apiToken'],
    },
  ];
  for (const { name, input, gone, kept } of cases) {
    const output = redactDiagnosticText(input, home);
    for (const text of gone) assert.equal(output.includes(text), false, `${name}: ${text}`);
    for (const text of kept) assert.equal(output.includes(text), true, `${name}: ${text}`);
  }

  // Structured data keeps valid JSON, and a secret key loses its value whatever it looks like.
  const value = redactDiagnosticValue(
    { password: 'plain', nested: [{ note: 'mail a@b.co from /home/ann' }], count: 3 },
    home,
  );
  assert.deepEqual(value, {
    password: '[redacted]',
    nested: [{ note: 'mail [redacted] from ~' }],
    count: 3,
  });
});
