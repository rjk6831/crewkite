import type {
  CommandResult,
  PlanRecipe,
  PlanRecipeEntry,
  PlanRecipeRun,
  PlanRecipeRunState,
  PlanSchedule,
  PlanScheduleNote,
  PlanSchedulesRead,
  ResultsRead,
} from '@crewkite/contracts';
import { slug } from './model.ts';

// The recipes the browser preview answers with. A `state` query parameter that starts with
// `recipes-` picks one named state, so the screenshot script can open each on stable data:
// recipes-empty, recipes-clean (the default once any recipes- state is named), recipes-schedule,
// recipes-paused, recipes-stopped, recipes-unrecorded, recipes-changed, recipes-missing,
// recipes-invalid, recipes-stale, recipes-not-ready, recipes-report and recipes-refused. Stale
// answers a save with a newer version, and refused answers it with a file that changed on disk.
// recipes-moved refuses the save the same way and then reads the file as changed on disk.
// work-finished answers as recipes-clean, so Save as recipe on its Work tab opens the page on a
// draft from the thread. recipes-schedules lists six schedules over two projects for the
// Schedules view, one of them a reset schedule no reading has given a reset time, and answers
// Pause, Resume and Restart by changing them. recipes-schedules-refused does the same with one
// schedule paused by the person, whose Resume is refused.
// recipes-schedules-empty lists none. recipes-results answers the Results view with two recipes,
// one forgotten, and five role rows, and recipes-results-empty with nothing recorded.
// recipes-results-cancelled and recipes-results-failed answer as recipes-results with an export
// that is cancelled or fails. A recipe read for any other project is refused the way the
// controller refuses one for a project it does not hold. A schedules read for one project lists
// only that project's. For the Project setup card, setup-full answers as recipes-schedules with a
// file not saved yet, setup-partial as recipes-paused with a third recipe and a results read that
// fails, and setup-empty with no recipe, loop or result.

const mint = (prefix: string, n: number) => `${prefix}_0${String(n).padStart(25, '0')}`;
const hex = (digit: string) => digit.repeat(64);
const AT = '2026-10-15T17:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000).toISOString();

const member = (role: string, family: string, model: string, effort = 'medium') => ({
  role,
  selection: { family, model, effort },
});

const BUILD: PlanRecipe = {
  schema: 1,
  name: 'Build and review',
  description: 'Two providers build and review each slice. Checks gate every merge.',
  shape: 'change',
  crew: {
    name: 'Build and review',
    members: [
      member('orchestrator', 'anthropic', 'large-2', 'high'),
      member('builder', 'openai', 'large-1'),
      member('reviewer', 'anthropic', 'large-2'),
      member('fixer', 'local', 'local-27b', 'default'),
      member('challenger', 'google', 'large-3'),
    ],
  } as PlanRecipe['crew'],
  run: {
    flightMode: 'balanced',
    permissionPolicy: 'allow-edits',
    handoff: { auto: false, mode: 'most-left' },
    maxSlices: 4,
  },
  checks: [{ command: 'pnpm test' }, { command: 'pnpm lint' }],
  trigger: { kind: 'manual' },
  budget: null,
  work: null,
};
const SCHEDULED: PlanRecipe = {
  ...BUILD,
  run: { ...BUILD.run, flightMode: 'glide', permissionPolicy: 'allow-all' },
  trigger: { kind: 'interval', everyMinutes: 120 },
  budget: { maxRuns: 12, maxUsedPercent: { anthropic: 80, openai: 70, google: 75 }, maxWaiting: 3 },
  // A fixed request: the app ships with checklist work off, so the preview arms no checklist loop.
  work: { kind: 'request', text: 'Fix the oldest failing test.' },
};
const REPORT: PlanRecipe = {
  ...BUILD,
  name: 'Audit report',
  description: 'Reads the code for one question and answers in one message.',
  shape: 'report',
  crew: {
    name: 'Audit report',
    members: [
      member('orchestrator', 'anthropic', 'large-2', 'high'),
      member('builder', 'google', 'fast-3'),
      member('challenger', 'openai', 'large-1'),
    ],
  } as PlanRecipe['crew'],
  checks: [],
};

// Fixed counts for the Results view: a recipe with allowance on several windows, one the person
// forgot, and a role row each for an allowance that is known, partly known and unknown.
const tally = (
  slices: number,
  reviewed: number,
  passed: number,
  fix: number | null,
  settled: number,
  accepted: number,
) => ({
  slices,
  reviewed,
  passedFirstReview: passed,
  fixRounds: fix,
  settled,
  accepted,
});
const resultsRead = (projectId: string, empty: boolean): ResultsRead =>
  empty
    ? {
        projectId,
        records: 0,
        first: null,
        last: null,
        recipes: [],
        crew: [],
        moreRecipes: 0,
        moreCrew: 0,
      }
    : {
        projectId,
        records: 43,
        first: '2026-10-02T09:00:00.000Z',
        last: '2026-11-17T15:30:00.000Z',
        recipes: [
          {
            recipeId: mint('rcp', 1),
            name: 'Build and review',
            runs: 6,
            ...tally(9, 8, 5, 1.3333, 7, 6),
            allowance: [
              { family: 'openai', window: 'weekly', used: 22.6, steps: 9 },
              { family: 'openai', window: null, used: 0, steps: 3 },
              { family: 'anthropic', window: 'five-hour', used: 8.4, steps: 5 },
              { family: 'anthropic', window: 'weekly', used: 3.4, steps: 4 },
              { family: 'google', window: 'weekly', used: 4, steps: 2 },
              { family: 'google', window: 'gemini-weekly', used: 5, steps: 2 },
            ],
          },
          {
            recipeId: mint('rcp', 9),
            name: null,
            runs: 1,
            ...tally(2, 0, 0, 0, 0, 0),
            allowance: [],
          },
        ],
        crew: [
          {
            role: 'orchestrator',
            family: 'anthropic',
            model: 'large-2',
            effort: 'high',
            steps: 6,
            ...tally(0, 0, 0, null, 0, 0),
            allowanceUsed: 2.5,
            allowanceWindow: 'weekly',
            allowanceUnknown: 3,
          },
          {
            role: 'builder',
            family: 'openai',
            model: 'large-1',
            effort: 'medium',
            steps: 11,
            ...tally(11, 8, 5, 1.2, 7, 6),
            allowanceUsed: 22.6,
            allowanceWindow: 'weekly',
            allowanceUnknown: 2,
          },
          {
            role: 'reviewer',
            family: 'anthropic',
            model: 'large-2',
            effort: 'medium',
            steps: 12,
            ...tally(11, 8, 5, 1.2, 7, 6),
            allowanceUsed: 11.8,
            allowanceWindow: 'five-hour',
            allowanceUnknown: 0,
          },
          {
            role: 'fixer',
            family: 'local',
            model: 'local-27b',
            effort: 'default',
            steps: 4,
            ...tally(3, 0, 0, 1, 2, 2),
            allowanceUsed: null,
            allowanceWindow: null,
            allowanceUnknown: 4,
          },
          {
            role: 'challenger',
            family: 'google',
            model: 'large-3',
            effort: 'medium',
            steps: 3,
            ...tally(0, 0, 0, null, 0, 0),
            allowanceUsed: 4,
            allowanceWindow: 'weekly',
            allowanceUnknown: 0,
          },
        ],
        moreRecipes: 0,
        moreCrew: 0,
      };

type Preview = { command(name: string, payload: Record<string, unknown>): CommandResult | null };

export function recipesPreview(named: string | null, projectId: string, taskId: string): Preview {
  const setup = named?.startsWith('setup-') ? named : null;
  const state =
    named === 'work-finished'
      ? 'recipes-clean'
      : setup === 'setup-full'
        ? 'recipes-schedules'
        : setup === 'setup-partial'
          ? 'recipes-paused'
          : setup === 'setup-empty'
            ? 'recipes-empty'
            : named;
  if (!state?.startsWith('recipes-')) return { command: () => null };
  const applied = (data: unknown) => ({ outcome: 'applied', data }) as unknown as CommandResult;
  const blocked = (reason: string, next: string) =>
    ({ outcome: 'blocked', reason, next }) as CommandResult;
  const overview = state === 'recipes-schedules' || state === 'recipes-schedules-refused';
  const scheduled =
    overview || ['recipes-schedule', 'recipes-paused', 'recipes-stopped'].includes(state);
  const notReady = state === 'recipes-not-ready';
  let body: PlanRecipe = scheduled
    ? SCHEDULED
    : notReady
      ? {
          ...BUILD,
          crew: {
            ...BUILD.crew,
            members: BUILD.crew.members.map((item) =>
              item.role === 'challenger'
                ? { ...item, selection: { ...item.selection, model: 'large-9' } }
                : item,
            ),
          },
        }
      : BUILD;
  let version = 4;
  let file: PlanRecipeEntry['file'] =
    state === 'recipes-changed'
      ? 'changed'
      : state === 'recipes-missing'
        ? 'missing'
        : state === 'recipes-invalid'
          ? 'invalid'
          : 'current';
  const note: PlanScheduleNote | null =
    state === 'recipes-paused'
      ? { code: 'waiting-limit', at: at(-30), waiting: 3 }
      : state === 'recipes-stopped'
        ? { code: 'dry-runs', at: at(-90) }
        : null;
  const runState: PlanRecipeRunState[] = ['ready', 'asked', 'accepted', 'no-change', 'failed'];
  const runs: PlanRecipeRun[] = runState.map((value, index) => ({
    id: mint('rrn', index + 1),
    recipeId: mint('rcp', 1),
    projectId,
    taskId,
    version: index < 3 ? 4 : 3,
    versionHash: hex(index < 3 ? '4' : '3'),
    origin: scheduled ? 'schedule' : index === 2 ? 'schedule' : 'manual',
    item: scheduled ? 'Clamp the discount at zero' : null,
    state: value,
    findings: value === 'no-change' ? 0 : index,
    changedFiles: value === 'no-change' ? 0 : value === 'failed' ? null : 3 + index,
    reason: value === 'failed' ? 'Slice 2 failed its checks twice.' : null,
    startedAt: at(-120 * (index + 1)),
    endedAt: value === 'asked' ? null : at(-120 * (index + 1) + 34),
    allowance: { start: [], end: null },
  }));
  // The Schedules view's list, which Pause, Resume and Restart change. The first is the recipe the
  // Recipes view shows, so its strip agrees with the row. The other project is not on the rail.
  const other = mint('prj', 9);
  const listed: PlanSchedulesRead['schedules'] = overview
    ? [
        ['Build and review', 1, projectId, 'active', null, 120, 5, 12, 'accepted'],
        [
          'Nightly fixes',
          3,
          projectId,
          'paused',
          state === 'recipes-schedules-refused'
            ? { code: 'by-person', at: at(-45) }
            : { code: 'waiting-limit', at: at(-45), waiting: 3 },
          1440,
          7,
          30,
          'ready',
        ],
        [
          'Dependency bumps',
          4,
          other,
          'paused',
          { code: 'recipe-changed', at: at(-20) },
          360,
          2,
          10,
          'no-change',
        ],
        [
          'Docs sweep',
          5,
          other,
          'stopped',
          { code: 'dry-runs', at: at(-300) },
          480,
          4,
          20,
          'no-change',
        ],
        [
          'Flaky test hunt',
          6,
          projectId,
          'stopped',
          { code: 'run-limit', at: at(-600), runs: 12 },
          240,
          12,
          12,
          'failed',
        ],
        [
          'Reset report',
          7,
          projectId,
          'active',
          { code: 'allowance-unknown', at: at(-15), family: 'openai' },
          'reset',
          3,
          10,
          'accepted',
        ],
      ].map(([name, n, project, value, note, every, started, most, last], index) => ({
        name: name as string,
        path: `.crewkite/recipes/${slug(name as string)}.json`,
        trigger:
          every === 'reset'
            ? { kind: 'reset', family: 'openai' }
            : { kind: 'interval', everyMinutes: every as number },
        schedule: {
          recipeId: mint('rcp', n as number),
          projectId: project as string,
          version: 2,
          versionHash: hex('2'),
          state: value as PlanSchedule['state'],
          note: note as PlanScheduleNote | null,
          armedAt: at(-2880),
          // No reading has reported a reset yet, so the reset schedule has no next start.
          nextAt: value === 'active' && every !== 'reset' ? at(85) : null,
          runsStarted: started as number,
          maxRuns: most as number,
          waiting: value === 'paused' && index === 1 ? 3 : 0,
          dryRuns: (note as PlanScheduleNote | null)?.code === 'dry-runs' ? 2 : 0,
          lastRun: {
            id: mint('rrn', 10 + index),
            taskId,
            state: last as PlanRecipeRunState,
            startedAt: at(-120 * (index + 1)),
            endedAt: at(-120 * (index + 1) + 34),
          },
        },
      }))
    : [];
  const changeSchedule = (recipeId: unknown, action: unknown): CommandResult => {
    const item = listed.find((entry) => entry.schedule.recipeId === recipeId);
    if (!item) return blocked('schedule-none', 'This recipe has no loop.');
    const { schedule: was } = item;
    // A reset schedule armed again has no next start until a reading reports a reset.
    const armed =
      item.trigger.kind === 'reset'
        ? {
            note: { code: 'allowance-unknown', at: AT, family: item.trigger.family } as const,
            nextAt: null,
          }
        : { note: null, nextAt: at(120) };
    if (action === 'pause') {
      item.schedule = {
        ...was,
        state: 'paused',
        note: { code: 'by-person', at: AT },
        nextAt: null,
      };
    } else if (action === 'resume') {
      if (state === 'recipes-schedules-refused')
        return blocked(
          'recipe-file-changed',
          'The recipe file changed on disk. Review it and save, then try again.',
        );
      if (was.state !== 'paused') return blocked('schedule-not-paused', 'This loop is not paused.');
      item.schedule = { ...was, state: 'active', ...armed };
    } else {
      if (was.state !== 'stopped')
        return blocked('schedule-not-stopped', 'This loop is not stopped.');
      item.schedule = {
        ...was,
        state: 'active',
        ...armed,
        runsStarted: 0,
        dryRuns: 0,
      };
    }
    return applied(undefined);
  };
  const schedule = (): PlanSchedule | null =>
    overview
      ? (listed[0]?.schedule ?? null)
      : scheduled
        ? {
            recipeId: mint('rcp', 1),
            projectId,
            version,
            versionHash: hex('4'),
            state:
              state === 'recipes-paused'
                ? 'paused'
                : state === 'recipes-stopped'
                  ? 'stopped'
                  : 'active',
            note,
            armedAt: at(-600),
            nextAt: state === 'recipes-schedule' ? at(85) : null,
            runsStarted: 5,
            maxRuns: 12,
            waiting: state === 'recipes-paused' ? 3 : 1,
            dryRuns: state === 'recipes-stopped' ? 2 : 0,
            lastRun: runs[0]
              ? {
                  id: runs[0].id,
                  taskId,
                  state: runs[0].state,
                  startedAt: runs[0].startedAt,
                  endedAt: runs[0].endedAt,
                }
              : null,
          }
        : null;
  const entries = (): PlanRecipeEntry[] => {
    if (state === 'recipes-empty') return [];
    const list: PlanRecipeEntry[] = [
      {
        path: '.crewkite/recipes/build-and-review.json',
        record: {
          id: mint('rcp', 1),
          projectId,
          path: '.crewkite/recipes/build-and-review.json',
          version,
          versionHash: hex('4'),
          updatedAt: at(-2880),
        },
        file,
        name: body.name,
        description: body.description,
        trigger: body.trigger,
        problem:
          file === 'invalid' ? 'Line 14: run.maxSlices: expected a number, received text.' : null,
        schedule: schedule(),
      },
      {
        path: '.crewkite/recipes/audit-report.json',
        record: {
          id: mint('rcp', 2),
          projectId,
          path: '.crewkite/recipes/audit-report.json',
          version: 2,
          versionHash: hex('2'),
          updatedAt: at(-7200),
        },
        file: 'current',
        name: REPORT.name,
        description: REPORT.description,
        trigger: REPORT.trigger,
        problem: null,
        schedule: null,
      },
    ];
    if (setup === 'setup-partial')
      list.push({
        path: '.crewkite/recipes/docs-sweep.json',
        record: {
          id: mint('rcp', 5),
          projectId,
          path: '.crewkite/recipes/docs-sweep.json',
          version: 1,
          versionHash: hex('1'),
          updatedAt: at(-1440),
        },
        file: 'current',
        name: 'Docs sweep',
        description: BUILD.description,
        trigger: BUILD.trigger,
        problem: null,
        schedule: null,
      });
    if (state === 'recipes-unrecorded' || setup === 'setup-full')
      list.unshift({
        path: '.crewkite/recipes/nightly-fixes.json',
        record: null,
        file: 'unrecorded',
        name: 'Nightly fixes',
        description: 'A teammate committed this one.',
        trigger: SCHEDULED.trigger,
        problem: null,
        schedule: null,
      });
    return list;
  };
  const resolve = (commands: string[]) =>
    commands.map((command) => ({
      command,
      resolved:
        command === 'pnpm test'
          ? 'pnpm test runs test: node scripts/test.mjs'
          : `${command} runs ${command.split(' ').at(-1)}: biome check .`,
      digest: hex(command === 'pnpm test' ? 'a' : 'b'),
    }));

  return {
    command(name, payload) {
      // The controller reads recipes only for a registered project, and the Schedules view lists
      // schedules of one the preview's rail does not hold.
      if ((name === 'ReadRecipes' || name === 'ReadRecipe') && payload.projectId !== projectId)
        return blocked('project-not-found', 'Choose a registered project.');
      switch (name) {
        case 'ReadRecipes':
          return applied({
            kind: 'recipes',
            projectId,
            folder: state === 'recipes-empty' ? null : '.crewkite/recipes',
            recipes: entries(),
            more: 0,
            // As the app ships: both controller options are off.
            available: { checklistWork: false, reportRuns: false },
          });
        case 'ReadRecipe': {
          const list = entries();
          const entry =
            list.find(
              (item) => item.record?.id === payload.recipeId || item.path === payload.path,
            ) ?? list[0];
          if (!entry) return blocked('recipe-not-found', 'That recipe is not saved here.');
          const report = entry.record?.id === mint('rcp', 2);
          const saved = report ? REPORT : entry.record ? body : null;
          const asked = typeof payload.version === 'number' ? payload.version : null;
          return applied({
            kind: 'recipe',
            entry,
            recipe:
              entry.file === 'missing' || entry.file === 'invalid'
                ? null
                : entry.file === 'changed'
                  ? { ...body, run: { ...body.run, maxSlices: 8 }, checks: [body.checks[0]] }
                  : entry.file === 'unrecorded'
                    ? { ...SCHEDULED, name: 'Nightly fixes' }
                    : saved,
            saved:
              asked && saved && asked < version
                ? { ...saved, run: { ...saved.run, maxSlices: 2 }, checks: [] }
                : saved,
            savedVersion: entry.record ? (asked ?? entry.record.version) : null,
            versions: entry.record
              ? Array.from({ length: entry.record.version }, (_, index) => ({
                  version: (entry.record?.version ?? 1) - index,
                  versionHash: hex(String((entry.record?.version ?? 1) - index)),
                  savedAt: at(-2880 - index * 1440),
                }))
              : [],
            moreVersions: 0,
            readiness: [],
            approved: schedule() ? resolve(body.checks.map((check) => check.command)) : [],
          });
        }
        case 'ResolveRecipeChecks':
          return applied({
            kind: 'recipe-checks',
            resolved: resolve((payload.commands as string[]) ?? []),
          });
        case 'ReadRecipeRuns':
          return applied({
            kind: 'recipe-runs',
            runs: payload.recipeId === mint('rcp', 1) && state !== 'recipes-unrecorded' ? runs : [],
            more: 0,
            name: BUILD.name,
          });
        case 'SaveRecipe': {
          if (state === 'recipes-stale' && version === 4) {
            // Another window saved first. The next save, against version 5, goes through.
            version = 5;
            return {
              outcome: 'stale-revision',
              reason: 'stale-revision',
              revision: 5,
              next: 'This recipe was saved again as version 5. Review your changes against it.',
            } as CommandResult;
          }
          // recipes-moved: the file changes on disk while the person edits, so the save is
          // refused and every read after it finds the file changed.
          if (state === 'recipes-moved') file = 'changed';
          if (state === 'recipes-refused' || state === 'recipes-moved')
            return blocked(
              'recipe-file-changed',
              `${String(payload.path)} changed on disk since the last save. Review the file's version first.`,
            );
          body = payload.body as PlanRecipe;
          version += 1;
          return applied({
            kind: 'recipe-saved',
            record: {
              id: mint('rcp', 1),
              projectId,
              path: String(payload.path),
              version,
              versionHash: hex('5'),
              updatedAt: AT,
            },
            changed: [],
            schedule: null,
            approved: [],
          });
        }
        case 'RunRecipe':
          return applied({ kind: 'recipe-run', run: { ...runs[0], state: 'running' } });
        case 'SetRecipeSchedule':
          return overview ? changeSchedule(payload.recipeId, payload.action) : applied(undefined);
        case 'SetRecipeFolder':
        case 'ForgetRecipe':
          return applied(undefined);
        case 'ReadResults':
          if (setup === 'setup-partial')
            return blocked(
              'not-available',
              'This version cannot run this command yet. Nothing changed.',
            );
          return applied({
            kind: 'results',
            ...resultsRead(projectId, state === 'recipes-results-empty' || setup === 'setup-empty'),
          });
        case 'ReadSchedules': {
          // The paused state's one schedule is listed for the setup card, as the controller would.
          const all: PlanSchedulesRead['schedules'] =
            setup === 'setup-partial'
              ? entries().flatMap((entry) =>
                  entry.schedule && entry.name && entry.trigger
                    ? [
                        {
                          schedule: entry.schedule,
                          name: entry.name,
                          path: entry.path,
                          trigger: entry.trigger,
                        },
                      ]
                    : [],
                )
              : listed;
          const schedules = all.filter(
            (entry) => !payload.projectId || entry.schedule.projectId === payload.projectId,
          );
          return applied({ kind: 'schedules', schedules: structuredClone(schedules), more: 0 });
        }
        default:
          return null;
      }
    },
  };
}
