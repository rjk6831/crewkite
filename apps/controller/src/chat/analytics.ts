import {
  ANALYTICS_MAX_THREADS,
  ANALYTICS_MAX_TURNS,
  type AnalyticsAllowance,
  type AnalyticsFamily,
  type AnalyticsThreadRow,
  type AnalyticsTurnRow,
  type ChatAnalyticsRead,
  ChatAnalyticsReadSchema,
  type ChatFamily,
  ChatFamilySchema,
  type ChatThread,
  ChatThreadSchema,
  type ChatTurn,
  ChatTurnSchema,
  ObservationSchema,
  type Project,
  type ReadChatAnalyticsPayload,
  type Route,
  type Task,
  UsageReaderSchema,
} from '@crewkite/contracts';
import type { Store } from '../store/index.ts';

// Usage analytics for a thread or a project (ADR 0002: the controller reads its own records and
// the desktop and CLI only show the result). Nothing here writes, sends or starts a process.
// Every number comes from rows the controller already keeps: the chat turns, the thread record,
// the journal of thread events and the gauge readings. A value no client reported stays null.

/**
 * How far from a turn a gauge reading may sit and still bracket it. A reading older than this
 * would charge the turn for whatever else drew on the allowance in between.
 */
export const BRACKET_MS = 15 * 60 * 1000;
const FAMILIES: readonly ChatFamily[] = ChatFamilySchema.options;
const MAX_WINDOWS = 16;

type Reading = {
  value: number;
  unit: AnalyticsAllowance['unit'];
  resetsAt: string | null;
  at: number;
};
type Span = { id: string; start: number; end: number | null };

type ThreadFacts = {
  row: AnalyticsThreadRow;
  families: AnalyticsFamily[];
  turnRows: AnalyticsTurnRow[];
};

type Gauge = {
  /** Readings of one window of one family, oldest first. */
  windows: Map<ChatFamily, Map<string, Reading[]>>;
  /** Every turn of every thread by family, so a bracket shared with another turn is refused. */
  spans: Map<ChatFamily, Span[]>;
};

const seconds = (value: string | null) => (value === null ? Number.NaN : Date.parse(value));
const round = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * The gauge's readings and every turn's span. shortcut: this scans the journal's task-less usage
 * events once per read. Upgrade: an indexed event type column, and a cursor bound from the first
 * turn of the thread.
 */
function loadGauge(store: Store): Gauge {
  const routes = new Map<string, ChatFamily | undefined>();
  const familyOf = (routeId: string) => {
    if (!routes.has(routeId)) routes.set(routeId, store.get<Route>('route', routeId)?.family);
    return routes.get(routeId);
  };
  const windows: Gauge['windows'] = new Map();
  const add = (family: ChatFamily, windowId: string, reading: Reading) => {
    const byWindow = windows.get(family) ?? new Map<string, Reading[]>();
    windows.set(family, byWindow);
    const list = byWindow.get(windowId) ?? [];
    byWindow.set(windowId, list);
    list.push(reading);
  };
  const rows = store.db
    .prepare(
      "SELECT json_extract(body,'$.type') AS type, json_extract(body,'$.payload') AS payload FROM events WHERE task_id IS NULL AND json_extract(body,'$.type') IN ('usage.observed','usage.reader-updated') ORDER BY cursor",
    )
    .all();
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload as string);
    } catch {
      continue;
    }
    if (row.type === 'usage.observed') {
      const parsed = ObservationSchema.safeParse(payload);
      if (!parsed.success || parsed.data.remaining === null) continue;
      const family = familyOf(parsed.data.routeId);
      if (!family) continue;
      add(family, parsed.data.windowId, {
        value: parsed.data.remaining.value,
        unit: parsed.data.remaining.unit,
        resetsAt: parsed.data.resetsAt,
        at: Date.parse(parsed.data.observedAt),
      });
      continue;
    }
    // The Anthropic client reports windows with each turn's rate limit frame. They carry the time
    // the controller received them and no observation time.
    const reader = UsageReaderSchema.safeParse(payload);
    const reading =
      reader.success && reader.data.family === 'anthropic' ? reader.data.reading : null;
    if (reading?.status !== 'reported') continue;
    for (const window of reading.windows)
      add('anthropic', window.windowId, {
        value: window.remaining.value,
        unit: window.remaining.unit,
        resetsAt: window.resetsAt,
        at: Date.parse(reading.receivedAt),
      });
  }
  for (const byWindow of windows.values())
    for (const list of byWindow.values()) list.sort((left, right) => left.at - right.at);
  const spans: Gauge['spans'] = new Map();
  for (const row of store.db
    .prepare(
      "SELECT id, json_extract(body,'$.selection.family') AS family, json_extract(body,'$.startedAt') AS started, json_extract(body,'$.endedAt') AS ended FROM chat_turns",
    )
    .all()) {
    const family = ChatFamilySchema.safeParse(row.family);
    if (!family.success) continue;
    const list = spans.get(family.data) ?? [];
    spans.set(family.data, list);
    list.push({
      id: row.id as string,
      start: seconds(row.started as string),
      end: row.ended === null ? null : seconds(row.ended as string),
    });
  }
  return { windows, spans };
}

/**
 * What one turn cost one window, or null when the controller cannot say. It says only when a
 * reading just before the turn and one just after it agree on the window's reset, the allowance
 * did not rise, and no other turn on the family overlapped the two readings. Use outside CrewKite
 * between the readings still counts, which the docs say.
 */
function measure(turn: ChatTurn, windowId: string, gauge: Gauge): number | null {
  const list = gauge.windows.get(turn.selection.family)?.get(windowId) ?? [];
  const start = seconds(turn.startedAt);
  const end = seconds(turn.endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const before = list.findLast((reading) => reading.at <= start);
  const after = list.find((reading) => reading.at >= end);
  if (!before || !after) return null;
  if (start - before.at > BRACKET_MS || after.at - end > BRACKET_MS) return null;
  if (before.unit !== after.unit || before.resetsAt !== after.resetsAt) return null;
  if (before.unit !== windowUnit(gauge, turn.selection.family, windowId)) return null;
  if (after.value > before.value) return null;
  // A turn whose time cannot be read counts as overlapping, so the bracket is refused.
  const shared = (gauge.spans.get(turn.selection.family) ?? []).some((other) => {
    const startsInside = !(other.start >= after.at);
    const endsInside = other.end === null || !(other.end <= before.at);
    return other.id !== turn.id && startsInside && endsInside;
  });
  if (shared) return null;
  return round(before.value - after.value);
}

function windowIds(gauge: Gauge, family: ChatFamily): string[] {
  return [...(gauge.windows.get(family)?.keys() ?? [])].sort().slice(0, MAX_WINDOWS);
}

/** The unit a window reports in, from its newest reading. */
const windowUnit = (gauge: Gauge, family: ChatFamily, windowId: string) =>
  gauge.windows.get(family)?.get(windowId)?.at(-1)?.unit;

const sum = (values: readonly (number | null)[]) => {
  const reported = values.filter((value): value is number => value !== null);
  return reported.length === 0 ? null : reported.reduce((total, value) => total + value, 0);
};

function readThread(store: Store, task: Task, gauge: Gauge): ThreadFacts | null {
  const stored = store.db.prepare('SELECT body FROM chat_threads WHERE task_id=?').get(task.id);
  if (!stored) return null;
  const thread: ChatThread = ChatThreadSchema.parse(JSON.parse(stored.body as string));
  const turns = store.db
    .prepare('SELECT body FROM chat_turns WHERE task_id=? ORDER BY sequence')
    .all(task.id)
    .map((row) => ChatTurnSchema.parse(JSON.parse(row.body as string)));

  const turnRows: AnalyticsTurnRow[] = [];
  // Per family and window, one entry for each turn: its measure, or null when it has none.
  const familyMeasures = new Map<ChatFamily, Map<string, (number | null)[]>>();
  for (const turn of turns) {
    const family = turn.selection.family;
    const settled = turn.endedAt !== null;
    const wall = settled ? Math.max(0, seconds(turn.endedAt) - seconds(turn.startedAt)) : null;
    const byWindow = familyMeasures.get(family) ?? new Map<string, (number | null)[]>();
    familyMeasures.set(family, byWindow);
    const allowance: AnalyticsTurnRow['allowance'] = [];
    for (const windowId of windowIds(gauge, family)) {
      const consumed = settled ? measure(turn, windowId, gauge) : null;
      byWindow.set(windowId, [...(byWindow.get(windowId) ?? []), consumed]);
      const unit = windowUnit(gauge, family, windowId);
      if (consumed !== null && unit) allowance.push({ windowId, unit, consumed });
    }
    turnRows.push({
      id: turn.id,
      sequence: turn.sequence,
      role: turn.role,
      family,
      model: turn.selection.model,
      state: turn.state,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      wallMs: wall !== null && Number.isFinite(wall) ? wall : null,
      tokensIn: turn.stats?.tokensIn ?? null,
      tokensOut: turn.stats?.tokensOut ?? null,
      handoffFrom: turn.handoffFrom,
      allowance,
    });
  }

  const families: AnalyticsFamily[] = FAMILIES.flatMap((family) => {
    const own = turnRows.filter((row) => row.family === family);
    if (own.length === 0) return [];
    const allowance = [...(familyMeasures.get(family) ?? [])].flatMap(([windowId, values]) => {
      const unit = windowUnit(gauge, family, windowId);
      if (!unit) return [];
      const measured = values.filter((value) => value !== null);
      return [
        {
          windowId,
          unit,
          consumed: sum(values),
          measuredTurns: measured.length,
          unmeasuredTurns: values.length - measured.length,
        },
      ];
    });
    return [
      {
        family,
        turns: own.length,
        wallMs: own.reduce((total, row) => total + (row.wallMs ?? 0), 0),
        tokensIn: sum(own.map((row) => row.tokensIn)),
        tokensOut: sum(own.map((row) => row.tokensOut)),
        tokenTurns: own.filter((row) => row.tokensIn !== null || row.tokensOut !== null).length,
        allowance,
      },
    ];
  });

  // The thread record keeps the newest nine check runs and the last acceptance. The journal holds
  // every version of the record, so earlier runs and branches are counted from there.
  const runs = new Map<string, string>();
  for (const row of store.db
    .prepare(
      "SELECT json_extract(r.value,'$.id') AS id, json_extract(r.value,'$.status') AS status FROM events e, json_each(e.body,'$.payload.checks.runs') r WHERE e.task_id=? AND json_extract(e.body,'$.type')='chat.thread' ORDER BY e.cursor, r.key",
    )
    .all(task.id))
    runs.set(row.id as string, row.status as string);
  for (const run of thread.checks?.runs ?? []) runs.set(run.id, run.status);
  const branches = new Set<string>();
  for (const row of store.db
    .prepare(
      "SELECT DISTINCT json_extract(body,'$.payload.lastAcceptance.branch') AS branch, json_extract(body,'$.payload.lastAcceptance.at') AS at FROM events WHERE task_id=? AND json_extract(body,'$.type')='chat.thread' AND json_extract(body,'$.payload.lastAcceptance.at') IS NOT NULL",
    )
    .all(task.id))
    branches.add(`${row.branch}\0${row.at}`);
  if (thread.lastAcceptance)
    branches.add(`${thread.lastAcceptance.branch}\0${thread.lastAcceptance.at}`);

  const statuses = [...runs.values()];
  const slices = thread.plan?.slices;
  const row: AnalyticsThreadRow = {
    taskId: task.id,
    title: task.title,
    turns: turns.length,
    openTurns: turns.filter((turn) => turn.endedAt === null).length,
    handoffs: turns.filter((turn) => turn.handoffFrom && turn.handoffFrom !== turn.selection.family)
      .length,
    wallMs: families.reduce((total, family) => total + family.wallMs, 0),
    tokensIn: sum(turnRows.map((turnRow) => turnRow.tokensIn)),
    tokensOut: sum(turnRows.map((turnRow) => turnRow.tokensOut)),
    tokenTurns: families.reduce((total, family) => total + family.tokenTurns, 0),
    checksRun: statuses.length,
    checksPassed: statuses.filter((status) => status === 'passed').length,
    checksFailed: statuses.filter((status) => status === 'failed').length,
    branchesAccepted: branches.size,
    slices: slices
      ? {
          total: slices.length,
          done: slices.filter((slice) => slice.status === 'done').length,
          failed: slices.filter((slice) => slice.status === 'failed').length,
          blocked: slices.filter((slice) => slice.status === 'blocked').length,
        }
      : null,
  };
  return { row, families, turnRows };
}

/** Add the thread families into a running per-family total. */
function mergeFamilies(
  total: Map<ChatFamily, AnalyticsFamily>,
  families: readonly AnalyticsFamily[],
) {
  for (const family of families) {
    const held = total.get(family.family);
    if (!held) {
      total.set(family.family, structuredClone(family));
      continue;
    }
    held.turns += family.turns;
    held.wallMs += family.wallMs;
    held.tokensIn = sum([held.tokensIn, family.tokensIn]);
    held.tokensOut = sum([held.tokensOut, family.tokensOut]);
    held.tokenTurns += family.tokenTurns;
    for (const entry of family.allowance) {
      const same = held.allowance.find(
        (value) => value.windowId === entry.windowId && value.unit === entry.unit,
      );
      if (!same) held.allowance.push(structuredClone(entry));
      else {
        same.consumed = sum([same.consumed, entry.consumed]);
        same.measuredTurns += entry.measuredTurns;
        same.unmeasuredTurns += entry.unmeasuredTurns;
      }
    }
    held.allowance.sort((left, right) => left.windowId.localeCompare(right.windowId));
  }
}

/**
 * The analytics of one thread or of every thread of a project. Null when the task or the project
 * is not there. A project lists its threads by title and counts all of them past the list cap.
 */
export function readAnalytics(
  store: Store,
  payload: ReadChatAnalyticsPayload,
  readAt: string,
): ChatAnalyticsRead | null {
  const gauge = loadGauge(store);
  let tasks: Task[];
  let name: string;
  let id: string;
  if (payload.scope === 'thread') {
    const task = store.get<Task>('task', payload.taskId);
    if (!task) return null;
    tasks = [task];
    name = task.title;
    id = task.id;
  } else {
    const project = store.get<Project>('project', payload.projectId);
    if (!project) return null;
    tasks = store
      .list<Task>('task')
      .filter((task) => task.projectId === project.id)
      .sort(
        (left, right) => left.title.localeCompare(right.title) || (left.id < right.id ? -1 : 1),
      );
    name = project.name;
    id = project.id;
  }
  const facts = tasks.flatMap((task) => readThread(store, task, gauge) ?? []);
  const rows = facts.map((fact) => fact.row);
  const families = new Map<ChatFamily, AnalyticsFamily>();
  for (const fact of facts) mergeFamilies(families, fact.families);
  const planned = rows.flatMap((row) => row.slices ?? []);
  const total = (pick: (row: AnalyticsThreadRow) => number) =>
    rows.reduce((value, row) => value + pick(row), 0);
  const turnRows = payload.scope === 'thread' ? (facts[0]?.turnRows ?? []) : [];
  return ChatAnalyticsReadSchema.parse({
    scope: payload.scope,
    id,
    name,
    readAt,
    turns: total((row) => row.turns),
    openTurns: total((row) => row.openTurns),
    handoffs: total((row) => row.handoffs),
    wallMs: total((row) => row.wallMs),
    tokensIn: sum(rows.map((row) => row.tokensIn)),
    tokensOut: sum(rows.map((row) => row.tokensOut)),
    tokenTurns: total((row) => row.tokenTurns),
    checksRun: total((row) => row.checksRun),
    checksPassed: total((row) => row.checksPassed),
    checksFailed: total((row) => row.checksFailed),
    branchesAccepted: total((row) => row.branchesAccepted),
    slices:
      planned.length === 0
        ? null
        : {
            total: planned.reduce((value, slices) => value + slices.total, 0),
            done: planned.reduce((value, slices) => value + slices.done, 0),
            failed: planned.reduce((value, slices) => value + slices.failed, 0),
            blocked: planned.reduce((value, slices) => value + slices.blocked, 0),
          },
    families: FAMILIES.flatMap((family) => families.get(family) ?? []),
    threads: payload.scope === 'project' ? rows.slice(0, ANALYTICS_MAX_THREADS) : [],
    threadCount: rows.length,
    turnRows: turnRows.slice(-ANALYTICS_MAX_TURNS),
    turnRowsTruncated: turnRows.length > ANALYTICS_MAX_TURNS,
  });
}
