import {
  type ChatCatalogEntry,
  type ChatHandoffMode,
  type ChatModelSelection,
  type ChatPlan,
  type ChatPlanAssignment,
  ChatPlanSchema,
  type ChatPlanSlice,
  type ChatPlanState,
  LOCAL_REPLY_MARGIN,
  localReplyFloor,
  planOrder,
  rankFamilies,
} from '@crewkite/contracts';
import { familyName } from './prompt.ts';

// The orchestrator proposes a plan and the controller assigns it (ADR 0045). Everything here is a
// pure function of what it is given, so an assignment replays from the recorded inputs.

/** The fence the orchestrator writes its plan in: a `json` block tagged `plan`. */
const PLAN_FENCE = /^[ \t]*```json[ \t]+plan[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*$/gm;

/**
 * The plan in the orchestrator's reply, or the reason it cannot be used, in words the orchestrator
 * reads on its second try. The last plan block counts, so a reply that corrects itself works.
 */
export function parsePlan(reply: string): { plan: ChatPlan } | { error: string } {
  const blocks = [...reply.matchAll(PLAN_FENCE)];
  const body = blocks.at(-1)?.[1];
  if (body === undefined) return { error: 'The reply has no fenced json block tagged plan.' };
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    return {
      error:
        `The plan block is not valid JSON. ${error instanceof Error ? error.message : ''}`.trim(),
    };
  }
  const parsed = ChatPlanSchema.safeParse(value);
  if (parsed.success) return { plan: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`);
  return { error: `The plan does not match the schema. ${issues.join('; ')}` };
}

/** What the controller knows about one named file of a slice, read from the scratch copy. */
export type PlanFile = { bytes: number; image: boolean };

export type PlanInputs = {
  /** The catalog at proposal time. Only connected families with allowance left rank. */
  families: readonly ChatCatalogEntry[];
  mode: ChatHandoffMode;
  now: number;
  /** The crew builder. Hard and medium slices stay on it while its family ranks. */
  builder: ChatModelSelection;
  /** The loaded Local model's context length, or null when Local has none to offer. */
  localContext: number | null;
  /** Whether files of these sizes fit a Local prompt of this context (the A5 budget rule). */
  localSliceFits: (
    files: readonly { path: string; bytes: number }[],
    contextLength: number,
    hasImage: boolean,
  ) => boolean;
  /** Each named file, by scratch path. A file the slice will create counts as empty text. */
  files: Readonly<Record<string, PlanFile>>;
};

export type PlanSliceRow = ChatPlanState['slices'][number];

const modeName: Record<ChatHandoffMode, string> = {
  'most-left': 'Most allowance left',
  'resets-first': 'Resets soonest',
  'even-spend': 'Even spend',
  'local-first': 'Local first',
};

const MAX_CANDIDATES = 4;
const count = (value: number) => value.toLocaleString('en-US');

/** Tokens a Local prompt may take: the context less the reply margin and the smallest reply. */
export const localRoom = (contextLength: number) =>
  Math.max(0, contextLength - LOCAL_REPLY_MARGIN - localReplyFloor(contextLength));

// Text and code run three to five bytes a token. Three never undercounts.
const BYTES_PER_TOKEN = 3;

/** The room rule alone: no image, and the named files within the Local prompt room. */
export const localRoomFits: PlanInputs['localSliceFits'] = (files, contextLength, hasImage) =>
  !hasImage &&
  files.reduce((sum, file) => sum + Math.ceil(file.bytes / BYTES_PER_TOKEN), 0) <=
    localRoom(contextLength);

/**
 * The card rows for a plan: each slice in plan order, queued, with its assignment and up to four
 * ranked candidates the person may pick from before it runs.
 */
export function assignPlan(plan: ChatPlan, inputs: PlanInputs): PlanSliceRow[] {
  const order = planOrder(plan.slices) ?? plan.slices.map((slice) => slice.id);
  const assigned = new Map(
    order.map((id) => {
      const slice = plan.slices.find((value) => value.id === id) as ChatPlanSlice;
      return [id, assignSlice(slice, inputs)] as const;
    }),
  );
  return plan.slices.map((slice) => {
    const { assignment, candidates } = assigned.get(slice.id) ?? {
      assignment: null,
      candidates: [],
    };
    return {
      id: slice.id,
      title: slice.title,
      difficulty: slice.difficulty,
      depends: slice.depends,
      readOnly: slice.readOnly,
      status: 'queued',
      assignment,
      candidates,
      turnId: null,
    };
  });
}

function assignSlice(
  slice: ChatPlanSlice,
  inputs: PlanInputs,
): { assignment: ChatPlanAssignment | null; candidates: ChatPlanAssignment[] } {
  const { builder, mode, now } = inputs;
  const modelFor = (entry: ChatCatalogEntry) =>
    entry.family === builder.family ? builder.model : entry.defaultModel;
  const rank = (entries: readonly ChatCatalogEntry[]) =>
    rankFamilies(entries, [], modelFor, mode, now);
  // A family runs a slice only with a model to run it on.
  const ranked = rank(inputs.families).filter((entry) => modelOf(entry, builder) !== null);
  const files = slice.files.map((path) => ({ path, bytes: inputs.files[path]?.bytes ?? 0 }));
  const image = slice.files.some((path) => inputs.files[path]?.image === true);
  const context = inputs.localContext;
  const local = ranked.find((entry) => entry.family === 'local');
  const fits = !!local && context !== null && inputs.localSliceFits(files, context, image);
  // Local takes a slice only when it fits, so it is a candidate only then.
  const choices = ranked.filter((entry) => entry.family !== 'local' || fits);
  const head = `Slice ${slice.id} (${slice.difficulty}) assigned to`;
  const by = modeName[mode];
  // Two families tie when the ranking keeps whichever comes first. The hint picks between them
  // and never adds a family the ranking left out.
  const ties = (a: ChatCatalogEntry, b: ChatCatalogEntry) =>
    rank([a, b])[0] === a && rank([b, a])[0] === b;
  const hinted = (top: ChatCatalogEntry) => {
    const hint = choices.find((entry) => entry.family === slice.hint?.family);
    return hint && hint !== top && ties(top, hint) ? hint : null;
  };
  const top = (pool: readonly ChatCatalogEntry[], why: string): ChatPlanAssignment | null => {
    const first = pool[0];
    if (!first) return null;
    const hint = hinted(first);
    const entry = hint ?? first;
    return {
      family: entry.family,
      model: modelOf(entry, builder) as string,
      reason: `${head} ${familyName[entry.family]}: ${why}, first by ${by}.${hint ? ' The plan hint broke a tie.' : ''}`,
    };
  };
  let assignment: ChatPlanAssignment | null;
  if (slice.difficulty === 'easy') {
    if (fits && local && context !== null)
      assignment = {
        family: 'local',
        model: modelOf(local, builder) as string,
        reason: `${head} Local: ${count(localRoom(context))} token room, Local first.`,
      };
    else {
      const why = !local
        ? 'Local is not connected'
        : context === null
          ? 'Local reports no context length'
          : image
            ? 'Local takes no image file'
            : `the files do not fit Local's ${count(localRoom(context))} token room`;
      assignment = top(choices, why);
    }
  } else {
    const own = choices.findIndex((entry) => entry.family === builder.family);
    assignment =
      own >= 0
        ? {
            family: builder.family,
            model: builder.model,
            reason: `${head} ${familyName[builder.family]}: the crew builder, ranked ${own + 1} of ${choices.length} by ${by}.`,
          }
        : top(choices, `the builder's family ${familyName[builder.family]} does not rank`);
  }
  const candidates = choices.slice(0, MAX_CANDIDATES).map((entry, index) =>
    entry.family === assignment?.family
      ? assignment
      : {
          family: entry.family,
          model: modelOf(entry, builder) as string,
          reason: `${familyName[entry.family]} ranked ${index + 1} of ${choices.length} by ${by}.`,
        },
  );
  return { assignment, candidates };
}

/** The builder's model on the builder's family, otherwise the family's default or first model. */
function modelOf(entry: ChatCatalogEntry, builder: ChatModelSelection): string | null {
  if (entry.family === builder.family) return builder.model;
  return entry.defaultModel ?? entry.models[0]?.model ?? null;
}
