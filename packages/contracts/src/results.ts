import { z } from 'zod';
import {
  ChatCrewRoleSchema,
  ChatEffortSchema,
  ChatFamilySchema,
  ChatTurnIdSchema,
} from './chat.ts';
import {
  MeteredFamilySchema,
  PlanRecipeIdSchema,
  PlanRecipeRunIdSchema,
  PlanRecipeRunSchema,
} from './recipes.ts';

// What each step of a plan produced, written by the controller as the step settles. The records
// stay on this device. They are the base for comparing setups later, so a value the controller
// did not observe is stored as unknown and never filled in from a guess.

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
const count = z.number().int().nonnegative();

export const SliceResultIdSchema = id('srs');

/** The most records one page of an export holds. A page fits one protocol frame. */
export const MAX_RESULT_RECORDS = 500;
/** The most runs one page holds. A run is larger than a record, so a page holds fewer. */
export const MAX_RESULT_RUNS = 250;

/**
 * A step of a plan. The first five are a slice's lane steps. challenge and report belong to the
 * whole plan: the challenger's turn after the last slice, and the orchestrator's closing message
 * of a report run.
 */
export const ResultStepSchema = z.enum([
  'build',
  'review',
  'fix',
  'merge',
  'resolve',
  'challenge',
  'report',
]);
export type ResultStep = z.infer<typeof ResultStepSchema>;

/**
 * One step of one attempt: who ran it and what came of it. Repeated rounds of a step fold into
 * its record. A retried slice and a second plan on the same thread are new attempts with their
 * own records. Null means the controller has no value: the step has no role (a merge), the
 * thread ran outside a recipe, or the fact was never observed.
 */
export const SliceResultSchema = z.strictObject({
  id: SliceResultIdSchema,
  projectId: id('prj'),
  taskId: id('tsk'),
  /**
   * The turn that anchors the attempt: the slice's builder turn for a lane step, and the plan's
   * orchestrator turn for a challenge or a report, so a challenge that reruns after a usage limit
   * stays one record. One record exists per anchor and step.
   */
  anchorTurnId: ChatTurnIdSchema,
  recipeId: PlanRecipeIdSchema.nullable(),
  /** The recipe version the run used. */
  recipeHash: hash.nullable(),
  runId: PlanRecipeRunIdSchema.nullable(),
  /** Null for a challenge or a report, which belong to the whole plan. */
  slice: z.number().int().min(1).max(8).nullable(),
  step: ResultStepSchema,
  /** The crew role the step ran as, and the selection of its first turn. Null for a merge. */
  role: ChatCrewRoleSchema.nullable(),
  family: ChatFamilySchema.nullable(),
  model: z.string().min(1).max(200).nullable(),
  effort: ChatEffortSchema.nullable(),
  /** The digest of the writing rules the step's first turn received. */
  rulesDigest: hash.nullable(),
  /** The design system version the step's first turn received. */
  designVersionHash: hash.nullable(),
  /** The first check run after this step. none: no check ran. */
  firstGate: z.enum(['passed', 'failed', 'none', 'unknown']),
  /** The first review of this step's work. none: no review ran. */
  firstReview: z.enum(['clean', 'findings', 'none', 'unknown']),
  /** Findings the first review stated. */
  findings: count.nullable(),
  /** Fix turns the slice took after this step. */
  fixRounds: count.nullable(),
  /**
   * What became of the thread's changes. waiting: the person has not decided. none: the run left
   * nothing to decide, as a report or a run with no change does.
   */
  final: z.enum(['accepted', 'discarded', 'waiting', 'none', 'unknown']),
  durationMs: count.nullable(),
  /**
   * Percent of the family's tightest window the step's turns used, where a reading stood on each
   * side of every turn. Null otherwise.
   */
  allowanceUsed: z.number().min(0).max(100).nullable(),
  /**
   * The ID of the usage window that value is a percent of, as the readings name it, such as
   * `weekly`. A client names the window from this ID, since two windows can share one period
   * label. Null with no value.
   */
  allowanceWindow: z.string().min(1).max(60).nullable(),
  startedAt: timestamp,
  endedAt: timestamp.nullable(),
});
export type SliceResult = z.infer<typeof SliceResultSchema>;

const tally = {
  /**
   * Slices run: build steps counted. Every figure below counts build steps. On a role's row a
   * slice counts when that role, model and effort ran a step on it, so a reviewer's row reads the
   * slices it reviewed. A role with only plan steps reads zero here and counts in `steps`.
   */
  slices: count,
  /**
   * Slices whose first review gave a verdict, clean or with findings, and how many of those it
   * found clean. A first review that stated no count is neither: nobody observed its verdict.
   */
  reviewed: count,
  passedFirstReview: count,
  /**
   * Mean fix rounds per slice, over the slices whose plan has ended. A slice still at work is
   * left out, since its rounds are not all run. Null with none counted.
   */
  fixRounds: z.number().nonnegative().nullable(),
  /** Slices whose thread the person accepted or discarded, and how many were accepted. */
  settled: count,
  accepted: count,
};

export const ReadResultsPayloadSchema = z.strictObject({
  projectId: id('prj'),
  /** One recipe's records only. */
  recipeId: PlanRecipeIdSchema.optional(),
});
/** Counts per recipe and per role and model. They rank nothing and recommend nothing. */
export const ResultsReadSchema = z.strictObject({
  projectId: id('prj'),
  records: count,
  first: timestamp.nullable(),
  last: timestamp.nullable(),
  recipes: z
    .array(
      z.strictObject({
        recipeId: PlanRecipeIdSchema,
        name: z.string().min(1).max(80).nullable(),
        runs: count,
        ...tally,
        /**
         * Allowance used per family and window, over every step of the recipe's runs. A percent
         * of one window never adds to a percent of another, so each pair keeps its own sum. The
         * steps of a family that had no reading are counted on its row with a null window.
         */
        allowance: z
          .array(
            z.strictObject({
              family: MeteredFamilySchema,
              window: z.string().min(1).max(60).nullable(),
              used: z.number().nonnegative(),
              steps: count,
            }),
          )
          .max(24),
      }),
    )
    .max(200),
  /**
   * One row per role, family, model and effort. `allowanceUsed` sums the steps whose reading was
   * of the family's most common window in the row, `allowanceWindow` is that window's ID, and
   * `allowanceUnknown` counts the rest.
   */
  crew: z
    .array(
      z.strictObject({
        role: ChatCrewRoleSchema,
        family: ChatFamilySchema,
        model: z.string().min(1).max(200),
        effort: ChatEffortSchema.nullable(),
        /** Steps this role ran on this model. */
        steps: count,
        ...tally,
        allowanceUsed: z.number().nonnegative().nullable(),
        allowanceWindow: z.string().min(1).max(60).nullable(),
        allowanceUnknown: count,
      }),
    )
    .max(500),
  /** Rows past each bound. */
  moreRecipes: count,
  moreCrew: count,
});
export type ResultsRead = z.infer<typeof ResultsReadSchema>;

/**
 * One page of the stored records or of the runs, newest first. A client pages with `next` until
 * it is null and writes one file. Nothing leaves the device unless the person saves that file.
 */
export const ExportResultsPayloadSchema = z.strictObject({
  projectId: id('prj'),
  recipeId: PlanRecipeIdSchema.optional(),
  part: z.enum(['records', 'runs']),
  /** The `next` of the page before. Left out for the newest page. */
  before: z.string().min(1).max(200).optional(),
});
export const ResultsExportSchema = z
  .strictObject({
    schema: z.literal(1),
    projectId: id('prj'),
    part: z.enum(['records', 'runs']),
    records: z.array(SliceResultSchema).max(MAX_RESULT_RECORDS),
    runs: z.array(PlanRecipeRunSchema).max(MAX_RESULT_RUNS),
    /** Pass as `before` for the next older page. Null on the last page. */
    next: z.string().min(1).max(200).nullable(),
  })
  .refine(
    (page) => (page.part === 'records' ? page.runs.length === 0 : page.records.length === 0),
    'A page holds records or runs, never both.',
  );
export type ResultsExport = z.infer<typeof ResultsExportSchema>;
