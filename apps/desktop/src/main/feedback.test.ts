import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReport, ISSUE_URL, issueUrl } from './feedback-report.ts';

const facts = { app: '1.2.3', os: 'Darwin 25.0.0 arm64' };

test('the default report holds only what was written, with no version or identifier lines', () => {
  const report = buildReport(
    {
      what: 'The thread stalled. Mail ann@example.com, key sk-abcdef123456 in /Users/ann/x.',
      app: false,
      os: false,
      clients: false,
      clientVersions: ['OpenAI 0.5.1'],
    },
    facts,
  );
  assert.equal(report.includes('1.2.3'), false);
  assert.equal(report.includes('Darwin'), false);
  assert.equal(report.includes('OpenAI 0.5.1'), false);
  assert.equal(report.includes('ann@example.com'), false);
  assert.equal(report.includes('sk-abcdef123456'), false);
  assert.match(report, /The thread stalled/);
  const ticked = buildReport(
    { what: 'x', app: true, os: true, clients: true, clientVersions: ['OpenAI 0.5.1'] },
    facts,
  );
  assert.match(ticked, /App: 1\.2\.3\nOS: Darwin 25\.0\.0 arm64\nClients: OpenAI 0\.5\.1/);
});

test('the issue link is the fixed address with a bounded title and body', () => {
  const link = new URL(issueUrl(`Short title\n${'long body '.repeat(5000)}`));
  assert.equal(`${link.origin}${link.pathname}`, ISSUE_URL);
  assert.deepEqual([...link.searchParams.keys()].sort(), ['body', 'title']);
  assert.equal(link.searchParams.get('title'), 'Short title');
  assert.ok(link.href.length <= 6000);
  assert.match(link.searchParams.get('body') ?? '', /Cut to fit the address/);
});
