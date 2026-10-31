import {
  ANALYTICS_MAX_THREADS,
  ANALYTICS_MAX_TURNS,
  ANALYTICS_MAX_WINDOWS,
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
/** The most gauge readings and the most turn spans one read loads. Past it the read says so. */
export const GAUGE_ROW_CAP = 20_000;
const FAMILIES: readonly ChatFamily[] = ChatFamilySchema.options;

type Reading = {
  value: number;
  unit: AnalyticsAllowance['unit'];
  resetsAt: string | null;
  at: number;
};
type Span = { id: string; start: number; end: number | null };
type Loaded = { task: Task; thread: ChatThread; turns: ChatTurn[] };

type ThreadFacts = {
  row: AnalyticsThreadRow;
  families: AnalyticsFamily[];
  turnRows: AnalyticsTurnRow[];
};

type Gauge = {
  /** Readings of one window of one family, oldest first. */
  windows: Map<ChatFamily, Map<string, Reading[]>>;
  /** The windows a family reports, newest reading first and cut at the cap. */
  shown: Map<ChatFamily, { ids: string[]; omitted: number }>;
  /** Every turn of the project by family, so a bracket shared with another turn is refused. */
  spans: Map<ChatFamily, Span[]>;
  /** A cap stopped the load, so some turns may be unmeasured. */
  truncated: boolean;
  /** Rows the journal query returned, for the test that proves unrelated rows stay unread. */
  rows: number;
};

const seconds = (value: string | null) => (value === null ? Number.NaN : Date.parse(value));
const round = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * Readings of the gauge and the spans of the project's turns. Only the rows that can bracket a
 * turn of this read are loaded: journal rows from the first entry of the requested threads on,
 * with a reading time between the first turn's start and the last turn's end, each widened by one
 * bracket. Readings taken before a thread's first journal entry are not used, so the first turn
 * of a new thread is often unmeasured. The query stops at GAUGE_ROW_CAP rows and says so.
 */
function loadGauge(
  store: Store,
  scope: { projectId: string; fromCursor: string | null; first: number; last: number },
): Gauge {
  const gauge: Gauge = {
    windows: new Map(),
    shown: new Map(),
    spans: new Map(),
    truncated: false,
    rows: 0,
  };
  const routes = new Map<string, ChatFamily | undefined>();
  const familyOf = (routeId: string) => {
    if (!routes.has(routeId)) routes.set(routeId, store.get<Route>('route', routeId)?.family);
    return routes.get(routeId);
  };
  const add = (family: ChatFamily, windowId: string, reading: Reading) => {
    const byWindow = gauge.windows.get(family) ?? new Map<string, Reading[]>();
    gauge.windows.set(family, byWindow);
    const list = byWindow.get(windowId) ?? [];
    byWindow.set(windowId, list);
    list.push(reading);
  };
  if (scope.fromCursor !== null) {
    const rows = store.db
      .prepare(
        `SELECT json_extract(body,'$.type') AS type, json_extract(body,'$.payload') AS payload
         FROM events
         WHERE task_id IS NULL AND cursor>=?
           AND json_extract(body,'$.type') IN ('usage.observed','usage.reader-updated')
           AND julianday(COALESCE(json_extract(body,'$.payload.observedAt'),
                                  json_extract(body,'$.payload.reading.receivedAt')))
               BETWEEN julianday(?) AND julianday(?)
         ORDER BY cursor LIMIT ?`,
      )
      .all(
        BigInt(scope.fromCursor),
        new Date(scope.first - BRACKET_MS).toISOString(),
        new Date(scope.last + BRACKET_MS).toISOString(),
        GAUGE_ROW_CAP + 1,
      );
    gauge.rows = Math.min(rows.length, GAUGE_ROW_CAP);
    if (rows.length > GAUGE_ROW_CAP) gauge.truncated = true;
    for (const row of rows.slice(0, GAUGE_ROW_CAP)) {
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
      // The anthropic family reports windows with each turn's rate limit frame. They carry the time
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
  }
  for (const [family, byWindow] of gauge.windows) {
    for (const list of byWindow.values()) list.sort((left, right) => left.at - right.at);
    const ordered = [...byWindow]
      .map(([id, list]) => ({ id, newest: list.at(-1)?.at ?? 0 }))
      .sort((left, right) => right.newest - left.newest || left.id.localeCompare(right.id));
    gauge.shown.set(family, {
      ids: ordered.slice(0, ANALYTICS_MAX_WINDOWS).map(({ id }) => id),
      omitted: Math.max(0, ordered.length - ANALYTICS_MAX_WINDOWS),
    });
  }
  // Turns of other threads in the same project, which can overlap a bracket. Turns of other
  // projects are not considered.
  const spans = store.db
    .prepare(
      `SELECT id, json_extract(body,'$.selection.family') AS family,
         json_extract(body,'$.startedAt') AS started, json_extract(body,'$.endedAt') AS ended
       FROM chat_turns WHERE task_id IN
         (SELECT id FROM entities WHERE kind='task' AND json_extract(body,'$.projectId')=?)
       LIMIT ?`,
    )
    .all(scope.projectId, GAUGE_ROW_CAP + 1);
  if (spans.length > GAUGE_ROW_CAP) gauge.truncated = true;
  for (const row of spans.slice(0, GAUGE_ROW_CAP)) {
    const family = ChatFamilySchema.safeParse(row.family);
    if (!family.success) continue;
    const list = gauge.spans.get(family.data) ?? [];
    gauge.spans.set(family.data, list);
    list.push({
      id: row.id as string,
      start: seconds(row.started as string),
      end: row.ended === null ? null : seconds(row.ended as string),
    });
  }
  // Without every span a bracket cannot be proved to stand alone, so nothing is measured.
  if (spans.length > GAUGE_ROW_CAP) gauge.windows.clear();
  return gauge;
}

/** The unit a window reports in, from its newest reading. */
const windowUnit = (gauge: Gauge, family: ChatFamily, windowId: string) =>
  gauge.windows.get(family)?.get(windowId)?.at(-1)?.unit;

/**
 * What one turn cost one window, or null when the controller cannot say. It says only when a
 * reading just before the turn and one just after it agree on the window's reset, the allowance
 * did not rise, and no other turn of the project on the family overlapped the two readings. Use
 * outside CrewKite between the readings still counts, and so does a task run, which is not a
 * chat turn and is not checked for overlap.
 */
function measure(
  turn: { id: string; family: ChatFamily; start: number; end: number },
  windowId: string,
  gauge: Gauge,
): number | null {
  const list = gauge.windows.get(turn.family)?.get(windowId) ?? [];
  if (Number.isNaN(turn.start) || Number.isNaN(turn.end)) return null;
  const before = list.findLast((reading) => reading.at <= turn.start);
  const after = list.find((reading) => reading.at >= turn.end);
  if (!before || !after) return null;
  if (turn.start - before.at > BRACKET_MS || after.at - turn.end > BRACKET_MS) return null;
  if (before.unit !== after.unit || before.resetsAt !== after.resetsAt) return null;
  if (before.unit !== windowUnit(gauge, turn.family, windowId)) return null;
  if (after.value > before.value) return null;
  // A turn whose time cannot be read counts as overlapping, so the bracket is refused.
  const shared = (gauge.spans.get(turn.family) ?? []).some((other) => {
    const startsInside = !(other.start >= after.at);
    const endsInside = other.end === null || !(other.end <= before.at);
    return other.id !== turn.id && startsInside && endsInside;
  });
  if (shared) return null;
  return round(before.value - after.value);
}

/** A sum of the reported values, null when none was reported. */
const sum = (values: readonly (number | null)[]) => {
  const reported = values.filter((value): value is number => value !== null);
  return reported.length === 0 ? null : round(reported.reduce((total, value) => total + value, 0));
};

/**
 * When a settled turn really ended, in milliseconds, or null when that cannot be told. A turn that
 * startup recovery failed is stamped with the time of the restart, which counts the controller's
 * downtime. Its journal has no turn.completed, so it ends at its last agent event.
 */
function endOf(store: Store, turn: ChatTurn): number | null {
  if (turn.endedAt === null) return null;
  const stored = seconds(turn.endedAt);
  if (turn.state !== 'failed' || turn.failure?.kind !== 'internal') return stored;
  const last = store.db
    .prepare(
      "SELECT json_extract(body,'$.payload.type') AS type, json_extract(body,'$.at') AS at FROM events WHERE task_id=? AND json_extract(body,'$.type')='agent.event' AND json_extract(body,'$.payload.turnId')=? ORDER BY cursor DESC LIMIT 1",
    )
    .get(turn.taskId, turn.id);
  if (!last) return null;
  if (last.type === 'turn.completed') return stored;
  const lastAt = seconds(last.at as string);
  return Number.isNaN(lastAt) ? null : Math.max(lastAt, seconds(turn.startedAt));
}

function loadThread(store: Store, task: Task): Loaded | null {
  const stored = store.db.prepare('SELECT body FROM chat_threads WHERE task_id=?').get(task.id);
  if (!stored) return null;
  return {
    task,
    thread: ChatThreadSchema.parse(JSON.parse(stored.body as string)),
    turns: store.db
      .prepare('SELECT body FROM chat_turns WHERE task_id=? ORDER BY sequence')
      .all(task.id)
      .map((row) => ChatTurnSchema.parse(JSON.parse(row.body as string))),
  };
}

function readThread(store: Store, { task, thread, turns }: Loaded, gauge: Gauge): ThreadFacts {
  const turnRows: AnalyticsTurnRow[] = [];
  // Per family and window, one entry for each turn: its measure, or null when it has none.
  const familyMeasures = new Map<ChatFamily, Map<string, (number | null)[]>>();
  for (const turn of turns) {
    const family = turn.selection.family;
    const start = seconds(turn.startedAt);
    const end = endOf(store, turn);
    const wall = end === null ? null : Math.max(0, end - start);
    const byWindow = familyMeasures.get(family) ?? new Map<string, (number | null)[]>();
    familyMeasures.set(family, byWindow);
    const allowance: AnalyticsTurnRow['allowance'] = [];
    for (const windowId of gauge.shown.get(family)?.ids ?? []) {
      const consumed =
        end === null ? null : measure({ id: turn.id, family, start, end }, windowId, gauge);
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
    const allowance = [...(familyMeasures.get(family) ?? [])]
      .flatMap(([windowId, values]) => {
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
      })
      .sort((left, right) => left.windowId.localeCompare(right.windowId));
    return [
      {
        family,
        turns: own.length,
        wallMs: own.reduce((total, row) => total + (row.wallMs ?? 0), 0),
        tokensIn: sum(own.map((row) => row.tokensIn)),
        tokensOut: sum(own.map((row) => row.tokensOut)),
        tokensInTurns: own.filter((row) => row.tokensIn !== null).length,
        tokensOutTurns: own.filter((row) => row.tokensOut !== null).length,
        allowance,
        windowsOmitted: gauge.shown.get(family)?.omitted ?? 0,
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
  const acceptances = new Set<string>();
  for (const row of store.db
    .prepare(
      "SELECT DISTINCT json_extract(body,'$.payload.lastAcceptance.branch') AS branch, json_extract(body,'$.payload.lastAcceptance.at') AS at FROM events WHERE task_id=? AND json_extract(body,'$.type')='chat.thread' AND json_extract(body,'$.payload.lastAcceptance.at') IS NOT NULL",
    )
    .all(task.id))
    acceptances.add(`${row.branch}\0${row.at}`);
  if (thread.lastAcceptance)
    acceptances.add(`${thread.lastAcceptance.branch}\0${thread.lastAcceptance.at}`);

  // A run that is still running or was stopped has no result to count.
  const statuses = [...runs.values()].filter(
    (status) => status === 'passed' || status === 'failed',
  );
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
    tokensInTurns: families.reduce((total, family) => total + family.tokensInTurns, 0),
    tokensOutTurns: families.reduce((total, family) => total + family.tokensOutTurns, 0),
    checksRun: statuses.length,
    checksPassed: statuses.filter((status) => status === 'passed').length,
    checksFailed: statuses.filter((status) => status === 'failed').length,
    acceptances: acceptances.size,
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
    held.tokensInTurns += family.tokensInTurns;
    held.tokensOutTurns += family.tokensOutTurns;
    held.windowsOmitted = Math.max(held.windowsOmitted, family.windowsOmitted);
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
 * `stats`, when given, receives the number of journal rows the gauge query returned.
 */
export function readAnalytics(
  store: Store,
  payload: ReadChatAnalyticsPayload,
  readAt: string,
  stats?: { gaugeRows: number },
): ChatAnalyticsRead | null {
  let tasks: Task[];
  let name: string;
  let id: string;
  let projectId: string;
  if (payload.scope === 'thread') {
    const task = store.get<Task>('task', payload.taskId);
    if (!task) return null;
    tasks = [task];
    name = task.title;
    id = task.id;
    projectId = task.projectId;
  } else {
    const project = store.get<{ id: string; name: string }>('project', payload.projectId);
    if (!project) return null;
    tasks = store.db
      .prepare("SELECT body FROM entities WHERE kind='task' AND json_extract(body,'$.projectId')=?")
      .all(project.id)
      .map((row) => JSON.parse(row.body as string) as Task)
      .sort(
        (left, right) => left.title.localeCompare(right.title) || (left.id < right.id ? -1 : 1),
      );
    name = project.name;
    id = project.id;
    projectId = project.id;
  }
  const loaded = tasks.flatMap((task) => loadThread(store, task) ?? []);
  // The gauge window runs from the first turn's start to the last turn's end.
  const times = loaded.flatMap(({ turns }) =>
    turns.flatMap((turn) => [seconds(turn.startedAt), seconds(turn.endedAt ?? turn.startedAt)]),
  );
  const first = Math.min(...times.filter((time) => !Number.isNaN(time)));
  const last = Math.max(...times.filter((time) => !Number.isNaN(time)));
  const fromCursor =
    Number.isFinite(first) && Number.isFinite(last)
      ? ((payload.scope === 'thread'
          ? store.db
              .prepare('SELECT CAST(MIN(cursor) AS TEXT) AS cursor FROM events WHERE task_id=?')
              .get(payload.taskId)
          : store.db
              .prepare(
                "SELECT CAST(MIN(cursor) AS TEXT) AS cursor FROM events WHERE task_id IN (SELECT id FROM entities WHERE kind='task' AND json_extract(body,'$.projectId')=?)",
              )
              .get(projectId)
        )?.cursor as string | null | undefined) || null
      : null;
  const gauge = loadGauge(store, { projectId, fromCursor, first, last });
  if (stats) stats.gaugeRows = gauge.rows;

  const facts = loaded.map((entry) => readThread(store, entry, gauge));
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
    tokensInTurns: total((row) => row.tokensInTurns),
    tokensOutTurns: total((row) => row.tokensOutTurns),
    checksRun: total((row) => row.checksRun),
    checksPassed: total((row) => row.checksPassed),
    checksFailed: total((row) => row.checksFailed),
    acceptances: total((row) => row.acceptances),
    slices:
      planned.length === 0
        ? null
        : {
            total: planned.reduce((value, slices) => value + slices.total, 0),
            done: planned.reduce((value, slices) => value + slices.done, 0),
            failed: planned.reduce((value, slices) => value + slices.failed, 0),
            blocked: planned.reduce((value, slices) => value + slices.blocked, 0),
          },
    families: FAMILIES.flatMap((family) => {
      const value = families.get(family);
      return value
        ? [{ ...value, allowance: value.allowance.slice(0, ANALYTICS_MAX_WINDOWS) }]
        : [];
    }),
    threads: payload.scope === 'project' ? rows.slice(0, ANALYTICS_MAX_THREADS) : [],
    threadCount: rows.length,
    turnRows: turnRows.slice(-ANALYTICS_MAX_TURNS),
    turnRowsOmitted: Math.max(0, turnRows.length - ANALYTICS_MAX_TURNS),
    gaugeTruncated: gauge.truncated,
  });
}
