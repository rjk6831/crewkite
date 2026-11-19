import assert from 'node:assert/strict';
import test from 'node:test';
import type { DesignFinding } from '@crewkite/contracts';
import {
  groupFindings,
  openByFile,
  RULE_LABELS,
  stateLine,
  suggestion,
  versionLabel,
} from './findings.ts';

const current = 'a'.repeat(64);
const older = 'b'.repeat(64);
let count = 0;
const finding = (
  file: string,
  line: number,
  rule: DesignFinding['rule'],
  state: DesignFinding['state'] = 'open',
  reason: string | null = null,
): DesignFinding => ({
  id: `dsf_01${String(++count).padStart(24, '0')}`,
  taskId: `tsk_01${'0'.repeat(24)}`,
  file,
  line,
  rule,
  found: '13px',
  nearestToken: rule === 'unknown-font' ? null : 'spacing.3',
  state,
  reason,
  versionHash: current,
});

// Claim: the Design tab lists a thread's findings by file with the rows that need a decision on
// top, words each rule and state the same way every time, and names a version only when the check
// read the version saved now.
test('findings group by file with open rows first and name the checked version', () => {
  const rows = [
    finding('src/card.css', 30, 'off-scale-spacing', 'sent'),
    finding('src/card.css', 22, 'raw-color'),
    finding('src/app.tsx', 4, 'unknown-font', 'allowed', 'Brand font on the landing page.'),
    finding('src/card.css', 40, 'off-scale-radius'),
    finding(
      'src/app.tsx',
      9,
      'unknown-shadow',
      'open',
      'Draft open. This resolves when a saved version holds the value.',
    ),
    finding('src/card.css', 12, 'off-scale-spacing', 'resolved'),
  ];
  const groups = groupFindings(rows);
  assert.deepEqual(
    groups.map(({ file, open, rows }) => [
      file,
      open,
      rows.map((row) => `${row.line} ${row.state}`),
    ]),
    [
      ['src/app.tsx', 1, ['9 open', '4 allowed']],
      ['src/card.css', 2, ['22 open', '40 open', '30 sent', '12 resolved']],
    ],
  );
  assert.deepEqual(
    [...openByFile(rows)],
    [
      ['src/card.css', 2],
      ['src/app.tsx', 1],
    ],
  );
  assert.deepEqual(Object.values(RULE_LABELS), [
    'Raw color',
    'Spacing off the scale',
    'Unknown font',
    'Radius off the scale',
    'Unknown shadow',
  ]);
  assert.deepEqual(
    rows.map((row) => stateLine(row)),
    [
      'Sent to the fixer.',
      null,
      'Allowed: Brand font on the landing page.',
      null,
      'Draft open.',
      'No longer in the file.',
    ],
  );
  assert.equal(suggestion(rows[1] as DesignFinding), 'Use spacing.3');
  assert.equal(suggestion(rows[2] as DesignFinding), 'No close token');

  const record = { version: 5, versionHash: current };
  assert.equal(versionLabel({ versionHash: current }, record).text, 'Checked against version 5.');
  assert.equal(
    versionLabel({ versionHash: older }, record).text,
    'Checked against an older version.',
  );
  assert.deepEqual(versionLabel({ versionHash: null }, record), {
    text: 'No check has run.',
    ran: false,
    current: false,
  });
});
