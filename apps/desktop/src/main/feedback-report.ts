import { redactDiagnosticText } from '../../../controller/src/diagnostics/redact.ts';
import { ISSUE_URL } from '../shared/feedback.ts';

// Voluntary feedback. The person writes what happened, picks which version lines to add, reads
// the exact report and sends it themselves: copied to the clipboard, or as a new GitHub issue in
// their browser. Nothing is uploaded from here, and the report never holds source, transcripts or
// identifiers.

// The title and body ride on the issue address as URL parameters.
export { ISSUE_URL };

const MAX_WHAT = 4000;
export const MAX_REPORT = 8000;
const MAX_TITLE = 80;
// GitHub refuses very long addresses, so the encoded link stays well below its limit.
const MAX_URL = 6000;
const MAX_CLIENTS = 8;

export type FeedbackDraft = {
  what: string;
  app: boolean;
  os: boolean;
  /** One entry per provider client, such as "OpenAI 0.5.1". Used only when `clients` is on. */
  clients: boolean;
  clientVersions: string[];
};

export type FeedbackFacts = { app: string; os: string };

/** The draft a page sent, or null when it does not have this shape. */
export function parseDraft(value: unknown): FeedbackDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { what, app, os, clients, clientVersions } = value as Record<string, unknown>;
  if (typeof what !== 'string' || what.length > MAX_WHAT) return null;
  if (typeof app !== 'boolean' || typeof os !== 'boolean' || typeof clients !== 'boolean')
    return null;
  if (
    !Array.isArray(clientVersions) ||
    clientVersions.length > MAX_CLIENTS ||
    clientVersions.some((item) => typeof item !== 'string' || item.length > 120)
  )
    return null;
  return { what, app, os, clients, clientVersions: clientVersions as string[] };
}

/** The report text. Only what the person wrote and the lines they ticked. */
export function buildReport(draft: FeedbackDraft, facts: FeedbackFacts): string {
  const lines = [
    '## What happened',
    '',
    redactDiagnosticText(draft.what.trim()) || '(nothing written yet)',
  ];
  const details = [
    ...(draft.app ? [`App: ${facts.app}`] : []),
    ...(draft.os ? [`OS: ${facts.os}`] : []),
    ...(draft.clients && draft.clientVersions.length > 0
      ? [`Clients: ${draft.clientVersions.join(', ')}`]
      : []),
  ];
  if (details.length > 0) lines.push('', '## Versions', '', ...details);
  return redactDiagnosticText(lines.join('\n'));
}

/** The new-issue address for a report. The report was edited by hand, so it is redacted again. */
export function issueUrl(report: string): string {
  const text = redactDiagnosticText(report).slice(0, MAX_REPORT);
  const first = text.split('\n').find((line) => line.trim() !== '' && !line.startsWith('#')) ?? '';
  const title = first.trim().slice(0, MAX_TITLE) || 'Feedback';
  const note = '\n\n[Cut to fit the address. Paste the full report from Copy report.]';
  const make = (body: string) => `${ISSUE_URL}?${new URLSearchParams({ title, body }).toString()}`;
  if (make(text).length <= MAX_URL) return make(text);
  let keep = text.length;
  while (keep > 0 && make(text.slice(0, keep).trimEnd() + note).length > MAX_URL) keep -= 200;
  return make(text.slice(0, Math.max(keep, 0)).trimEnd() + note);
}
