import {
  type ChatCatalogRead,
  type ChatCrewRole,
  type ChatFamily,
  MAX_PLAN_SLICES,
  MeteredFamilySchema,
  type PlanRecipe,
  type PlanRecipeFile,
  type PlanRecipeRunState,
  type PlanRecipesRead,
  type PlanRecipeTrigger,
  type PlanSchedule,
  type PlanScheduleState,
  planScheduleLine,
} from '@crewkite/contracts';
import { familyName } from '../family-name.ts';
import {
  crewRoleNames,
  flightModes,
  handoffModes,
  permissionPolicies,
} from '../settings/preferences.ts';

// What the Recipes page works out from a recipe before it draws anything: the steps a run takes,
// the lines that differ between two versions and the problems that keep a draft from saving. All
// of it is pure, so the tests read the same sentences the page shows.

export type MeteredFamily = (typeof MeteredFamilySchema.options)[number];
export type Member = PlanRecipe['crew']['members'][number];
export type ModelLabel = (family: ChatFamily, model: string) => string;
export type When = (iso: string) => string;
/** The longest interval a schedule takes, in minutes. */
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

/** Roles in the order the form and the change lines list them. */
export const ROLE_ORDER: readonly ChatCrewRole[] = [
  'orchestrator',
  'builder',
  'reviewer',
  'fixer',
  'challenger',
];

export const member = (recipe: PlanRecipe, role: ChatCrewRole): Member | undefined =>
  recipe.crew.members.find((item) => item.role === role);

export const shapeWords: Record<PlanRecipe['shape'], string> = {
  change: 'Changes files',
  report: 'Report only',
};
/** The choices the controller lets a recipe use, from its recipe list read. */
export type Available = PlanRecipesRead['available'];
/**
 * What the page assumes before the list read answers, or when it fails: nothing that can be
 * switched off is offered until the controller says it is on.
 */
export const NONE_AVAILABLE: Available = { checklistWork: false, reportRuns: false };

/**
 * The one line under Run type and under Work while the controller has that choice switched off,
 * or null while it is on. A draft that holds the switched-off choice gets the controller's own
 * refusal, which names the way out. `run` says why Run is off for a saved report recipe.
 */
export function offLines(
  recipe: PlanRecipe,
  available: Available,
): { shape: string | null; work: string | null; run: string | null } {
  return {
    run:
      recipe.shape === 'report' && !available.reportRuns
        ? 'Report only runs are not available in this version.'
        : null,
    shape: available.reportRuns
      ? null
      : recipe.shape === 'report'
        ? 'Report only runs are not available in this version. Set Run type to Changes files.'
        : 'Report only runs are not available in this version.',
    work: available.checklistWork
      ? null
      : recipe.work?.kind === 'checklist'
        ? 'Checklist work is not available in this version. Give the loop a fixed request.'
        : 'Checklist work is not available in this version.',
  };
}

export const fileWords: Record<PlanRecipeFile, string | null> = {
  current: null,
  changed: 'Changed on disk',
  missing: 'Missing',
  invalid: 'Does not read',
  unrecorded: 'Not saved here',
};
export const scheduleWords: Record<PlanScheduleState, string> = {
  active: 'Active',
  paused: 'Paused',
  stopped: 'Stopped',
};
export const runWords: Record<PlanRecipeRunState, string> = {
  running: 'Running',
  asked: 'Waiting on a question',
  ready: 'Ready for Accept',
  accepted: 'Accepted',
  discarded: 'Discarded',
  'no-change': 'No change',
  reported: 'Report',
  failed: 'Failed',
  stopped: 'Stopped',
};

/** An interval in the largest unit that divides it evenly. */
export function intervalWords(minutes: number): string {
  if (minutes > 0 && minutes % 1440 === 0) return `Every ${minutes / 1440} d`;
  if (minutes > 0 && minutes % 60 === 0) return `Every ${minutes / 60} h`;
  return `Every ${minutes} min`;
}

export function triggerWords(trigger: PlanRecipeTrigger, when: When = (iso) => iso): string {
  switch (trigger.kind) {
    case 'manual':
      return 'Manual';
    case 'once':
      return `Once, ${when(trigger.at)}`;
    case 'interval':
      return intervalWords(trigger.everyMinutes);
    case 'reset':
      return `At each ${familyName(trigger.family)} reset`;
  }
}

/** The line a schedule's review shows for what its runs stop to ask. */
export function askWords(run: PlanRecipe['run']): string {
  if (run.flightMode === 'balanced')
    return 'Each run waits for you to approve its plan, and asks before a risky command.';
  if (run.permissionPolicy === 'ask')
    return 'Each run waits whenever a role wants to edit a file or run a command.';
  if (run.permissionPolicy === 'allow-edits')
    return 'Each run waits whenever a role wants to run a command.';
  return 'Runs go through without asking.';
}

/**
 * A schedule's state word and what follows it. A pause or stop line opens with that word, so the
 * strip shows the word once and the rest of the line after it.
 */
export function stripLine(schedule: Pick<PlanSchedule, 'state' | 'note'>): {
  word: string;
  rest: string;
} {
  const word = scheduleWords[schedule.state];
  const line = schedule.note ? planScheduleLine(schedule.note) : '';
  if (line.startsWith(word)) return { word, rest: line.slice(word.length) };
  return { word, rest: line ? `. ${line}` : '.' };
}

/**
 * The strip's counts. A schedule paused at its waiting limit already says how many runs wait, so
 * the count of runs waiting shows only otherwise.
 */
export function stripCounts(
  schedule: Pick<PlanSchedule, 'runsStarted' | 'maxRuns' | 'waiting' | 'note'>,
): string {
  const started = `${schedule.runsStarted} of ${schedule.maxRuns} runs started.`;
  return schedule.note?.code === 'waiting-limit'
    ? started
    : `${started} ${schedule.waiting} waiting for you.`;
}

export type Step = {
  /** Its number in the list. */
  id: number;
  key: string;
  text: string;
  /** Who takes it, in words. Null for a step the controller does itself. */
  who: string | null;
  /** The crew member whose model runs it, when one does. */
  role: ChatCrewRole | null;
  /** True for the steps every slice takes in its own copy. */
  perSlice: boolean;
};

/**
 * The steps a run of this recipe takes, in order. The plan runner fixes the order and who takes
 * each step, so this only leaves out the steps the recipe's crew and checks do not reach.
 */
export function recipeSteps(recipe: PlanRecipe): Step[] {
  const has = (role: ChatCrewRole) => member(recipe, role) !== undefined;
  const checks = recipe.checks.some((check) => check.command.trim());
  const slices = recipe.run.maxSlices;
  const rows: Omit<Step, 'id'>[] = [];
  const add = (
    key: string,
    text: string,
    who: string | null,
    role: ChatCrewRole | null,
    perSlice = false,
  ) => rows.push({ key, text, who, role, perSlice });
  add(
    'split',
    // A cleared or out of range count has no number worth reading back.
    Number.isInteger(slices) && slices >= 1 && slices <= MAX_PLAN_SLICES
      ? `Split the request into up to ${slices} ${slices === 1 ? 'slice' : 'slices'}.`
      : 'Split the request into slices.',
    'Orchestrator',
    'orchestrator',
  );
  if (recipe.shape === 'report') {
    add('read', 'Read for each slice.', 'Builder, read only', 'builder', true);
    if (has('challenger')) add('challenge', 'Challenge the findings.', 'Challenger', 'challenger');
    add('report', 'Write what stands into one message.', 'Orchestrator', 'orchestrator');
    add('end-report', 'End with the report.', null, null);
  } else {
    add('build', 'Build each slice in its own copy.', 'Builder', 'builder', true);
    if (checks) add('check', 'Run the checks on the slice.', null, null, true);
    if (has('reviewer')) {
      add('review', 'Review the slice.', 'Reviewer', 'reviewer', true);
      add(
        'fix',
        'Fix what the review found, up to 2 rounds.',
        has('fixer') ? 'Fixer' : "The slice's own model",
        has('fixer') ? 'fixer' : 'builder',
        true,
      );
    }
    add('merge', "Merge the slice into the thread's copy.", null, null, true);
    if (checks) add('check-merge', 'Run the checks on the merged copy.', null, null, true);
    add(
      'resolve',
      'Resolve a merge conflict when one comes up.',
      "Orchestrator's model",
      'orchestrator',
      true,
    );
    if (has('challenger'))
      add('challenge', 'Challenge the result once.', 'Challenger', 'challenger');
    add('end', 'Stop at ready for Accept.', null, null);
  }
  return rows.map((row, index) => ({ ...row, id: index + 1 }));
}

export type Change = {
  /** The field's path. Revert takes it. */
  path: string;
  label: string;
  before: string | null;
  after: string | null;
};

const label = <T extends string>(list: readonly { id: T; label: string }[], id: T) =>
  list.find((item) => item.id === id)?.label ?? id;

/** JSON with each object's keys sorted, so a file written by hand compares like the form's. */
const stable = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([x], [y]) => (x < y ? -1 : 1)))
      : item,
  );

/**
 * A recipe as label and value pairs in form order. Each row also carries the field as stored,
 * which decides whether it changed, since two values can read alike: a description of `None`, two
 * times in the same minute. The name and each command are read without their stray spaces, which
 * a save drops. With the crew order and check order lines `recipeChanges` adds, a draft with no
 * problem line that hashes apart from its saved version differs from it in a line the person can
 * read, unless all that differs is the spaces around the name or a command.
 */
export function recipeFields(
  recipe: PlanRecipe,
  model: ModelLabel = (_family, id) => id,
  when: When = (iso) => iso,
): { path: string; label: string; value: string; stored: string }[] {
  const rows: { path: string; label: string; value: string; stored: string }[] = [];
  const add = (path: string, name: string, value: string, stored = value) =>
    rows.push({ path, label: name, value, stored });
  // A name is read without its stray spaces, which a save drops, the same as a command.
  add('name', 'Name', recipe.name.trim());
  add('description', 'Description', recipe.description || 'None', recipe.description);
  add('shape', 'Run type', shapeWords[recipe.shape]);
  add('crew.name', 'Crew name', recipe.crew.name);
  for (const role of ROLE_ORDER) {
    const found = member(recipe, role);
    if (!found) continue;
    const { family, model: id, effort } = found.selection;
    const name = crewRoleNames[role];
    add(
      `crew.${role}.model`,
      `${name} model`,
      `${familyName(family)} ${model(family, id)}`,
      stable([family, id]),
    );
    add(`crew.${role}.effort`, `${name} effort`, effort);
    add(
      `crew.${role}.subagents`,
      `${name} subagents`,
      found.allowSubagents === undefined
        ? 'Provider default'
        : found.allowSubagents
          ? 'Allowed'
          : 'Not allowed',
    );
  }
  add('run.flightMode', 'Flight mode', label(flightModes, recipe.run.flightMode));
  add(
    'run.permissionPolicy',
    'Permissions',
    label(permissionPolicies, recipe.run.permissionPolicy),
  );
  add(
    'run.handoff.auto',
    'When a provider reaches a limit',
    recipe.run.handoff.auto ? 'Move to another provider' : 'Stop and say so',
  );
  add('run.handoff.mode', 'Move by', label(handoffModes, recipe.run.handoff.mode));
  add('run.maxSlices', 'Most slices', String(recipe.run.maxSlices));
  for (const check of recipe.checks) {
    const command = check.command.trim();
    add(`checks.${command}`, 'Check', command);
  }
  add('trigger', 'Starts', triggerWords(recipe.trigger, when), stable(recipe.trigger));
  if (recipe.work)
    add(
      'work',
      'Work',
      recipe.work.kind === 'request' ? recipe.work.text : `Checklist ${recipe.work.path}`,
      stable(recipe.work),
    );
  if (recipe.budget) {
    add('budget.maxRuns', 'Most runs', String(recipe.budget.maxRuns));
    for (const family of MeteredFamilySchema.options) {
      const limit = recipe.budget.maxUsedPercent[family];
      if (limit !== undefined)
        add(
          `budget.maxUsedPercent.${family}`,
          `${familyName(family)}: stop starting at`,
          `${limit}% used`,
        );
    }
    add('budget.maxWaiting', 'Most runs waiting for you', String(recipe.budget.maxWaiting));
  }
  return rows;
}

const roles = (recipe: PlanRecipe) => recipe.crew.members.map((item) => item.role);
/** Each command without its stray spaces, the way a save writes it. An empty row reads as null. */
const commands = (recipe: PlanRecipe) => recipe.checks.map((check) => check.command.trim() || null);

/** The items `list` shares with `other`, each once, in the order `list` holds them. */
function shared(list: readonly (string | null)[], other: readonly (string | null)[]): string[] {
  const held = new Set(other);
  return [...new Set(list)].filter((item): item is string => item !== null && held.has(item));
}

/**
 * A line for the order of what both versions hold, or null when that order is the same. Items
 * added or removed around them have lines of their own.
 */
function orderLine(
  path: string,
  name: string,
  before: readonly (string | null)[],
  after: readonly (string | null)[],
  words: (item: string) => string = (item) => item,
): Change | null {
  const first = shared(before, after);
  const next = shared(after, before);
  if (JSON.stringify(first) === JSON.stringify(next)) return null;
  return {
    path,
    label: name,
    before: first.map(words).join(', '),
    after: next.map(words).join(', '),
  };
}

/** Where an item goes back: before the first item in `list` whose saved place is later. */
function savedPlace(
  keys: readonly (string | null)[],
  saved: readonly (string | null)[],
  at: number,
) {
  const index = keys.findIndex((key) => key !== null && saved.indexOf(key) > at);
  return index < 0 ? keys.length : index;
}

/** `list` with the items both versions hold in their saved order. Every other item stays put. */
function savedOrder<T>(
  list: readonly T[],
  keys: readonly (string | null)[],
  saved: readonly (string | null)[],
): T[] {
  const rank = (index: number) => {
    const key = keys[index];
    return key === null || key === undefined ? -1 : saved.indexOf(key);
  };
  const held = list
    .map((item, index) => ({ item, rank: rank(index) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  return list.map((item, index) => (rank(index) >= 0 ? (held.shift()?.item ?? item) : item));
}

/** The lines the review shows, in form order. `saved` is null for a recipe never saved. */
export function recipeChanges(
  saved: PlanRecipe | null,
  draft: PlanRecipe,
  model?: ModelLabel,
  when?: When,
): Change[] {
  const before = new Map(
    (saved ? recipeFields(saved, model, when) : []).map((row) => [row.path, row] as const),
  );
  const after = recipeFields(draft, model, when);
  const seen = new Set<string>();
  const changes: Change[] = [];
  // A member's lines and a check's line are keyed by the role and the command, so the order of
  // the ones both versions hold needs a line of its own. Checks run in list order.
  const crewOrder = saved
    ? orderLine(
        'crew-order',
        'Crew order',
        roles(saved),
        roles(draft),
        (role) => crewRoleNames[role as ChatCrewRole],
      )
    : null;
  const checkOrder = saved
    ? orderLine('check-order', 'Check order', commands(saved), commands(draft))
    : null;
  for (const row of after) {
    if (row.path === 'run.flightMode' && crewOrder) changes.push(crewOrder);
    if (row.path === 'trigger' && checkOrder) changes.push(checkOrder);
    seen.add(row.path);
    const old = before.get(row.path);
    if (old?.stored !== row.stored)
      changes.push({
        path: row.path,
        label: row.label,
        before: old?.value ?? null,
        after: row.value,
      });
  }
  for (const [path, row] of before)
    if (!seen.has(path)) changes.push({ path, label: row.label, before: row.value, after: null });
  return changes;
}

/** One change line as the review reads it out. */
export function changeWords(change: Change): string {
  if (change.before === null) return `${change.label}: ${change.after} (new)`;
  if (change.after === null) return `${change.label}: ${change.before} (removed)`;
  return `${change.label}: ${change.before} to ${change.after}`;
}

/**
 * The draft with one change line taken back to the saved version. Most lines are one field. A crew
 * member's three lines go back one at a time while both versions have that member, and as a whole
 * when one side lacks it. The trigger, its work and its budget go back together when one version
 * is manual and the other is a schedule, because half of a schedule does not validate. A member or
 * a check that comes back goes before the first one whose saved place is later, so the others keep
 * their order. An order line puts back the order of what both versions hold and moves nothing
 * else. Checks are matched without their stray spaces, and rows left empty stay where they are.
 */
export function revertChange(saved: PlanRecipe, draft: PlanRecipe, path: string): PlanRecipe {
  const next = structuredClone(draft);
  const [head, key, leaf] = path.split('.');
  if (head === 'crew' && key === 'name') next.crew.name = saved.crew.name;
  else if (head === 'crew-order')
    next.crew.members = savedOrder(next.crew.members, roles(next), roles(saved));
  else if (head === 'check-order')
    next.checks = savedOrder(next.checks, commands(next), commands(saved));
  else if (head === 'crew' && key) {
    const role = key as ChatCrewRole;
    const old = member(saved, role);
    const now = member(next, role);
    if (old && now) {
      if (leaf === 'model')
        now.selection = {
          ...now.selection,
          family: old.selection.family,
          model: old.selection.model,
        };
      else if (leaf === 'effort')
        now.selection = { ...now.selection, effort: old.selection.effort };
      else if (old.allowSubagents === undefined) delete now.allowSubagents;
      else now.allowSubagents = old.allowSubagents;
    } else if (old) {
      const at = savedPlace(roles(next), roles(saved), saved.crew.members.indexOf(old));
      next.crew.members.splice(at, 0, structuredClone(old));
    } else next.crew.members = next.crew.members.filter((item) => item.role !== role);
  } else if (head === 'checks') {
    const command = path.slice('checks.'.length);
    const index = commands(saved).indexOf(command);
    if (index < 0) next.checks = next.checks.filter((check) => check.command.trim() !== command);
    else next.checks.splice(savedPlace(commands(next), commands(saved), index), 0, { command });
  } else if (head === 'trigger' || head === 'work' || head === 'budget') {
    const scheduled = (recipe: PlanRecipe) => recipe.trigger.kind !== 'manual';
    if (scheduled(saved) !== scheduled(next) || !saved.budget || !next.budget) {
      next.trigger = structuredClone(saved.trigger);
      next.work = structuredClone(saved.work);
      next.budget = structuredClone(saved.budget);
    } else if (head === 'trigger') next.trigger = structuredClone(saved.trigger);
    else if (head === 'work') next.work = structuredClone(saved.work);
    else if (key === 'maxRuns') next.budget.maxRuns = saved.budget.maxRuns;
    else if (key === 'maxWaiting') next.budget.maxWaiting = saved.budget.maxWaiting;
    else if (key === 'maxUsedPercent' && leaf) {
      const family = leaf as MeteredFamily;
      const limit = saved.budget.maxUsedPercent[family];
      if (limit === undefined) delete next.budget.maxUsedPercent[family];
      else next.budget.maxUsedPercent[family] = limit;
    }
  } else if (head === 'run') {
    if (key === 'flightMode') next.run.flightMode = saved.run.flightMode;
    else if (key === 'permissionPolicy') next.run.permissionPolicy = saved.run.permissionPolicy;
    else if (key === 'maxSlices') next.run.maxSlices = saved.run.maxSlices;
    else if (leaf === 'auto') next.run.handoff.auto = saved.run.handoff.auto;
    else if (leaf === 'mode') next.run.handoff.mode = saved.run.handoff.mode;
  } else if (head === 'name') next.name = saved.name;
  else if (head === 'description') next.description = saved.description;
  else if (head === 'shape') next.shape = saved.shape;
  return next;
}

/**
 * Adds a member before the first one whose role comes later. The others keep their places, so
 * removing it again gives back the list as it was.
 */
export function addMember(recipe: PlanRecipe, item: Member): void {
  const rank = ROLE_ORDER.indexOf(item.role);
  const at = recipe.crew.members.findIndex((other) => ROLE_ORDER.indexOf(other.role) > rank);
  recipe.crew.members.splice(at < 0 ? recipe.crew.members.length : at, 0, item);
}

/** The metered families a budget must set a limit for, in the order the form lists them. */
export function limitFamilies(recipe: PlanRecipe): MeteredFamily[] {
  if (recipe.run.handoff.auto) return [...MeteredFamilySchema.options];
  const named = new Set(recipe.crew.members.map((item) => item.selection.family));
  return MeteredFamilySchema.options.filter((family) => named.has(family));
}

/** The contract's rule for a path inside the project. */
export function projectPath(path: string): boolean {
  return (
    path.length >= 1 &&
    path.length <= 1024 &&
    path.isWellFormed() &&
    !/\p{Cc}/u.test(path) &&
    !path.startsWith('/') &&
    !/^[a-z]:/i.test(path) &&
    !path.includes('\\') &&
    !path
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  );
}

const oneLine = (value: string) => value.isWellFormed() && !/[\p{Cc}\u2028\u2029]/u.test(value);
// Tabs and line breaks are the only control characters text over several lines may hold.
const prose = (value: string) => value.isWellFormed() && !/[^\P{Cc}\n\r\t]/u.test(value);

export type Problem = { field: string; text: string };

/**
 * What keeps a draft from saving, in the contract's terms and the form's words. It takes the
 * draft from `tidy`, so `checks.{n}` names the row the form shows and an empty row has no line.
 * The field names the control the line sits under. A draft with no line here passes the contract
 * once `prepare` drops its empty rows.
 */
export function recipeProblems(
  recipe: PlanRecipe,
  available: Available,
  path: string | null = null,
  now: number = Date.now(),
): Problem[] {
  const problems: Problem[] = [];
  const add = (field: string, text: string) => problems.push({ field, text });
  // The controller refuses both at the save or the run, so the page holds the save back and
  // says why before anything is sent.
  const off = offLines(recipe, available);
  if (recipe.shape === 'report' && off.shape) add('shape', off.shape);
  if (!recipe.name.trim()) add('name', 'A recipe needs a name.');
  else if (!oneLine(recipe.name)) add('name', 'A name is one line.');
  if (!prose(recipe.description))
    add('description', 'A description cannot hold control characters.');
  if (path !== null && !projectPath(path)) add('path', 'A path inside the project.');
  if (!member(recipe, 'orchestrator') || !member(recipe, 'builder'))
    add('crew', 'A recipe needs an orchestrator and a builder.');
  for (const item of recipe.crew.members)
    if (!item.selection.model) add(`crew.${item.role}`, `Pick a model for the ${item.role}.`);
  if (recipe.shape === 'report' && !member(recipe, 'challenger'))
    add('crew', 'A report needs a challenger.');
  const { maxSlices } = recipe.run;
  if (!(Number.isInteger(maxSlices) && maxSlices >= 1 && maxSlices <= MAX_PLAN_SLICES))
    add('run.maxSlices', `Between 1 and ${MAX_PLAN_SLICES}.`);
  const commands = new Set<string>();
  for (const [index, check] of recipe.checks.entries()) {
    if (!oneLine(check.command)) add(`checks.${index}`, 'A command is one line.');
    else if (check.command && commands.has(check.command))
      add(`checks.${index}`, 'This command is already in the list.');
    commands.add(check.command);
  }
  const { trigger } = recipe;
  if (trigger.kind === 'manual') return problems;
  if (trigger.kind === 'interval') {
    if (!(trigger.everyMinutes >= 15)) add('trigger', 'At least 15 minutes.');
    else if (trigger.everyMinutes > MAX_INTERVAL_MINUTES) add('trigger', 'At most 7 days.');
  }
  if (trigger.kind === 'once' && !(Date.parse(trigger.at) > now))
    add('trigger', 'Pick a time in the future.');
  if (!recipe.work) add('work', 'A loop needs its work.');
  else if (recipe.work.kind === 'request') {
    if (!recipe.work.text.trim()) add('work', 'A loop needs its work.');
    else if (!prose(recipe.work.text)) add('work', 'A request cannot hold control characters.');
  } else if (recipe.shape === 'report') add('work', 'A report run takes a fixed request.');
  else if (off.work) add('work', off.work);
  else if (!recipe.work.path) add('work', 'A loop needs its work.');
  else if (!projectPath(recipe.work.path)) add('work', 'A path inside the project.');
  if (!recipe.budget) {
    add('budget', 'A loop needs a budget.');
    return problems;
  }
  if (!(recipe.budget.maxRuns >= 1)) add('budget.maxRuns', 'A loop needs a run limit.');
  else if (recipe.budget.maxRuns > 1000) add('budget.maxRuns', 'Between 1 and 1000.');
  for (const family of limitFamilies(recipe)) {
    const limit = recipe.budget.maxUsedPercent[family];
    if (limit === undefined) add(`budget.${family}`, `Set a limit for ${familyName(family)}.`);
    else if (!(limit >= 1 && limit <= 99)) add(`budget.${family}`, 'A limit is between 1 and 99.');
  }
  const { maxWaiting } = recipe.budget;
  if (!(maxWaiting >= 1 && maxWaiting <= 20)) add('budget.maxWaiting', 'Between 1 and 20.');
  return problems;
}

/** A recipe with an orchestrator and a builder on the first connected model, and nothing else. */
export function blankRecipe(catalog: ChatCatalogRead | null): PlanRecipe {
  const entry = catalog?.families.find((item) => item.connected && item.models.length > 0);
  const first = entry?.models[0];
  const selection = {
    family: entry?.family ?? ('openai' as const),
    model: first?.model ?? '',
    effort: first?.defaultEffort ?? 'default',
  };
  return {
    schema: 1,
    name: '',
    description: '',
    shape: 'change',
    crew: {
      name: 'Crew',
      members: [
        { role: 'orchestrator', selection: { ...selection } },
        { role: 'builder', selection: { ...selection } },
      ],
    },
    run: {
      flightMode: 'balanced',
      permissionPolicy: 'ask',
      handoff: { auto: false, mode: 'most-left' },
      maxSlices: 4,
    },
    checks: [],
    trigger: { kind: 'manual' },
    budget: null,
    work: null,
  };
}

/**
 * The draft with stray spaces gone from its name and each command. Rows left empty stay, so the
 * problems name the rows the form shows.
 */
export function tidy(draft: PlanRecipe): PlanRecipe {
  const next = structuredClone(draft);
  next.name = next.name.trim();
  next.checks = next.checks.map((check) => ({ command: check.command.trim() }));
  return next;
}

/**
 * A form draft as it saves: tidied, with check rows left empty dropped. A recipe that was never
 * saved takes its name as its crew's name.
 */
export function prepare(draft: PlanRecipe, fresh: boolean): PlanRecipe {
  const next = tidy(draft);
  if (fresh) next.crew.name = next.name.slice(0, 60) || 'Crew';
  next.checks = next.checks.filter((check) => check.command);
  return next;
}

/** What the editor holds when it saves. `read` is the controller's last answer for the recipe. */
export type SaveState = {
  draft: PlanRecipe;
  read: { file: PlanRecipeFile; recipe: PlanRecipe | null } | null;
  /** The form shows the file's own version. */
  showsFile: boolean;
  /** CrewKite has no record of this recipe yet. */
  fresh: boolean;
};

/**
 * Whether a save records the file's own version: the form shows it, CrewKite does not hold the
 * file as it stands (never saved here, or changed on disk), and the draft is the file exactly as
 * last read. A file that moved again since, or a flag left on after the file came back, makes the
 * draft a form draft like any other.
 */
export function sendsFileVersion({ draft, read, showsFile }: SaveState): boolean {
  return (
    showsFile &&
    (read?.file === 'unrecorded' || read?.file === 'changed') &&
    read.recipe !== null &&
    sameRecipe(draft, read.recipe)
  );
}

/**
 * The body a save sends. A file's own version goes exactly as read, since the controller records
 * it only when the body hashes like the file. Anything else is the form's draft, prepared.
 */
export function saveBody(state: SaveState): PlanRecipe {
  return sendsFileVersion(state) ? state.draft : prepare(state.draft, state.fresh);
}

/** True when two drafts hold the same recipe, whatever order their keys were written in. */
export const sameRecipe = (a: PlanRecipe, b: PlanRecipe): boolean => stable(a) === stable(b);

/** What the editor holds at the moment an answer from the controller is applied to it. */
export type EditorNow = {
  /** A save, a run, a review opening, a schedule action or a Forget is under way. */
  busy: boolean;
  /** The draft differs from the version it is measured against. */
  touched: boolean;
  panel: 'review' | 'run' | 'forget' | null;
  /** An older version is only being looked at. */
  older: boolean;
  /** The form shows the file's own version, only to be looked at and saved as read. */
  showsFile: boolean;
  /** The version on screen, the one a save expects and a run starts. Zero before any record. */
  version: number;
};

/** The parts of an answer the rule reads. */
export type AnswerNow = {
  version: number;
  /** The file still has a version of its own to show: never saved here, or changed on disk. */
  fileVersion: boolean;
};

export type AnswerPlan =
  /** Keep the answer and decide it once the step ends, however it ends. */
  | { act: 'hold' }
  /** Take the answer as the editor's state. */
  | { act: 'adopt'; closePanel: boolean; keepFile: boolean; said: number | null }
  /** Keep the edits and measure them against the newer version. */
  | { act: 'rebase'; stale: number }
  /** Keep the edits. Only the banner, the strip and the version line follow the answer. */
  | { act: 'read' };

/**
 * What one answer from the controller does to the editor: a refresh, the read after a save, after
 * a schedule action, or after a step that was refused or failed. A busy step holds it. Edits are
 * never replaced, only measured against a newer version. With nothing of the person's in the form,
 * the answer is taken as it is, and a review or a run that was open against a version that moved
 * closes, so neither can save or start a version other than the one on screen.
 */
export function planAnswer(now: EditorNow, answer: AnswerNow): AnswerPlan {
  if (now.busy) return { act: 'hold' };
  const moved = answer.version !== now.version;
  if (now.touched) return moved ? { act: 'rebase', stale: answer.version } : { act: 'read' };
  return {
    act: 'adopt',
    closePanel: moved && (now.panel === 'review' || now.panel === 'run'),
    // A file's version stays on screen while it is still the file's and the version held still.
    keepFile: now.showsFile && !moved && answer.fileVersion,
    said: moved ? answer.version : null,
  };
}

/** A file name from a recipe's name: lower case words joined by hyphens. */
export function slug(name: string): string {
  const words = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return words || 'recipe';
}

export const defaultPath = (folder: string, name: string) => `${folder}/${slug(name)}.json`;

/** `{n} files`, as the runs table counts what a run changed. */
export const filesWords = (count: number | null) =>
  count === null ? 'Unknown' : count === 1 ? '1 file' : `${count} files`;
