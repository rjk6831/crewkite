import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHECK_TAIL_CHARACTERS,
  type ChatCheckRun,
  type ChatThread,
  ChatThreadSchema,
  type Command,
  type CommandResult,
  type DesignFinding,
  DesignFindingRuleSchema,
  DesignFindingSchema,
  type DesignSystem,
  MAX_DESIGN_FINDINGS,
  type Task,
} from '@crewkite/contracts';
import { checksRunning } from '../chat/change-commands.ts';
import { listChanges } from '../chat/changes.ts';
import type { Store } from '../store/index.ts';
import {
  type DesignRule,
  type Finding,
  readCssTokens,
  type SourceFile,
  scanFiles,
  type TokenSet,
} from './scan.ts';

// The design check reads the thread's changed CSS, TSX and JSX files in its scratch copy and checks
// each value against the version of the design system the project saved last. An edit to the
// system's file reaches no check until someone saves it. The copy's other style files go to the
// scanner too, so a custom property declared in a changed file and read in an unchanged one is
// still checked. Only findings in changed files are kept. A changed file the check cannot read, for
// its size or because the scanner skips it, keeps its findings, fails the run and is named in the
// run's output. The check runs in process and starts nothing, so it asks no permission. Its run
// joins the thread's checks like any other.
//
// Findings belong to the thread. Each check rewrites them: a value found again keeps its row, with
// its ID, state and reason, and moves to this check's line and version. Open rows that are gone
// drop out. Sent, allowed and updated rows that are gone read as resolved until the next check.

export type FindingCommand = Extract<
  Command,
  { command: 'RunDesignCheck' | 'ReadDesignFindings' | 'ResolveDesignFinding' }
>;
type Payload<T extends FindingCommand['command']> = Extract<
  FindingCommand,
  { command: T }
>['payload'];

/** The finding commands that change something. Each finds its own task. */
export const findingMutations = ['RunDesignCheck', 'ResolveDesignFinding'];

export const DESIGN_CHECK_ID = 'design-system';
// The most bytes read from one style file, and from all of them in one check. Changed files are
// read first, so the total drops context before it drops a changed file.
const FILE_BYTES = 1024 * 1024;
const TOTAL_BYTES = 16 * 1024 * 1024;
const STYLE_FILE = /\.(?:css|jsx|tsx)$/;
// The findings part of a fixer's message stays well under the message limit.
const BRIEF_CHARACTERS = 12_000;
const DRAFT_OPEN = 'Draft open. This resolves when a saved version holds the value.';
const RULE_WORDS: Record<DesignRule, string> = {
  'raw-color': 'raw color',
  'off-scale-spacing': 'spacing off the scale',
  'unknown-font': 'unknown font',
  'off-scale-radius': 'radius off the scale',
  'unknown-shadow': 'unknown shadow',
};

// shortcut: the run names the version it read in its command text, and a findings read takes the
// version back from there, since a clean check leaves no row to carry it. Upgrade: a versionHash on
// the run, or one design check row per thread.
const againstVersion = (version: number) =>
  `Changed CSS, TSX and JSX files against version ${version}`;
const versionRead = (command: string) => Number(/ against version (\d+)$/.exec(command)?.[1] ?? 0);

const blocked = (reason: string, next: string): CommandResult => ({
  outcome: 'blocked',
  reason,
  next,
});
const noTask = () => blocked('task-not-found', 'Choose a registered task.');
const waiting = (row: DesignFinding) => row.state === 'open' || row.state === 'sent';
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const FILE_PATH = DesignFindingSchema.shape.file;
const FOUND = DesignFindingSchema.shape.found;

export type DesignCheckDeps = {
  store: Store;
  now: () => string;
  /** A new finding ID. */
  id: () => string;
  projectPath: (projectId: string) => string | undefined;
  scratchDirectory: (taskId: string) => string;
  /** Keeps the run with the thread's checks, inside the command's transaction. */
  recordRun: (taskId: string, run: ChatCheckRun) => void;
  /** A project check runs in the copy or waits on its question. */
  checksInCopy: (taskId: string) => boolean;
};

export class DesignChecks {
  private readonly deps: DesignCheckDeps;

  constructor(deps: DesignCheckDeps) {
    this.deps = deps;
  }

  run(taskId: string): CommandResult {
    const { store } = this.deps;
    const task = store.get<Task>('task', taskId);
    if (!task) return noTask();
    const root = this.deps.projectPath(task.projectId);
    if (!root) return blocked('project-not-found', 'Choose a registered project.');
    const record = store.designSystem(task.projectId);
    const saved = record && store.designSystemVersion(task.projectId, record.version);
    if (!record || !saved)
      return blocked('design-system-not-found', 'Save a design system for this project first.');
    const thread = readThread(store, taskId);
    // A turn or a project check may write the copy while it runs, so a check now could read a
    // file half written.
    if (thread.activeTurnId)
      return blocked('thread-busy', 'Run the design check when the current turn has finished.');
    if (this.deps.checksInCopy(taskId)) return checksRunning();
    const startedAt = this.deps.now();
    const began = performance.now();
    let files: ReturnType<DesignChecks['styleFiles']>;
    try {
      files = this.styleFiles(task, thread, root);
    } catch {
      return blocked(
        'copy-unreadable',
        'CrewKite could not read the copy, so the check did not run.',
      );
    }
    const scanned = scanFiles(files.read, saved.system.tokens, DesignFindingRuleSchema.options);
    // A file the scanner skips has no findings, which must not pass for a clean changed file.
    for (const path of scanned.skipped) if (files.checked.delete(path)) files.skipped.add(path);
    const found = scanned.findings.filter((finding) => files.checked.has(finding.file));
    // A value the contract cannot hold, such as one cut inside a character, gets no row. It still
    // fails the run.
    const recorded = found.filter((finding) => FOUND.safeParse(finding.found).success);
    const unrecorded = found.length - recorded.length;
    const merged = merge(store.designFindings(taskId), recorded, saved.system.tokens, {
      taskId,
      versionHash: record.versionHash,
      id: this.deps.id,
      skipped: files.skipped,
    });
    const outstanding = merged.outstanding + unrecorded;
    const skipped = files.skipped.size;
    store.deleteDesignFindings(taskId);
    for (const row of merged.rows) store.putDesignFinding(row, task.projectId, startedAt);
    const reasons = [
      outstanding
        ? `${plural(outstanding, 'value goes', 'values go')} around the design system.`
        : '',
      skipped
        ? `${plural(skipped, 'changed file was', 'changed files were')} too large or unreadable and not checked.`
        : '',
    ].filter(Boolean);
    this.deps.recordRun(taskId, {
      id: `chk_${randomBytes(16).toString('hex')}`,
      checkId: DESIGN_CHECK_ID,
      label: 'Design system',
      command: againstVersion(record.version),
      trigger: 'manual',
      status: reasons.length ? 'failed' : 'passed',
      reason: reasons.length ? reasons.join(' ') : null,
      startedAt,
      durationMs: Math.round(performance.now() - began),
      exitCode: null,
      tail: tail(merged.rows, files.checked.size, files.skipped, unrecorded),
      stdout: null,
      stderr: null,
    });
    return this.findings(task);
  }

  read(taskId: string): CommandResult {
    const task = this.deps.store.get<Task>('task', taskId);
    return task ? this.findings(task) : noTask();
  }

  /**
   * Send to the fixer marks the finding sent, and the fixer's next turn carries it. Allow once
   * keeps the person's reason. Update the system marks a draft open; the save that holds the value
   * settles it.
   */
  resolve(payload: Payload<'ResolveDesignFinding'>): CommandResult {
    const { store } = this.deps;
    const finding = store.designFinding(payload.findingId);
    const task = finding && store.get<Task>('task', finding.taskId);
    if (!finding || !task)
      return blocked('design-finding-not-found', 'Run the design check again.');
    if (!waiting(finding))
      return blocked(
        'design-finding-settled',
        `This finding is ${finding.state}. Run the design check again to see what is left.`,
      );
    let next: DesignFinding;
    if (payload.action === 'send-to-fixer') next = { ...finding, state: 'sent', reason: null };
    else if (payload.action === 'update-system') next = { ...finding, reason: DRAFT_OPEN };
    else if (payload.reason === undefined)
      return blocked('reason-required', 'Say why this value may stay.');
    else next = { ...finding, state: 'allowed', reason: payload.reason };
    store.putDesignFinding(next, task.projectId, this.deps.now());
    return this.findings(task);
  }

  /**
   * A saved version settles each open or sent finding of the project whose value it holds, when the
   * version the finding was checked against did not. A literal that already equalled a token stays
   * open, since the fix there is to use the token. This runs inside the save's transaction, so a
   * refused save marks nothing.
   */
  saved(projectId: string, system: DesignSystem, versionHash: string) {
    const { store } = this.deps;
    const record = store.designSystem(projectId);
    if (!record) return;
    const checked = new Map<string, TokenSet | null>([[versionHash, system.tokens]]);
    const tokensOf = (hash: string) => {
      if (!checked.has(hash)) {
        let tokens: TokenSet | null = null;
        for (let version = record.version - 1; version > 0 && !tokens; version--) {
          const saved = store.designSystemVersion(projectId, version);
          if (saved?.versionHash === hash) tokens = saved.system.tokens;
        }
        checked.set(hash, tokens);
      }
      return checked.get(hash) ?? null;
    };
    const at = this.deps.now();
    for (const task of store.list<Task>('task'))
      if (task.projectId === projectId)
        for (const finding of store.designFindings(task.id)) {
          if (!waiting(finding)) continue;
          const token = coveringToken(system.tokens, finding.rule, finding.found);
          const before = tokensOf(finding.versionHash);
          if (!token || (before && coveringToken(before, finding.rule, finding.found))) continue;
          store.putDesignFinding(
            {
              ...finding,
              state: 'updated',
              reason: `Version ${record.version} holds this value as ${token}.`,
            },
            projectId,
            at,
          );
        }
  }

  /** The thread's findings, oldest first, and the version the newest check read. */
  private findings(task: Task): CommandResult {
    const { store } = this.deps;
    const findings = store.designFindings(task.id).slice(0, MAX_DESIGN_FINDINGS);
    const run = readThread(store, task.id).checks?.runs.findLast(
      (value) => value.checkId === DESIGN_CHECK_ID,
    );
    const version = run ? versionRead(run.command) : 0;
    const checked = version ? store.designSystemVersion(task.projectId, version) : undefined;
    return {
      outcome: 'applied',
      data: {
        kind: 'design-findings',
        taskId: task.id,
        versionHash: checked?.versionHash ?? findings[0]?.versionHash ?? null,
        findings,
      },
    };
  }

  /**
   * The copy's style files, changed ones first. `checked` holds the changed files read, and
   * `skipped` the changed files left unread for their size, their path or a failed read.
   */
  private styleFiles(task: Task, thread: ChatThread, root: string) {
    const read: SourceFile[] = [];
    const checked = new Set<string>();
    const skipped = new Set<string>();
    if (!thread.scratchReady || !thread.base) return { read, checked, skipped };
    const scratch = this.deps.scratchDirectory(task.id);
    const listing = listChanges(root, scratch, thread.base);
    const changed = new Set(
      listing.entries.flatMap((entry) =>
        entry.next && STYLE_FILE.test(entry.path) ? [entry.path] : [],
      ),
    );
    // A finding names its file, so a path the contract cannot hold is never read.
    const style = (path: string) => STYLE_FILE.test(path) && FILE_PATH.safeParse(path).success;
    for (const path of changed) if (!style(path)) skipped.add(path);
    const files = listing.candidates
      .filter((file) => style(file.path))
      .sort((left, right) => Number(changed.has(right.path)) - Number(changed.has(left.path)));
    let budget = TOTAL_BYTES;
    for (const file of files) {
      const text = readBounded(join(scratch, file.path), Math.min(FILE_BYTES, budget));
      if (text === null) {
        if (changed.has(file.path)) skipped.add(file.path);
        continue;
      }
      budget -= text.bytes;
      read.push({ path: file.path, text: text.text });
      if (changed.has(file.path)) checked.add(file.path);
    }
    return { read, checked, skipped };
  }
}

export function findingsCommand(checks: DesignChecks, command: FindingCommand): CommandResult {
  switch (command.command) {
    case 'RunDesignCheck':
      return checks.run(command.payload.taskId);
    case 'ReadDesignFindings':
      return checks.read(command.payload.taskId);
    case 'ResolveDesignFinding':
      return checks.resolve(command.payload);
  }
}

/**
 * The part of a fixer's message that carries the findings the person sent. Every finding still
 * marked sent rides on the fixer's next turn, so several sends make one turn. A finding stays sent
 * until a check finds it gone or the person settles it, so a later fix round sees it again.
 */
export function designFixerBrief(findings: readonly DesignFinding[]): string {
  const sent = findings.filter((finding) => finding.state === 'sent');
  if (!sent.length) return '';
  const lines: string[] = [];
  let size = 0;
  for (const finding of sent) {
    const token = finding.nearestToken
      ? `Use ${finding.nearestToken}.`
      : 'No token is close, so pick the one that fits.';
    const line = `- ${finding.file}:${finding.line}: ${RULE_WORDS[finding.rule]} ${finding.found}. ${token}`;
    size += line.length + 1;
    if (size > BRIEF_CHARACTERS) break;
    lines.push(line);
  }
  const rest = sent.length - lines.length;
  return [
    'These values go around the project design system. Replace each one with a token from the system.',
    ...lines,
    ...(rest > 0 ? [`${rest} more are not listed. The next design check names them.`] : []),
  ].join('\n');
}

/**
 * The rows after a check, and how many values still wait on a fix: open or sent, the ones past the
 * row limit and the ones in skipped files included.
 *
 * Rows pair with values of the same file, rule and found text. While a file holds a value as many
 * times as before, the rows pair in line order, so lines that moved together keep their rows. When
 * the count changed, the check cannot tell which occurrence went or came, so each value takes the
 * nearest row by line, and an allowance pairs with nothing: it covered one occurrence the person
 * looked at, so it resolves and the value opens again.
 */
function merge(
  previous: readonly DesignFinding[],
  found: readonly Finding[],
  tokens: TokenSet,
  context: { taskId: string; versionHash: string; id: () => string; skipped: ReadonlySet<string> },
) {
  const { taskId, versionHash, skipped } = context;
  // A changed file the check could not read keeps its rows as they were.
  const carried = previous.filter((row) => skipped.has(row.file));
  const groups = new Map<string, { rows: DesignFinding[]; values: Finding[] }>();
  const group = (item: Pick<Finding, 'file' | 'rule' | 'found'>) => {
    const key = JSON.stringify([item.file, item.rule, item.found]);
    const entry = groups.get(key) ?? { rows: [], values: [] };
    groups.set(key, entry);
    return entry;
  };
  for (const row of previous)
    if (row.state !== 'resolved' && !skipped.has(row.file)) group(row).rows.push(row);
  for (const value of found) group(value).values.push(value);
  const paired = new Map<Finding, DesignFinding>();
  const byLine = <T extends { line: number }>(items: T[]) =>
    [...items].sort((left, right) => left.line - right.line);
  for (const { rows, values } of groups.values()) {
    const ordered = byLine(rows);
    if (ordered.length === values.length) {
      byLine(values).forEach((value, index) => {
        const row = ordered[index];
        if (row) paired.set(value, row);
      });
      continue;
    }
    const free = ordered.filter((row) => row.state !== 'allowed');
    for (const value of byLine(values)) {
      const distance = (row: DesignFinding) => Math.abs(row.line - value.line);
      const nearest = free.reduce<DesignFinding | undefined>(
        (best, row) => (!best || distance(row) < distance(best) ? row : best),
        undefined,
      );
      if (!nearest) break;
      paired.set(value, nearest);
      free.splice(free.indexOf(nearest), 1);
    }
  }
  const kept: DesignFinding[] = [];
  const fresh: DesignFinding[] = [];
  for (const value of found) {
    const match = paired.get(value);
    if (!match) {
      fresh.push({ id: context.id(), taskId, ...value, state: 'open', reason: null, versionHash });
      continue;
    }
    // An update holds only while the system still holds the value.
    const lapsed = match.state === 'updated' && !coveringToken(tokens, match.rule, match.found);
    kept.push({
      ...match,
      line: value.line,
      nearestToken: value.nearestToken,
      versionHash,
      ...(lapsed ? { state: 'open', reason: null } : {}),
    });
  }
  const used = new Set(paired.values());
  const gone = [...groups.values()]
    .flatMap(({ rows }) => rows)
    .filter((row) => !used.has(row) && row.state !== 'open')
    .map((row): DesignFinding => ({ ...row, state: 'resolved', versionHash }));
  const outstanding = kept.filter(waiting).length + fresh.length + carried.filter(waiting).length;
  return {
    rows: [...kept, ...carried, ...fresh, ...gone].slice(0, MAX_DESIGN_FINDINGS),
    outstanding,
  };
}

/** The run's output: what it read, each changed file it could not, then each value that waits. */
function tail(
  rows: readonly DesignFinding[],
  checked: number,
  skipped: ReadonlySet<string>,
  unrecorded: number,
): string {
  const lines = [
    `Checked ${plural(checked, 'changed file', 'changed files')}.`,
    ...[...skipped].map((path) => `Not checked: ${path}`),
    ...(unrecorded ? [`${plural(unrecorded, 'value', 'values')} could not be listed.`] : []),
    ...rows
      .filter(waiting)
      .map(
        (row) =>
          `${row.file}:${row.line} ${RULE_WORDS[row.rule]} ${row.found}${row.nearestToken ? `, use ${row.nearestToken}` : ''}`,
      ),
  ];
  let text = '';
  for (const line of lines) {
    if (text.length + line.length + 1 > CHECK_TAIL_CHARACTERS) break;
    text += `${text ? '\n' : ''}${line}`;
  }
  return text;
}

/** A regular file's text when it holds at most `limit` bytes, or null. A link is never followed. */
function readBounded(path: string, limit: number): { text: string; bytes: number } | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const state = fstatSync(fd);
    if (!state.isFile() || state.size > limit) return null;
    const bytes = Buffer.alloc(state.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    return { text: bytes.subarray(0, offset).toString('utf8'), bytes: offset };
  } finally {
    closeSync(fd);
  }
}

// shortcut: the scanner keeps its value readers to itself, so a save matches a found value with a
// smaller reader here: hex and rgb() colors by channel, other colors by text, px, rem and em
// lengths by size, and shadows through readCssTokens. Upgrade: a matcher exported beside the
// scanner's own readers.
/** The token that holds the value a finding found, as a token path, or null. */
function coveringToken(tokens: TokenSet, rule: DesignRule, found: string): string | null {
  const first = (group: string, entries: [string, unknown][]) =>
    entries[0] ? `${group}.${entries[0][0]}` : null;
  if (rule === 'raw-color')
    return first(
      'color',
      Object.entries(tokens.color).filter(([, token]) => color(token.$value) === color(found)),
    );
  if (rule === 'off-scale-spacing' || rule === 'off-scale-radius') {
    const group = rule === 'off-scale-spacing' ? 'spacing' : 'radius';
    const size = pixels(found);
    return size === null
      ? null
      : first(
          group,
          Object.entries(tokens[group]).filter(
            ([, token]) => pixels(`${token.$value.value}${token.$value.unit}`) === size,
          ),
        );
  }
  if (rule === 'unknown-font')
    return first(
      'type',
      Object.entries(tokens.type).filter(
        ([, token]) =>
          token.$type === 'fontFamily' &&
          [token.$value].flat().some((family) => family.toLowerCase() === found.toLowerCase()),
      ),
    );
  const read = readCssTokens(`:root { --shadow-found: ${found}; }`).shadow.found;
  if (!read) return null;
  const layers = (value: TokenSet['shadow'][string]['$value']) =>
    [value]
      .flat()
      .map((layer) =>
        [
          color(layer.color),
          ...[layer.offsetX, layer.offsetY, layer.blur, layer.spread].map((size) =>
            pixels(`${size.value}${size.unit}`),
          ),
          Boolean(layer.inset),
        ].join(' '),
      );
  const wanted = layers(read.$value).join(',');
  return first(
    'shadow',
    Object.entries(tokens.shadow).filter(([, token]) => layers(token.$value).join(',') === wanted),
  );
}

/** A length in px, em and rem at 16px, rounded to a thousandth. Null for any other unit. */
function pixels(text: string): number | null {
  const match = /^-?(\d+\.?\d*|\.\d+)(px|r?em)$/i.exec(text.trim());
  if (!match) return null;
  const size = Number(match[1]) * (match[2]?.toLowerCase() === 'px' ? 1 : 16);
  return Math.round(size * 1000) / 1000;
}

/** A hex or rgb() color as eight hex digits, or any other color as lower case text. */
function color(text: string): string {
  const value = text.replace(/\s+/g, '').toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join('') : hex;
    return full.length === 6 ? `${full}ff` : full;
  }
  const parts = /^rgba?\((.*)\)$/
    .exec(text.trim().toLowerCase())?.[1]
    ?.split(/[\s,/]+/)
    .filter(Boolean);
  if (!parts || parts.length < 3 || parts.length > 4) return value;
  const channel = (part: string | undefined, whole: number) =>
    part === undefined
      ? whole
      : part.endsWith('%')
        ? (Number.parseFloat(part) / 100) * whole
        : Number.parseFloat(part);
  const bytes = [
    channel(parts[0], 255),
    channel(parts[1], 255),
    channel(parts[2], 255),
    channel(parts[3], 1) * 255,
  ];
  if (!bytes.every((byte) => Number.isFinite(byte) && byte >= 0 && byte <= 255)) return value;
  return bytes.map((byte) => Math.round(byte).toString(16).padStart(2, '0')).join('');
}

function readThread(store: Store, taskId: string): ChatThread {
  const row = store.db.prepare('SELECT body FROM chat_threads WHERE task_id=?').get(taskId);
  return ChatThreadSchema.parse(
    row
      ? JSON.parse(row.body as string)
      : { taskId, scratchReady: false, base: null, selection: null },
  );
}
