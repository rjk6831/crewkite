import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalyticsThreadRow, AnalyticsTurnRow, ChatAnalyticsRead } from '@crewkite/contracts';
import { analyticsToCsv, csvCell } from './analytics-csv.ts';

// Claim: a saved usage file opens in a spreadsheet as the numbers it holds. A cell that would run
// as a formula is defused, quotes, commas and line breaks survive, Unicode is kept, and an
// unknown value is an empty cell.

/** Read CSV text back the way a spreadsheet does, so the table checks what a person would see. */
function parse(text: string): string[][] {
  const rows: string[][] = [[]];
  let cell = '';
  let quoted = false;
  const body = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      rows.at(-1)?.push(cell);
      cell = '';
    } else if (char === '\r' && body[index + 1] === '\n') {
      rows.at(-1)?.push(cell);
      rows.push([]);
      cell = '';
      index++;
    } else cell += char;
  }
  if (cell !== '' || rows.at(-1)?.length) rows.at(-1)?.push(cell);
  return rows.filter((row) => row.length > 0);
}

test('a cell is encoded so a spreadsheet reads the text and runs no formula', () => {
  const rows: [name: string, value: string | number | null, encoded: string][] = [
    ['plain text', 'review notes', 'review notes'],
    ['unknown is empty', null, ''],
    ['zero stays zero', 0, '0'],
    ['a number', 12.5, '12.5'],
    ['a number that is not finite is empty', Number.NaN, ''],
    ['a comma', 'a,b', '"a,b"'],
    ['a quote', 'say "hi"', '"say ""hi"""'],
    ['a line feed', 'one\ntwo', '"one\ntwo"'],
    ['a carriage return', 'one\rtwo', '"one\rtwo"'],
    ['equals', '=SUM(A1:A9)', "'=SUM(A1:A9)"],
    ['plus', '+1+1', "'+1+1"],
    ['minus', '-2+3', "'-2+3"],
    ['at sign', '@SUM(1)', "'@SUM(1)"],
    ['a tab first', '\t=1', "'\t=1"],
    ['a line feed first', '\n=1+1', '"\'\n=1+1"'],
    ['a return first', '\r=1', '"\'\r=1"'],
    ['a lone line feed first', '\nplain', '"\'\nplain"'],
    ['spaces before an equals sign', '  =1+1', "'  =1+1"],
    ['a space before a plus sign', ' +1', "' +1"],
    ['spaces before an at sign', '   @SUM(1)', "'   @SUM(1)"],
    ['a full-width equals sign', '＝1+1', "'＝1+1"],
    ['a full-width plus sign', '＋1', "'＋1"],
    ['a full-width minus sign', '－1', "'－1"],
    ['a full-width at sign', '＠SUM(1)', "'＠SUM(1)"],
    ['spaces before a full-width sign', ' ＝1', "' ＝1"],
    ['leading spaces before plain text are kept', '  hello', '  hello'],
    ['a sign after text is safe', 'a+b', 'a+b'],
    ['a formula with a comma and a quote', '=HYPERLINK("x","y")', '"\'=HYPERLINK(""x"",""y"")"'],
    ['an equals sign inside is safe', 'a=b', 'a=b'],
    ['Thai text', 'ตรวจโค้ด', 'ตรวจโค้ด'],
    ['emoji and accents', 'café 🚀', 'café 🚀'],
    ['a lone surrogate is repaired', 'a\ud800b', 'a�b'],
    ['empty text', '', ''],
  ];
  for (const [name, value, encoded] of rows) assert.equal(csvCell(value), encoded, name);
});

test('a thread file has a row for each turn and reads back as written', () => {
  const turn = (sequence: number, extra: Partial<AnalyticsTurnRow>): AnalyticsTurnRow => ({
    id: `trn_${String(sequence).padStart(26, '0')}`,
    sequence,
    role: 'assistant',
    family: 'openai',
    model: 'model-a',
    state: 'done',
    startedAt: '2026-10-20T10:00:00.000Z',
    endedAt: '2026-10-20T10:01:00.000Z',
    wallMs: 60_000,
    tokensIn: null,
    tokensOut: null,
    handoffFrom: null,
    allowance: [],
    ...extra,
  });
  const read = {
    scope: 'thread',
    name: '=cmd|"/c calc"!A1, "quoted"\nnew line ตรวจ',
    turnRows: [
      turn(1, { tokensIn: 1000, tokensOut: 0 }),
      turn(2, {
        family: 'anthropic',
        handoffFrom: 'openai',
        allowance: [
          { windowId: 'five-hour', unit: 'percent', consumed: 4 },
          { windowId: '-odd', unit: 'percent', consumed: 0.5 },
        ],
      }),
      turn(3, { state: 'running', endedAt: null, wallMs: null }),
    ],
  } as unknown as ChatAnalyticsRead;
  const text = analyticsToCsv(read);
  assert.ok(text.startsWith('\uFEFFthread,sequence,role,'));
  assert.ok(text.endsWith('\r\n'));
  const rows = parse(text);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.length === rows[0].length));
  assert.equal(rows[1][0], `'=cmd|"/c calc"!A1, "quoted"\nnew line ตรวจ`);
  // Zero tokens read as 0 and an unreported count as an empty cell.
  assert.deepEqual([rows[1][9], rows[1][10], rows[2][9]], ['1000', '0', '']);
  assert.equal(rows[2][11], 'openai');
  assert.equal(rows[2][12], 'five-hour: 4 percent; -odd: 0.5 percent');
  assert.deepEqual([rows[3][7], rows[3][8]], ['', '']);
});

test('a project file has a row for each thread with unknown tokens left empty', () => {
  const thread = (title: string, extra: Partial<AnalyticsThreadRow>): AnalyticsThreadRow => ({
    taskId: `tsk_${String(title.length).padStart(26, '0')}`,
    title,
    turns: 2,
    openTurns: 0,
    handoffs: 1,
    wallMs: 5000,
    tokensIn: null,
    tokensOut: null,
    tokensInTurns: 0,
    tokensOutTurns: 0,
    checksRun: 3,
    checksPassed: 2,
    checksFailed: 1,
    acceptances: 1,
    slices: null,
    ...extra,
  });
  const read = {
    scope: 'project',
    threads: [
      thread('@fix, the "login" page', {
        tokensIn: 7,
        tokensOut: 9,
        tokensInTurns: 1,
        tokensOutTurns: 1,
      }),
      thread('Café 🚀', { slices: { total: 3, done: 2, failed: 1, blocked: 0 } }),
    ],
  } as unknown as ChatAnalyticsRead;
  const rows = parse(analyticsToCsv(read));
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.length === rows[0].length));
  assert.equal(rows[1][0], `'@fix, the "login" page`);
  assert.deepEqual(rows[1].slice(6, 8), ['7', '9']);
  assert.deepEqual(rows[1].slice(14), ['', '', '', '']);
  assert.equal(rows[2][0], 'Café 🚀');
  assert.deepEqual(rows[2].slice(6, 8), ['', '']);
  assert.deepEqual(rows[2].slice(14), ['3', '2', '1', '0']);
});

test('a capped read ends with a row that says what the file leaves out', () => {
  const turn = (sequence: number) => ({
    id: `trn_${String(sequence).padStart(26, '0')}`,
    sequence,
    role: 'assistant',
    family: 'openai',
    model: 'model-a',
    state: 'done',
    startedAt: '2026-10-20T10:00:00.000Z',
    endedAt: '2026-10-20T10:01:00.000Z',
    wallMs: 60_000,
    tokensIn: null,
    tokensOut: null,
    handoffFrom: null,
    allowance: [],
  });
  const thread = (taskId: string) => ({
    taskId,
    title: 'T',
    turns: 1,
    openTurns: 0,
    handoffs: 0,
    wallMs: 0,
    tokensIn: null,
    tokensOut: null,
    tokensInTurns: 0,
    tokensOutTurns: 0,
    checksRun: 0,
    checksPassed: 0,
    checksFailed: 0,
    acceptances: 0,
    slices: null,
  });
  const cases = [
    {
      name: 'a thread that left out turns',
      read: { scope: 'thread', name: 'T', turnRows: [turn(8), turn(9)], turnRowsOmitted: 7 },
      notes: ['7 earlier turns are not in this file. It holds the newest 2.'],
    },
    {
      name: 'a project that left out threads',
      read: {
        scope: 'project',
        threads: [thread('tsk_a'), thread('tsk_b')],
        threadCount: 5,
        gaugeTruncated: false,
      },
      notes: ['3 threads are not in this file. It holds the first 2 by title.'],
    },
    {
      name: 'a gauge read that stopped at its cap',
      read: {
        scope: 'thread',
        name: 'T',
        turnRows: [turn(1)],
        turnRowsOmitted: 0,
        gaugeTruncated: true,
      },
      notes: ['The gauge read stopped at its row cap, so allowance may be missing for some turns.'],
    },
    {
      name: 'a complete read has no note',
      read: {
        scope: 'thread',
        name: 'T',
        turnRows: [turn(1)],
        turnRowsOmitted: 0,
        gaugeTruncated: false,
      },
      notes: [],
    },
  ];
  for (const { name, read, notes } of cases) {
    const rows = parse(analyticsToCsv(read as unknown as ChatAnalyticsRead));
    const table =
      read.scope === 'thread' ? (read.turnRows?.length ?? 0) : (read.threads?.length ?? 0);
    assert.equal(rows.length, 1 + table + notes.length, name);
    assert.ok(
      rows.every((row) => row.length === rows[0].length),
      name,
    );
    assert.deepEqual(
      rows.slice(1 + table).map((row) => row[0]),
      notes,
      name,
    );
    assert.ok(
      rows.slice(1 + table).every((row) => row.slice(1).every((cell) => cell === '')),
      name,
    );
  }
});
