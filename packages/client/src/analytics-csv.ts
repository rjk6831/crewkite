import type { ChatAnalyticsRead } from '@crewkite/contracts';

// The CSV the desktop and the command line save for a usage read. One table per file: a thread
// writes a row for each turn and a project writes a row for each thread. An empty cell means the
// value is unknown. It never stands for zero.

// A spreadsheet runs a cell that starts with one of these as a formula.
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell. Null is empty. Text that a spreadsheet would run as a formula gets a leading
 * single quote. A cell with a quote, comma or line break is wrapped in quotes with the quotes
 * doubled.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = value.toWellFormed();
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const line = (cells: readonly (string | number | null)[]) => cells.map(csvCell).join(',');

const turnColumns = [
  'thread',
  'sequence',
  'role',
  'family',
  'model',
  'state',
  'started_at',
  'ended_at',
  'wall_ms',
  'tokens_in',
  'tokens_out',
  'handoff_from',
  'allowance',
];
const threadColumns = [
  'thread',
  'thread_id',
  'turns',
  'open_turns',
  'handoffs',
  'wall_ms',
  'tokens_in',
  'tokens_out',
  'token_turns',
  'checks_run',
  'checks_passed',
  'checks_failed',
  'branches_accepted',
  'slices_total',
  'slices_done',
  'slices_failed',
  'slices_blocked',
];

/**
 * The file for a read, with a byte order mark so a spreadsheet reads the text as UTF-8 and lines
 * that end in CRLF as the format says. The measured allowance of a turn is one cell, as
 * `window: amount unit` entries joined by semicolons.
 */
export function analyticsToCsv(read: ChatAnalyticsRead): string {
  const rows =
    read.scope === 'thread'
      ? [
          line(turnColumns),
          ...read.turnRows.map((turn) =>
            line([
              read.name,
              turn.sequence,
              turn.role,
              turn.family,
              turn.model,
              turn.state,
              turn.startedAt,
              turn.endedAt,
              turn.wallMs,
              turn.tokensIn,
              turn.tokensOut,
              turn.handoffFrom,
              turn.allowance.length === 0
                ? null
                : turn.allowance
                    .map((entry) => `${entry.windowId}: ${entry.consumed} ${entry.unit}`)
                    .join('; '),
            ]),
          ),
        ]
      : [
          line(threadColumns),
          ...read.threads.map((thread) =>
            line([
              thread.title,
              thread.taskId,
              thread.turns,
              thread.openTurns,
              thread.handoffs,
              thread.wallMs,
              thread.tokensIn,
              thread.tokensOut,
              thread.tokenTurns,
              thread.checksRun,
              thread.checksPassed,
              thread.checksFailed,
              thread.branchesAccepted,
              thread.slices?.total ?? null,
              thread.slices?.done ?? null,
              thread.slices?.failed ?? null,
              thread.slices?.blocked ?? null,
            ]),
          ),
        ];
  return `﻿${rows.join('\r\n')}\r\n`;
}
