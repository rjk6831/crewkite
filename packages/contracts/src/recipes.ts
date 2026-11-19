import { z } from 'zod';
import {
  ChatCrewRoleSchema,
  ChatCrewSchema,
  ChatFamilySchema,
  ChatHandoffModeSchema,
  ChatPermissionPolicySchema,
  MAX_PLAN_SLICES,
} from './chat.ts';

// A recipe keeps the setup of a plan run so it can run again: the crew, how the run asks, the
// checks and, when it runs on a schedule, its trigger, budget and source of work. The canonical
// copy is one JSON file in the project, in a folder the person picks, so people and their other
// tools read the same source (the ADR 0055 precedent). The controller records each version it
// saved and its hash. Only a recorded version runs: an edit on disk never starts a run or arms a
// schedule until the person reviews and saves it.
//
// A recipe is data. The plan runner decides the step order and which role takes each step, and
// the orchestrator still splits each request into slices at run time. The file holds what the
// runner honors and nothing it would ignore.
//
// The older task path uses the word recipe for a fixed check command (ProjectCommandRecipeSchema,
// and `recipeId` on its payloads). Schemas and types here carry Plan in their names. Commands,
// read kinds and the `recipeId` field of these payloads share the plain word, and a recipe ID
// here always starts with rcp_.

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) => value.isWellFormed() && !/[\p{Cc}\u2028\u2029]/u.test(value),
      'One line of text without control characters.',
    );
/**
 * Text that may run over several lines. Tabs, line feeds and carriage returns are its only
 * control characters, so text pasted on any platform passes as it is.
 */
const prose = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(
      (value) => value.isWellFormed() && !/[^\P{Cc}\n\r\t]/u.test(value),
      'Text without control characters other than tabs and line breaks.',
    );
const projectPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      path.isWellFormed() &&
      !/\p{Cc}/u.test(path) &&
      !path.startsWith('/') &&
      !/^[a-z]:/i.test(path) &&
      !path.includes('\\') &&
      !path
        .split('/')
        .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'),
    'A relative path inside the project.',
  );
const count = z.number().int().nonnegative();

export const PlanRecipeIdSchema = id('rcp');
export const PlanRecipeRunIdSchema = id('rrn');

/** The folder a project's picker offers before the person chose one. */
export const PLAN_RECIPE_FOLDER = '.crewkite/recipes';
/** The most bytes one recipe takes as compact JSON. The file on disk is indented and larger. */
export const PLAN_RECIPE_BYTES = 64 * 1024;
/** The most recipe files one folder lists. The rest are counted and not read. */
export const MAX_PLAN_RECIPES = 64;
/** The most saved versions one read returns, newest first. */
export const MAX_PLAN_RECIPE_VERSIONS = 50;
/** The most checks one recipe turns on, which is the most a thread holds. */
export const MAX_PLAN_RECIPE_CHECKS = 16;
/** A schedule stops after this many runs in a row that changed nothing and found nothing. */
export const PLAN_SCHEDULE_DRY_RUNS = 2;
/** An allowance reading older than this counts as unknown. A schedule never estimates one. */
export const PLAN_SCHEDULE_READING_MS = 15 * 60 * 1000;
/** At most this many runs start for the starts a schedule missed while CrewKite was closed. */
export const PLAN_SCHEDULE_CATCH_UP = 1;

/** A family with a metered allowance. Local has none, so it takes no limit. */
export const MeteredFamilySchema = z.enum(['openai', 'anthropic', 'google']);
export type MeteredFamily = z.infer<typeof MeteredFamilySchema>;

/**
 * What starts a run. manual: only the person. once: at one time. interval: every so many minutes,
 * on a grid that starts when the schedule was armed. reset: when that family's tightest allowance
 * window resets.
 */
export const PlanRecipeTriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual') }),
  z.strictObject({ kind: z.literal('once'), at: timestamp }),
  z.strictObject({
    kind: z.literal('interval'),
    everyMinutes: z
      .number()
      .int()
      .min(15)
      .max(7 * 24 * 60),
  }),
  z.strictObject({ kind: z.literal('reset'), family: MeteredFamilySchema }),
]);
export type PlanRecipeTrigger = z.infer<typeof PlanRecipeTriggerSchema>;

/**
 * The brakes on a schedule. Before every turn of a scheduled run on a metered family, the turn
 * does not start when that family reads above its percent used, has no current reading or has no
 * limit here. A turn on Local is never checked. The same rule decides whether a run starts at
 * all, over every metered family its crew names. The schedule pauses while `maxWaiting` runs wait for the person, and it
 * stops after `maxRuns` starts. A run the person starts by hand applies none of this.
 */
export const PlanRecipeBudgetSchema = z.strictObject({
  maxRuns: z.number().int().min(1).max(1000),
  /** Percent used of the tightest window, per family. */
  maxUsedPercent: z.partialRecord(MeteredFamilySchema, z.number().int().min(1).max(99)),
  maxWaiting: z.number().int().min(1).max(20).default(3),
});
export type PlanRecipeBudget = z.infer<typeof PlanRecipeBudgetSchema>;

/**
 * Where a scheduled run takes its request from. request: the same words every run. checklist: the
 * first unchecked item of a markdown checklist in the project, and the run proposes ticking it as
 * part of its change. A checklist item is text from the repository that becomes the request of a
 * run nobody watches, so it carries the authority of whoever can change that file.
 *
 * A run that is running, asked, ready or accepted holds its item, and the next start passes that
 * item over. Accept moves no HEAD, so an accepted item reads unchecked there until the change is
 * committed. An item edited after a run took it is a new item.
 */
export const PlanRecipeWorkSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('request'), text: prose(1, 8000) }),
  z.strictObject({ kind: z.literal('checklist'), path: projectPath }),
]);
export type PlanRecipeWork = z.infer<typeof PlanRecipeWorkSchema>;

/**
 * One check the run turns on, as the command the person wrote. The thread labels it the way it
 * labels any check. The same set gates every stage. A command follows the rule a thread applies
 * to a check a person adds: plain words, no shell, wrapper or inline code. A save refuses one that
 * breaks it, and so does a run, since the file comes from the repository. Commands are compared
 * in the thread's normalized form. A thread holds 16 checks counting the ones it detects, so a
 * run whose recipe does not fit refuses with one line.
 */
export const PlanRecipeCheckSchema = z.strictObject({ command: line(500) });

/**
 * The file. change: the crew edits files and the run ends ready for Accept. report: every slice
 * only reads, then the challenger argues against the findings and the orchestrator writes the
 * ones that stand into one message.
 */
export const PlanRecipeSchema = z
  .strictObject({
    schema: z.literal(1),
    name: line(80),
    description: prose(0, 1000),
    shape: z.enum(['change', 'report']),
    crew: ChatCrewSchema,
    run: z.strictObject({
      /** Manual runs no plan, so a recipe cannot hold it. */
      flightMode: z.enum(['balanced', 'glide']),
      permissionPolicy: ChatPermissionPolicySchema,
      /**
       * The thread's handoff settings, applied after the flight mode so Glide does not turn auto
       * back on. With auto off a step whose provider reaches a limit stops and says so. The mode
       * still ranks where a step paused for credits moves, as on any thread.
       */
      handoff: z.strictObject({ auto: z.boolean(), mode: ChatHandoffModeSchema }),
      /** The most slices the orchestrator may propose for one request. */
      maxSlices: z.number().int().min(1).max(MAX_PLAN_SLICES),
    }),
    checks: z.array(PlanRecipeCheckSchema).max(MAX_PLAN_RECIPE_CHECKS),
    trigger: PlanRecipeTriggerSchema,
    /** Null for a manual recipe. Any other trigger needs one. */
    budget: PlanRecipeBudgetSchema.nullable(),
    /** Null for a manual recipe, which takes its request when it is run. */
    work: PlanRecipeWorkSchema.nullable(),
  })
  .refine(
    (recipe) => recipe.crew.members.some((member) => member.role === 'orchestrator'),
    'A recipe needs an orchestrator, since a recipe run is a plan.',
  )
  .refine(
    (recipe) =>
      recipe.shape !== 'report' ||
      recipe.crew.members.some((member) => member.role === 'challenger'),
    'A report recipe needs a challenger.',
  )
  .refine(
    // A checklist run is asked to tick its item, and a report writes nothing.
    (recipe) => recipe.shape !== 'report' || recipe.work?.kind !== 'checklist',
    'A report recipe takes a fixed request.',
  )
  .refine(
    (recipe) => new Set(recipe.checks.map((check) => check.command)).size === recipe.checks.length,
    'A recipe names each check command once.',
  )
  .refine(
    (recipe) => (recipe.trigger.kind === 'manual') === (recipe.budget === null),
    'A loop needs a budget, and a manual recipe has none.',
  )
  .refine(
    (recipe) => (recipe.trigger.kind === 'manual') === (recipe.work === null),
    'A loop needs its work, and a manual recipe takes its request when it runs.',
  )
  .refine((recipe) => {
    if (recipe.budget === null) return true;
    const limits = recipe.budget.maxUsedPercent;
    // A handoff can move a step to any family, so every metered one needs its limit then.
    const families = recipe.run.handoff.auto
      ? MeteredFamilySchema.options
      : recipe.crew.members.map((member) => member.selection.family);
    return families.every((family) => family === 'local' || limits[family] !== undefined);
  }, 'A budget sets a limit for every metered provider a run can reach.')
  .refine(
    (recipe) => new TextEncoder().encode(JSON.stringify(recipe)).length <= PLAN_RECIPE_BYTES,
    'A recipe stays within its byte bound.',
  );
export type PlanRecipe = z.infer<typeof PlanRecipeSchema>;

/** Where one recipe lives and which saved version is current. */
export const PlanRecipeRecordSchema = z.strictObject({
  id: PlanRecipeIdSchema,
  projectId: id('prj'),
  path: projectPath,
  version: z.number().int().min(1),
  /**
   * hashCanonical of the parsed recipe of the saved version. Parsing fills defaults, so the hash
   * is taken over the parsed value and never over the file's own text. Runs and results name a
   * version by it.
   */
  versionHash: hash,
  updatedAt: timestamp,
});
export type PlanRecipeRecord = z.infer<typeof PlanRecipeRecordSchema>;

/**
 * The file against the recorded hash. unrecorded: a file in the folder that CrewKite never saved,
 * such as one a teammate committed. It runs nothing until the person reviews and saves it.
 */
export const PlanRecipeFileSchema = z.enum([
  'current',
  'changed',
  'missing',
  'invalid',
  'unrecorded',
]);
export type PlanRecipeFile = z.infer<typeof PlanRecipeFileSchema>;

/**
 * active: armed, with a next start unless a run is going. paused: holds until its cause is gone.
 * stopped: finished or halted, and only the person starts it again.
 *
 * A pause set by the person, by a checklist that cannot be read, or by a start the controller
 * refused, lifts on resume. A pause at
 * the waiting limit lifts on its own when a run stops waiting. A pause caused by the recipe file
 * lifts only when the person saves, and resume refuses while the file is not the armed version.
 * A save keeps the state and the counts, arms the new version, lifts a pause the file caused and
 * leaves a stopped schedule stopped. restart arms a stopped schedule with its counts at zero.
 */
export const PlanScheduleStateSchema = z.enum(['active', 'paused', 'stopped']);
export type PlanScheduleState = z.infer<typeof PlanScheduleStateSchema>;

/**
 * Why a schedule paused, stopped or passed over a start. `planScheduleLine` turns one into the
 * sentence the person reads, so the desktop, the CLI and the webhook say the same words.
 * run-active means the newest run is still running. A run that waits on the person does not hold
 * the next start: it counts toward the waiting limit.
 */
export const PlanScheduleNoteSchema = z.discriminatedUnion('code', [
  z.strictObject({ code: z.literal('run-limit'), at: timestamp, runs: z.number().int().min(1) }),
  z.strictObject({ code: z.literal('dry-runs'), at: timestamp }),
  z.strictObject({ code: z.literal('once-done'), at: timestamp }),
  z.strictObject({ code: z.literal('checklist-done'), at: timestamp, path: projectPath }),
  z.strictObject({ code: z.literal('by-person'), at: timestamp }),
  z.strictObject({
    code: z.literal('waiting-limit'),
    at: timestamp,
    waiting: z.number().int().min(1),
  }),
  z.strictObject({ code: z.literal('recipe-changed'), at: timestamp }),
  z.strictObject({ code: z.literal('recipe-missing'), at: timestamp }),
  z.strictObject({ code: z.literal('recipe-invalid'), at: timestamp }),
  z.strictObject({ code: z.literal('checklist-unreadable'), at: timestamp, path: projectPath }),
  /** A start the controller refused for a reason no other note names, in its own sentence. */
  z.strictObject({ code: z.literal('start-refused'), at: timestamp, reason: line(300) }),
  z.strictObject({ code: z.literal('run-active'), at: timestamp }),
  z.strictObject({
    code: z.literal('allowance-unknown'),
    at: timestamp,
    family: MeteredFamilySchema,
  }),
  /**
   * A reset schedule has no next start because the provider's reading names no reset time. No
   * start was due and none was passed over.
   */
  z.strictObject({ code: z.literal('reset-unknown'), at: timestamp, family: MeteredFamilySchema }),
  z.strictObject({
    code: z.literal('allowance-limit'),
    at: timestamp,
    family: MeteredFamilySchema,
    /** The reading rounded up, so a line never shows a value equal to the limit it crossed. */
    used: z.number().int().min(0).max(100),
    limit: z.number().int().min(1).max(99),
  }),
  z.strictObject({ code: z.literal('not-connected'), at: timestamp, family: ChatFamilySchema }),
  z.strictObject({ code: z.literal('model-unknown'), at: timestamp, family: ChatFamilySchema }),
  z.strictObject({ code: z.literal('terms-pending'), at: timestamp, family: ChatFamilySchema }),
  z.strictObject({ code: z.literal('missed'), at: timestamp, runs: z.number().int().min(1) }),
]);
export type PlanScheduleNote = z.infer<typeof PlanScheduleNoteSchema>;

const FAMILY_NAME = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', local: 'Local' };
const plural = (value: number, one: string, many: string) =>
  value === 1 ? `1 ${one}` : `${value} ${many}`;

/** The one line a person reads for a schedule note. */
export function planScheduleLine(note: PlanScheduleNote): string {
  switch (note.code) {
    case 'run-limit':
      return `Stopped. The run limit of ${note.runs} is reached.`;
    case 'dry-runs':
      // The sentence states PLAN_SCHEDULE_DRY_RUNS in words. Change them together.
      return 'Stopped. Two runs in a row changed nothing and found nothing.';
    case 'once-done':
      return 'Done. It ran once.';
    case 'checklist-done':
      return `Stopped. Every item in ${note.path} is checked.`;
    case 'by-person':
      return 'Paused by you.';
    case 'waiting-limit':
      return `Paused. ${plural(note.waiting, 'run is', 'runs are')} waiting for you.`;
    case 'recipe-changed':
      return 'Paused. The recipe file changed on disk. Review it and save to continue.';
    case 'recipe-missing':
      return 'Paused. The recipe file is missing. Open the recipe to write it again or forget it.';
    case 'recipe-invalid':
      return 'Paused. The recipe file no longer reads as a recipe. Open the recipe to see why.';
    case 'checklist-unreadable':
      return `Paused. ${note.path} cannot be read. Fix the file, then resume.`;
    case 'start-refused':
      return `Paused. The run could not start. ${note.reason}`;
    case 'run-active':
      return 'Skipped. The last run is still going.';
    case 'allowance-unknown':
      return `Did not start. CrewKite has no current allowance reading for ${FAMILY_NAME[note.family]}.`;
    case 'reset-unknown':
      return `Waiting. ${FAMILY_NAME[note.family]} has not reported when its allowance resets.`;
    case 'allowance-limit':
      return `Did not start. ${FAMILY_NAME[note.family]} is at ${note.used}% used. The limit for this loop is ${note.limit}%.`;
    case 'not-connected':
      return `Did not start. ${FAMILY_NAME[note.family]} is not connected.`;
    case 'model-unknown':
      return `Did not start. ${FAMILY_NAME[note.family]} no longer lists a model this recipe names.`;
    case 'terms-pending':
      return `Did not start. Accept the ${FAMILY_NAME[note.family]} terms in Settings first.`;
    case 'missed':
      return `Skipped ${plural(note.runs, 'run', 'runs')} while CrewKite was closed.`;
  }
}

/**
 * Where a run stands. asked: it waits on a question, such as a plan approval or a permission.
 * ready: it ended with changes and waits for Accept. no-change: it ended and changed nothing.
 * reported: a report run ended with its message. asked and ready count as waiting for the person.
 *
 * Accept settles a ready run as accepted. Discarding every change settles it as discarded.
 * Deleting the run's thread settles it too: running and asked become stopped, and ready becomes
 * discarded. A run never waits on a thread that is gone.
 */
export const PlanRecipeRunStateSchema = z.enum([
  'running',
  'asked',
  'ready',
  'accepted',
  'discarded',
  'no-change',
  'reported',
  'failed',
  'stopped',
]);
export type PlanRecipeRunState = z.infer<typeof PlanRecipeRunStateSchema>;

/** One family's tightest window at one moment. Null where the controller had no reading. */
export const AllowanceReadingSchema = z.strictObject({
  family: MeteredFamilySchema,
  used: z.number().min(0).max(100).nullable(),
  /** The catalog's name for the window the reading is of. Percents of two windows never add. */
  window: z.string().min(1).max(60).nullable(),
  observedAt: timestamp.nullable(),
});
export type AllowanceReading = z.infer<typeof AllowanceReadingSchema>;

/** One run of a recipe. Each run is its own thread in its own copy. */
export const PlanRecipeRunSchema = z.strictObject({
  id: PlanRecipeRunIdSchema,
  recipeId: PlanRecipeIdSchema,
  projectId: id('prj'),
  /** The run's thread. The record outlives it, so results still count a deleted thread's run. */
  taskId: id('tsk'),
  /** The recipe version the run used. */
  version: z.number().int().min(1),
  versionHash: hash,
  /**
   * The run type of that version, kept on the run because forgetting the recipe drops its saved
   * versions and the run's thread must still know whether it only reports.
   */
  shape: z.enum(['change', 'report']).optional(),
  origin: z.enum(['manual', 'schedule']),
  /**
   * The checklist item the run took: its text with control characters turned into spaces, cut at
   * 500 characters.
   */
  item: line(500).nullable(),
  state: PlanRecipeRunStateSchema,
  /** Findings the reviews stated, or the findings a report kept. Null while unknown. */
  findings: count.nullable(),
  changedFiles: count.nullable(),
  /** Why a run failed or stopped, in words for the person. */
  reason: line(300).nullable(),
  startedAt: timestamp,
  endedAt: timestamp.nullable(),
  /** Readings at the start and at the end, one per metered family the crew names. */
  allowance: z.strictObject({
    start: z.array(AllowanceReadingSchema).max(3),
    end: z.array(AllowanceReadingSchema).max(3).nullable(),
  }),
});
export type PlanRecipeRun = z.infer<typeof PlanRecipeRunSchema>;

/**
 * One check as the person approved it for scheduled runs: the command they wrote, what it
 * resolved to, and the digest a thread pins a check by, which covers the command and the script
 * behind it. All three are taken from the project's committed HEAD, the base a run's copy starts
 * from, so an uncommitted edit plays no part. A scheduled run approves its checks only when every
 * one resolves to the same digest in the run's copy. Any other run asks first, as a thread does
 * for a changed check. The approval covers the script, never the code the script runs: a check
 * still runs tests the builder wrote. It lives in CrewKite's database and never in the recipe
 * file.
 */
export const PlanScheduleApprovalSchema = z.strictObject({
  command: line(500),
  resolved: z.string().min(1).max(500),
  digest: hash,
});

/** A schedule. It exists while the saved version has a trigger. */
export const PlanScheduleSchema = z.strictObject({
  recipeId: PlanRecipeIdSchema,
  projectId: id('prj'),
  /** The recipe version the person armed. Another version on disk pauses the schedule. */
  version: z.number().int().min(1),
  versionHash: hash,
  state: PlanScheduleStateSchema,
  /** Why it is paused or stopped, or the last start it passed over. */
  note: PlanScheduleNoteSchema.nullable(),
  /** When the person armed this version. An interval's grid starts here. */
  armedAt: timestamp,
  nextAt: timestamp.nullable(),
  runsStarted: count,
  maxRuns: z.number().int().min(1),
  /** Runs that wait for the person now. */
  waiting: count,
  dryRuns: z.number().int().min(0).max(PLAN_SCHEDULE_DRY_RUNS),
  lastRun: PlanRecipeRunSchema.pick({
    id: true,
    taskId: true,
    state: true,
    startedAt: true,
    endedAt: true,
  })
    .extend({
      /**
       * Whether the run's thread still exists, as the schedules read found it. A run outlives its
       * thread, so a client offers to open the thread only when this is not false. Absent where
       * nothing checked.
       */
      thread: z.boolean().optional(),
    })
    .nullable(),
});
export type PlanSchedule = z.infer<typeof PlanScheduleSchema>;

/** A schedule as the controller stores it: what clients list, plus what the person approved. */
export const PlanScheduleRecordSchema = PlanScheduleSchema.extend({
  approved: z.array(PlanScheduleApprovalSchema).max(MAX_PLAN_RECIPE_CHECKS),
});
export type PlanScheduleRecord = z.infer<typeof PlanScheduleRecordSchema>;

/** One recipe in a project's list. */
export const PlanRecipeEntrySchema = z.strictObject({
  path: projectPath,
  /** Null for a file CrewKite never saved. */
  record: PlanRecipeRecordSchema.nullable(),
  file: PlanRecipeFileSchema,
  /** From the file while it parses, else from the saved version. Null when neither reads. */
  name: line(80).nullable(),
  description: prose(0, 1000).nullable(),
  trigger: PlanRecipeTriggerSchema.nullable(),
  /** The first problem of a file that does not read, with its line. */
  problem: line(500).nullable(),
  schedule: PlanScheduleSchema.nullable(),
});
export type PlanRecipeEntry = z.infer<typeof PlanRecipeEntrySchema>;

export const ReadRecipesPayloadSchema = z.strictObject({ projectId: id('prj') });
export const PlanRecipesReadSchema = z.strictObject({
  projectId: id('prj'),
  /** The folder the person picked. Null until they pick one or save a first recipe. */
  folder: projectPath.nullable(),
  recipes: z.array(PlanRecipeEntrySchema).max(MAX_PLAN_RECIPES),
  /** Files in the folder past the list bound. */
  more: count,
  /**
   * The choices this controller lets a recipe use, read from the options that switch them. A
   * client offers a choice only while it is on, so turning an option on brings it back.
   */
  available: z.strictObject({ checklistWork: z.boolean(), reportRuns: z.boolean() }),
});
export type PlanRecipesRead = z.infer<typeof PlanRecipesReadSchema>;

export const SetRecipeFolderPayloadSchema = z.strictObject({
  projectId: id('prj'),
  path: projectPath,
});

/** Whether a crew member can take a turn now. */
export const PlanRecipeReadinessSchema = z.strictObject({
  role: ChatCrewRoleSchema,
  family: ChatFamilySchema,
  ready: z.boolean(),
  /**
   * not-connected: the family has no ready connection. model-unknown: its catalog lacks the
   * model. terms-pending: the family's terms are not acknowledged yet.
   */
  reason: z.enum(['not-connected', 'model-unknown', 'terms-pending']).nullable(),
});

/** Reads one recipe by its record or, for a file never saved, by its path. */
export const ReadRecipePayloadSchema = z
  .strictObject({
    projectId: id('prj'),
    recipeId: PlanRecipeIdSchema.optional(),
    path: projectPath.optional(),
    /** A saved version to read as `saved`. The current one when left out. */
    version: z.number().int().min(1).optional(),
  })
  .refine(
    (payload) => (payload.recipeId === undefined) !== (payload.path === undefined),
    'Name the recipe by its ID or by its path.',
  );
export const PlanRecipeReadSchema = z.strictObject({
  entry: PlanRecipeEntrySchema,
  /** The file's content while it parses. Null for a missing or invalid file. */
  recipe: PlanRecipeSchema.nullable(),
  /** The saved version asked for. Null for a file never saved. */
  saved: PlanRecipeSchema.nullable(),
  savedVersion: z.number().int().min(1).nullable(),
  versions: z
    .array(
      z.strictObject({ version: z.number().int().min(1), versionHash: hash, savedAt: timestamp }),
    )
    .max(MAX_PLAN_RECIPE_VERSIONS),
  /** Older versions past the list bound. */
  moreVersions: count,
  /** One entry per crew member of `recipe`, or of `saved` when the file does not read. */
  readiness: z.array(PlanRecipeReadinessSchema).max(5),
  /** What the armed schedule approved. Empty for a recipe with no schedule. */
  approved: z.array(PlanScheduleApprovalSchema).max(MAX_PLAN_RECIPE_CHECKS),
});
export type PlanRecipeRead = z.infer<typeof PlanRecipeReadSchema>;

/**
 * What a list of check commands resolves to at the project's committed HEAD. The save confirmation
 * asks this for the draft's checks, so the person sees what they approve before any of it is
 * saved. `resolved` and `digest` are null where a command resolves to nothing the project has. A
 * recipe with a trigger cannot be saved with such a check.
 */
export const ResolveRecipeChecksPayloadSchema = z.strictObject({
  projectId: id('prj'),
  commands: z.array(line(500)).max(MAX_PLAN_RECIPE_CHECKS),
});
export const PlanRecipeChecksSchema = z.strictObject({
  /** One entry per command, in the order asked. */
  resolved: z
    .array(
      z.strictObject({
        command: line(500),
        resolved: z.string().min(1).max(500).nullable(),
        digest: hash.nullable(),
      }),
    )
    .max(MAX_PLAN_RECIPE_CHECKS),
});
export type PlanRecipeChecks = z.infer<typeof PlanRecipeChecksSchema>;

/**
 * Saves a new version after the person confirmed the diff, and writes the file. A stale expected
 * version refuses, and so does a file that changed on disk since the last save. Saving a version
 * with a trigger arms its schedule for that version and records what each check resolves to as
 * the approval for scheduled runs. `seen` is what the confirmation showed. A check that resolves
 * to another digest by the time of the save refuses, so nothing is approved unseen.
 */
export const SaveRecipePayloadSchema = z.strictObject({
  projectId: id('prj'),
  /** Left out for a first save, which creates the record. */
  recipeId: PlanRecipeIdSchema.optional(),
  path: projectPath,
  body: PlanRecipeSchema,
  /** The version the edit started from. Zero for the first save. */
  expectedVersion: count,
  /**
   * The command and digest of each check as ResolveRecipeChecks showed them. Required with a trigger, in
   * the order of `body.checks`. Left out for a manual recipe, which approves nothing.
   */
  seen: z
    .array(z.strictObject({ command: line(500), digest: hash }))
    .max(MAX_PLAN_RECIPE_CHECKS)
    .optional(),
  confirm: z.literal('explicit'),
});
/** What a save changed, by field path such as `crew.reviewer.model` or `budget.maxRuns`. */
export const PlanRecipeSavedSchema = z.strictObject({
  record: PlanRecipeRecordSchema,
  changed: z.array(z.string().min(1).max(200)).max(200),
  schedule: PlanScheduleSchema.nullable(),
  approved: z.array(PlanScheduleApprovalSchema).max(MAX_PLAN_RECIPE_CHECKS),
});

/** Drops CrewKite's record, its versions and its schedule. The file, runs and results stay. */
export const ForgetRecipePayloadSchema = z.strictObject({
  recipeId: PlanRecipeIdSchema,
  confirm: z.literal('explicit'),
});

/** Drafts a recipe from what a finished plan thread did. It saves nothing. */
export const DraftRecipePayloadSchema = z.strictObject({ taskId: id('tsk') });
export const PlanRecipeDraftSchema = z.strictObject({
  recipe: PlanRecipeSchema,
  /** What the thread no longer records, so the draft holds a default there. One line each. */
  defaults: z.array(line(200)).max(16),
});
export type PlanRecipeDraft = z.infer<typeof PlanRecipeDraftSchema>;

/**
 * Runs the saved version on a new request: a new thread in its own copy, set up from the recipe,
 * with the request sent. A file that differs from the saved version refuses, and so does a crew
 * member who is not ready. With `versionHash`, a recipe saved again since the person looked
 * refuses too.
 */
export const RunRecipePayloadSchema = z.strictObject({
  recipeId: PlanRecipeIdSchema,
  request: prose(1, 8000),
  versionHash: hash.optional(),
});
export const PlanRecipeRunStartedSchema = z.strictObject({ run: PlanRecipeRunSchema });

/** pause holds an active schedule. resume and restart follow the rules on the schedule state. */
export const SetRecipeSchedulePayloadSchema = z.strictObject({
  recipeId: PlanRecipeIdSchema,
  action: z.enum(['pause', 'resume', 'restart']),
});

export const MAX_PLAN_SCHEDULES = 200;
/** Every schedule, or one project's. */
export const ReadSchedulesPayloadSchema = z.strictObject({ projectId: id('prj').optional() });
export const PlanSchedulesReadSchema = z.strictObject({
  schedules: z
    .array(
      z.strictObject({
        schedule: PlanScheduleSchema,
        name: line(80),
        path: projectPath,
        trigger: PlanRecipeTriggerSchema,
      }),
    )
    .max(MAX_PLAN_SCHEDULES),
  /** Schedules past the list bound. */
  more: count,
});
export type PlanSchedulesRead = z.infer<typeof PlanSchedulesReadSchema>;

/** A recipe's runs, newest first, or the one run a thread belongs to. */
export const ReadRecipeRunsPayloadSchema = z
  .strictObject({
    recipeId: PlanRecipeIdSchema.optional(),
    taskId: id('tsk').optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .refine(
    (payload) => (payload.recipeId === undefined) !== (payload.taskId === undefined),
    'Name a recipe or a thread.',
  );
export const PlanRecipeRunsReadSchema = z.strictObject({
  /** Newest first. Empty for a thread that is no recipe run. */
  runs: z.array(PlanRecipeRunSchema).max(100),
  /** Older runs past `limit`. */
  more: count,
  /** The recipe's name when its record still exists. */
  name: line(80).nullable(),
});
export type PlanRecipeRunsRead = z.infer<typeof PlanRecipeRunsReadSchema>;

/** Tells a client that a project's recipes, schedules or runs changed, so it reads them again. */
export const PlanRecipesChangedSchema = z.strictObject({
  projectId: id('prj'),
  recipeId: PlanRecipeIdSchema.nullable(),
});
