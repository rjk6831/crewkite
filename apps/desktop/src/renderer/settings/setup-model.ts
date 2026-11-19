import type {
  PlanRecipesRead,
  PlanSchedulesRead,
  ProjectNotesRead,
  ResultsRead,
  WritingRulesRead,
} from '@crewkite/contracts';

// What the Project setup card says for each row, worked out from the reads alone. A row is set up
// when the person has something in place there. The sentence always says which, so nothing on the
// card depends on its colour.

/** A row's read: still out, failed with the controller's sentence, or answered. */
export type RowRead<T> =
  | { state: 'reading' }
  | { state: 'failed'; reason: string }
  | { state: 'read'; value: T };

export type SetupLine = { line: string; set: boolean };

/** Where the Context row's button goes: the first part that is missing. */
export type ContextTarget = 'design' | 'notes' | 'rules';

const count = (n: number, one: string, many: string) => (n === 1 ? one : many);
const lines = (parts: (string | false)[]) => parts.filter(Boolean).join(' ');

/** Reading and a failed read look the same on every row. */
export function rowLine<T>(read: RowRead<T>, line: (value: T) => SetupLine): SetupLine {
  if (read.state === 'reading') return { line: 'Reading.', set: false };
  if (read.state === 'failed')
    return { line: `Could not be read. ${read.reason}`.trim(), set: false };
  return line(read.value);
}

export type ContextParts = {
  rules: WritingRulesRead;
  /**
   * The saved design system: its version and whether writing turns receive it ("Send to writing
   * roles"). Null before the first save.
   */
  design: { version: number; sent: boolean } | null;
  notes: ProjectNotesRead;
};

// Only the rules a writing turn receives count. The export-only rules go into a file, not a turn.
const rulesOn = (rules: WritingRulesRead) =>
  rules.rules.filter((rule) => rule.surface === 'settings' && rule.enabled).length;

/**
 * A design system that is saved and not sent reaches no turn. It is named, and it does not count
 * as context on its own.
 */
export function contextLine({ rules, design, notes }: ContextParts): SetupLine {
  const on = rulesOn(rules);
  const kept = notes.notes.length;
  if (on === 0 && design === null && kept === 0)
    return { line: 'No writing rules, design system or notes yet.', set: false };
  return {
    line: lines([
      on > 0 &&
        count(
          on,
          '1 writing rule on for every project.',
          `${on} writing rules on for every project.`,
        ),
      design !== null &&
        (design.sent
          ? `Design system version ${design.version}.`
          : `Design system version ${design.version} is saved and not sent.`),
      kept > 0 && count(kept, '1 project note.', `${kept} project notes.`),
    ]),
    set: on > 0 || design?.sent === true || kept > 0,
  };
}

export function contextTarget({ rules, design, notes }: ContextParts): ContextTarget {
  if (!design?.sent) return 'design';
  if (notes.notes.length === 0) return 'notes';
  if (rulesOn(rules) === 0) return 'rules';
  return 'design';
}

export type HooksParts = {
  /** The project's newest thread, or null when it has none or has more than the card reads. */
  thread: string | null;
  /** Checks on in that thread, or null when there is no thread to count. */
  checks: number | null;
  /** Whether the project has a saved design system, which lets the design check run. */
  design: boolean;
  /** The project has more threads than the card reads, so it names none. */
  over: boolean;
};

export function hooksLine({ checks, design, over }: HooksParts): SetupLine {
  if (over)
    return {
      line: "This project has more than 1,000 threads. Open a thread's Crew tab to see its checks.",
      set: false,
    };
  if (checks === null)
    return { line: "No threads yet. Checks are turned on in a thread's Crew tab.", set: false };
  if (checks === 0)
    return {
      line: "No checks are on in the newest thread. Turn them on in a thread's Crew tab.",
      set: false,
    };
  return {
    line: lines([
      count(
        checks,
        '1 check on in the newest thread.',
        `${checks} checks on in the newest thread.`,
      ),
      design && 'The design check can run.',
    ]),
    set: true,
  };
}

/** The newest thread of a project. Thread IDs sort by the time they were made. */
export const newestThread = (ids: readonly string[]): string | null =>
  ids.reduce<string | null>((newest, id) => (newest === null || id > newest ? id : newest), null);

/** The most threads the card reads to find a project's newest one. */
export const THREADS_READ = 1000;

type ThreadPage<Next> = { tasks: readonly { id: string }[]; next: Next | null };

/**
 * The newest thread from a project's pages. The controller pages threads oldest first, so the
 * newest is known only once the last page is in. `more` reads the page after a continuation, never
 * more threads than the bound leaves. A project with more threads than that gets no thread named.
 */
export async function newestOfPages<Next>(
  first: ThreadPage<Next>,
  more: (after: Next, limit: number) => Promise<ThreadPage<Next>>,
  bound = THREADS_READ,
): Promise<{ thread: string | null; over: boolean }> {
  let page = first;
  let seen = page.tasks.length;
  let newest = newestThread(page.tasks.map(({ id }) => id));
  while (page.next !== null) {
    if (seen >= bound) return { thread: null, over: true };
    page = await more(page.next, Math.min(100, bound - seen));
    seen += page.tasks.length;
    newest = newestThread([...(newest ? [newest] : []), ...page.tasks.map(({ id }) => id)]);
  }
  return { thread: newest, over: false };
}

/**
 * A stopped loop is counted and leaves the row not set up. An active loop waiting for a reset time
 * has no next run, so only a due one is named. Loops past the read's bound are not counted, and a
 * line says how many there are.
 */
export function loopsLine(read: PlanSchedulesRead, when: (iso: string) => string): SetupLine {
  const states = read.schedules.map(({ schedule }) => schedule.state);
  const active = states.filter((state) => state === 'active').length;
  const paused = states.filter((state) => state === 'paused').length;
  const stopped = states.filter((state) => state === 'stopped').length;
  if (states.length === 0 && read.more === 0) return { line: 'No loops.', set: false };
  const due = read.schedules
    .flatMap(({ schedule }) =>
      schedule.state === 'active' && schedule.nextAt ? [schedule.nextAt] : [],
    )
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return {
    line: lines([
      active > 0 && `${active} active.`,
      paused > 0 && `${paused} paused.`,
      stopped > 0 && `${stopped} stopped.`,
      due !== undefined && `Next run ${when(due)}.`,
      read.more > 0 &&
        count(read.more, '1 more loop is not shown.', `${read.more} more loops are not shown.`),
    ]),
    set: active + paused > 0,
  };
}

/**
 * A file CrewKite never saved is named, and leaves the row not set up on its own. The read lists
 * every saved recipe before any such file, so the entries past its bound are files once the list
 * reaches one, and saved recipes while it holds none.
 */
export function graphsLine(read: PlanRecipesRead): SetupLine {
  const listedSaved = read.recipes.filter((entry) => entry.record !== null).length;
  const filesListed = read.recipes.length > listedSaved;
  // Saved recipes are listed first. Once a file shows, everything past the bound is a file. With
  // none showing, what is past the bound may be either, and the row says so.
  const saved = listedSaved;
  const waiting = read.recipes.length - listedSaved + (filesListed ? read.more : 0);
  const either = filesListed ? 0 : read.more;
  if (saved === 0 && waiting === 0 && either === 0) return { line: 'No recipes yet.', set: false };
  return {
    line: lines([
      saved > 0 && count(saved, '1 recipe.', `${saved} recipes.`),
      either > 0 &&
        count(
          either,
          '1 more recipe or file not saved yet.',
          `${either} more recipes or files not saved yet.`,
        ),
      waiting > 0 &&
        count(
          waiting,
          '1 file not saved as a recipe yet.',
          `${waiting} files not saved as recipes yet.`,
        ),
    ]),
    set: saved > 0,
  };
}

// The controller sends the newest step's time with every record, so `last` is set here.
export function resultsLine(read: ResultsRead, day: (iso: string) => string): SetupLine {
  if (read.records === 0) return { line: 'No results yet.', set: false };
  const newest = day(read.last ?? '');
  return {
    line:
      read.records === 1
        ? `1 step recorded, ${newest}.`
        : `${read.records} steps recorded, the newest ${newest}.`,
    set: true,
  };
}
