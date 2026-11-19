import {
  type DesignFinding,
  type DesignFindings,
  type DesignSystemRecord,
  MAX_DESIGN_FINDINGS,
  type TokenGroup,
} from '@crewkite/contracts';

// How the Design tab words and orders a thread's findings. The controller keeps the state; this
// file only decides what each row says and where it sits.

export const RULE_LABELS: Record<DesignFinding['rule'], string> = {
  'raw-color': 'Raw color',
  'off-scale-spacing': 'Spacing off the scale',
  'unknown-font': 'Unknown font',
  'off-scale-radius': 'Radius off the scale',
  'unknown-shadow': 'Unknown shadow',
};

/** The token group a new token for the finding's value belongs to. */
export const RULE_GROUP: Record<DesignFinding['rule'], TokenGroup> = {
  'raw-color': 'color',
  'off-scale-spacing': 'spacing',
  'unknown-font': 'type',
  'off-scale-radius': 'radius',
  'unknown-shadow': 'shadow',
};

// Rows that still need a decision come first, then the ones on their way, then the settled ones.
const STATE_ORDER: Record<DesignFinding['state'], number> = {
  open: 0,
  sent: 1,
  allowed: 2,
  updated: 3,
  resolved: 4,
};

/** A finding whose value the person chose to add to the system, before a saved version holds it. */
export const draftOpen = (finding: DesignFinding) =>
  finding.state === 'open' && finding.reason?.startsWith('Draft open') === true;

/** Files by path, each with its open count and its rows: open first, then by line. */
export function groupFindings(findings: readonly DesignFinding[]) {
  const files = new Map<string, DesignFinding[]>();
  for (const finding of findings)
    files.set(finding.file, [...(files.get(finding.file) ?? []), finding]);
  return [...files]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([file, rows]) => ({
      file,
      open: rows.filter((row) => row.state === 'open').length,
      rows: rows.toSorted(
        (left, right) =>
          STATE_ORDER[left.state] - STATE_ORDER[right.state] || left.line - right.line,
      ),
    }));
}

/** Open findings per file, for the counts beside each file in Changes. */
export function openByFile(findings: readonly DesignFinding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const finding of findings)
    if (finding.state === 'open') counts.set(finding.file, (counts.get(finding.file) ?? 0) + 1);
  return counts;
}

/** The line under a row that says what happened to it. An open row has none. */
export function stateLine(finding: DesignFinding): string | null {
  switch (finding.state) {
    case 'open':
      return draftOpen(finding) ? 'Draft open.' : null;
    case 'sent':
      return 'Sent to the fixer.';
    case 'allowed':
      return `Allowed: ${finding.reason ?? ''}`;
    case 'updated':
      return finding.reason ?? 'A saved version holds this value.';
    case 'resolved':
      return 'No longer in the file.';
  }
}

export const suggestion = (finding: DesignFinding) =>
  finding.nearestToken ? `Use ${finding.nearestToken}` : 'No close token';

/**
 * Which version the list was checked against. The number shows only when the check used the
 * version saved now; a check against any other version says so, and the person runs it again.
 */
export function versionLabel(
  read: Pick<DesignFindings, 'versionHash'> | null,
  record: Pick<DesignSystemRecord, 'version' | 'versionHash'> | null,
): { text: string; ran: boolean; current: boolean } {
  if (!read?.versionHash) return { text: 'No check has run.', ran: false, current: false };
  if (record && read.versionHash === record.versionHash)
    return { text: `Checked against version ${record.version}.`, ran: true, current: true };
  return { text: 'Checked against an older version.', ran: true, current: false };
}

/** The controller stops at 500 rows and sends no flag, so a full list is the signal. */
export const capped = (findings: readonly DesignFinding[]) =>
  findings.length >= MAX_DESIGN_FINDINGS;
