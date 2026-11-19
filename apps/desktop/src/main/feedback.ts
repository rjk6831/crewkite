import { arch, release, type } from 'node:os';
import { app, type BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import { redactDiagnosticText } from '../../../controller/src/diagnostics/redact.ts';
import {
  buildReport,
  type FeedbackFacts,
  issueUrl,
  MAX_REPORT,
  parseDraft,
} from './feedback-report.ts';
import { assertSender } from './security.ts';

// The feedback handlers. The report logic is in feedback-report.ts so tests can reach it without
// Electron.

function facts(): FeedbackFacts {
  return { app: app.getVersion(), os: `${type()} ${release()} ${arch()}` };
}

export function installFeedback(window: BrowserWindow) {
  ipcMain.handle('crewkite:feedback-draft', (event, input: unknown) => {
    assertSender(event, window);
    const draft = parseDraft(input);
    if (!draft) throw new Error('The feedback request is invalid.');
    return buildReport(draft, facts());
  });
  ipcMain.handle('crewkite:feedback-send', async (event, input: unknown) => {
    assertSender(event, window);
    const { report, to } = (input ?? {}) as { report?: unknown; to?: unknown };
    if (typeof report !== 'string' || report.length > MAX_REPORT) return 'refused';
    if (to === 'copy') {
      clipboard.writeText(redactDiagnosticText(report));
      return 'done';
    }
    if (to !== 'github') return 'refused';
    try {
      await shell.openExternal(issueUrl(report));
      return 'done';
    } catch {
      return 'refused';
    }
  });
}
