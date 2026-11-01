import {
  type ChatCatalogEntry,
  type ChatFamily,
  type ChatHandoffMode,
  type ChatModelSelection,
  type ChatPlan,
  type ChatPlanAssignment,
  ChatPlanSchema,
  type ChatPlanSlice,
  type ChatPlanState,
  planOrder,
  rankFamilies,
} from '@crewkite/contracts';
import { localPromptRoom } from '../providers/local/budget.ts';
import { familyName } from './prompt.ts';

// The orchestrator proposes a plan and the controller assigns it (ADR 0045). Everything here is a
// pure function of what it is given, so an assignment replays from the recorded inputs.

/** The fence the orchestrator writes its plan in: a `json` block tagged `plan`. */
const PLAN_FENCE = /^[ \t]*```json[ \t]+plan[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*$/gm;

/**
 * Whether the orchestrator's reply holds a plan block at all. A reply without one answered the
 * person directly; a reply with one that does not parse goes back to the orchestrator.
 */
export function hasPlanBlock(reply: string): boolean {
  return [...reply.matchAll(PLAN_FENCE)].length > 0 || /^[ \t]*```json[ \t]+plan\b/m.test(reply);
}

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

// A provider the person rules out in the message, such as "Do not assign anything to Local AI".
// The negation and the name sit in one clause, at most 40 characters apart.
const RULED_OUT =
  /\b(?:do not|don't|dont|never|no|not|without|avoid|exclude|except|skip)\b[^.;\n]{0,40}?\b(openai|gpt|anthropic|google|gemini|local(?: ai| models?)?|lm studio)\b/gi;
const LISTED =
  /^\s*(?:,|or|and|nor)\s*(?:to\s+|the\s+)?(openai|gpt|anthropic|google|gemini|local(?: ai| models?)?|lm studio)\b/i;
const RULED_OUT_FAMILY: Record<string, ChatFamily> = {
  openai: 'openai',
  gpt: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  gemini: 'google',
  'lm studio': 'local',
};

/** The families the person's message rules out for this plan, in the order it names them. */
export function ruledOut(message: string): ChatFamily[] {
  const found = new Set<ChatFamily>();
  const add = (name: string) => found.add(RULED_OUT_FAMILY[name.toLowerCase()] ?? 'local');
  for (const match of message.matchAll(RULED_OUT)) {
    add(match[1] ?? '');
    // A list after the first name, as in "Google or OpenAI", rules out each name in it.
    let rest = message.slice((match.index ?? 0) + match[0].length);
    for (;;) {
      const more = LISTED.exec(rest);
      if (!more) break;
      add(more[1] ?? '');
      rest = rest.slice(more[0].length);
    }
  }
  return [...found];
}

/** What the controller knows about one named file of a slice, read from the scratch copy. */
export type PlanFile = { bytes: number; image: boolean };

export type PlanInputs = {
  /** The catalog at proposal time. Only connected families with allowance left take a slice. */
  families: readonly ChatCatalogEntry[];
  mode: ChatHandoffMode;
  now: number;
  /** The crew builder. Every slice runs on it unless a rule below moves it. */
  builder: ChatModelSelection;
  /** The crew fixer, or null when the crew has none. A hard slice runs on it. */
  fixer: ChatModelSelection | null;
  /**
   * Continue on another provider. When no model of the crew can take a slice, the handoff rule
   * may move it to the family the thread's mode ranks first.
   */
  autoHandoff: boolean;
  /** Families the person's message ruled out. No slice runs on one, crew member or not. */
  excluded: readonly ChatFamily[];
  /** The loaded Local model's context length, or null when Local has none to offer. */
  localContext: number | null;
  /**
   * Whether files of these sizes fit a Local prompt of this context. The controller passes the
   * Local budget rule, which leaves the outline and the summary their share of the room.
   */
  localSliceFits: (
    files: readonly { path: string; bytes: number }[],
    contextLength: number,
    hasImage: boolean,
  ) => boolean;
  /** Each named file, by scratch path. A file the slice will create counts as empty text. */
  files: Readonly<Record<string, PlanFile>>;
};

export type PlanSliceRow = ChatPlanState['slices'][number];

/** The card rows, and for each slice no model can take, the reason in words for the thread. */
export type PlanAssigned = { rows: PlanSliceRow[]; unassigned: Record<number, string> };

const modeName: Record<ChatHandoffMode, string> = {
  'most-left': 'Most allowance left',
  'resets-first': 'Resets soonest',
  'even-spend': 'Even spend',
  'local-first': 'Local first',
};

const MAX_CANDIDATES = 4;
const count = (value: number) => value.toLocaleString('en-US');

/**
 * The card rows for a plan: each slice in plan order, queued, with its assignment and the models
 * the person may pick from before it runs. Slices stay inside the crew: the builder takes every
 * slice, the fixer takes a hard one, and Local takes one only as a member of the crew.
 */
export function assignPlan(plan: ChatPlan, inputs: PlanInputs): PlanAssigned {
  const order = planOrder(plan.slices) ?? plan.slices.map((slice) => slice.id);
  const assigned = new Map(
    order.map((id) => {
      const slice = plan.slices.find((value) => value.id === id) as ChatPlanSlice;
      return [id, assignSlice(slice, inputs)] as const;
    }),
  );
  const unassigned: Record<number, string> = {};
  const rows = plan.slices.map((slice): PlanSliceRow => {
    const { assignment, candidates, missing } = assigned.get(slice.id) ?? {
      assignment: null,
      candidates: [],
      missing: null,
    };
    if (!assignment && missing) unassigned[slice.id] = missing;
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
  return { rows, unassigned };
}

type Member = { role: 'Builder' | 'Fixer'; selection: ChatModelSelection; why: string };

function assignSlice(
  slice: ChatPlanSlice,
  inputs: PlanInputs,
): {
  assignment: ChatPlanAssignment | null;
  candidates: ChatPlanAssignment[];
  missing: string | null;
} {
  const { builder, fixer, mode, now } = inputs;
  const crew = [builder, ...(fixer ? [fixer] : [])];
  // A crew family ranks on the model the crew runs there.
  const modelFor = (entry: ChatCatalogEntry) =>
    crew.find((member) => member.family === entry.family)?.model ?? entry.defaultModel;
  const rank = (entries: readonly ChatCatalogEntry[], exclude: ChatFamily[] = []) =>
    rankFamilies(entries, exclude, modelFor, mode, now);
  const ranked = rank(inputs.families);
  const files = slice.files.map((path) => ({ path, bytes: inputs.files[path]?.bytes ?? 0 }));
  const image = slice.files.some((path) => inputs.files[path]?.image === true);
  const context = inputs.localContext;
  const localFits = context !== null && !image && inputs.localSliceFits(files, context, image);
  const head = `Slice ${slice.id} (${slice.difficulty}) assigned to`;
  const label = (selection: { family: ChatFamily; model: string }) =>
    inputs.families
      .find((entry) => entry.family === selection.family)
      ?.models.find((model) => model.model === selection.model)?.label ?? selection.model;
  const named = (selection: { family: ChatFamily; model: string }) =>
    `${familyName[selection.family]} (${label(selection)})`;
  // Why a model cannot take the slice, or null when it can.
  const blockedBy = (selection: ChatModelSelection): string | null => {
    const entry = inputs.families.find((value) => value.family === selection.family);
    const name = familyName[selection.family];
    if (inputs.excluded.includes(selection.family)) return `your message rules out ${name}`;
    if (!entry?.connected) return `${name} is not connected`;
    if (!ranked.includes(entry)) return `${name} has no allowance left`;
    if (selection.family !== 'local') return null;
    if (context === null) return 'Local reports no context length';
    if (image) return 'Local takes no image file';
    return localFits
      ? null
      : `the files do not fit Local's ${count(localPromptRoom(context))} token room`;
  };
  const pick = (member: Member): ChatPlanAssignment => ({
    family: member.selection.family,
    model: member.selection.model,
    reason: `${head} ${named(member.selection)}: ${member.why}.`,
  });
  // The fixer takes a hard slice when the crew has its own fixer model. Otherwise the builder.
  const ownFixer = fixer && !sameModel(fixer, builder) ? fixer : null;
  const order: Member[] =
    slice.difficulty === 'hard' && ownFixer
      ? [
          { role: 'Fixer', selection: ownFixer, why: 'Fixer, hard slice' },
          { role: 'Builder', selection: builder, why: "Builder, the crew's model" },
        ]
      : [
          { role: 'Builder', selection: builder, why: "Builder, the crew's model" },
          ...(ownFixer
            ? [
                {
                  role: 'Fixer',
                  selection: ownFixer,
                  why: "Fixer, the crew's other model",
                } as Member,
              ]
            : []),
        ];
  const open = order.filter((member) => blockedBy(member.selection) === null);
  const first = order[0] as Member;
  const firstWhy = blockedBy(first.selection);
  const chosen = open[0];
  if (chosen) {
    const why = chosen === first ? chosen.why : `${chosen.role}, since ${firstWhy as string}`;
    const assignment = pick({ ...chosen, why });
    const candidates = open.map((member) => (member === chosen ? assignment : pick(member)));
    return { assignment, candidates, missing: null };
  }
  // No model of the crew can take it. The handoff rule may move it when the thread allows that.
  const out = order.map((member) => blockedBy(member.selection) as string).join(', and ');
  if (!inputs.autoHandoff)
    return {
      assignment: null,
      candidates: [],
      missing: `Slice ${slice.id} (${slice.difficulty}) has no model in the crew to run on: ${out}. Continue on another provider is off.`,
    };
  const others = rank(inputs.families, [
    ...crew.map((member) => member.family),
    ...inputs.excluded,
  ]).filter((entry) => (entry.family !== 'local' || localFits) && modelOf(entry) !== null);
  const top = others[0];
  if (!top)
    return {
      assignment: null,
      candidates: [],
      missing: `Slice ${slice.id} (${slice.difficulty}) has no model to run on: ${out}, and no other connected provider has allowance left.`,
    };
  // Two families tie when the ranking keeps whichever comes first. The hint picks between them
  // and never adds a family the ranking left out.
  const ties = (a: ChatCatalogEntry, b: ChatCatalogEntry) =>
    rank([a, b])[0] === a && rank([b, a])[0] === b;
  const hint = others.find((entry) => entry.family === slice.hint?.family);
  const entry = hint && hint !== top && ties(top, hint) ? hint : top;
  const by = modeName[mode];
  const moved = (value: ChatCatalogEntry, index: number): ChatPlanAssignment => {
    const selection = { family: value.family, model: modelOf(value) as string };
    return {
      ...selection,
      reason: `${head} ${named(selection)}: Continue on another provider, since ${out}. Ranked ${index + 1} of ${others.length} by ${by}.${value === entry && entry !== top ? ' The plan hint broke a tie.' : ''}`,
    };
  };
  const assignment = moved(entry, others.indexOf(entry));
  const candidates = others
    .slice(0, MAX_CANDIDATES)
    .map((value, index) => (value === entry ? assignment : moved(value, index)));
  return { assignment, candidates, missing: null };
}

const sameModel = (a: ChatModelSelection, b: ChatModelSelection) =>
  a.family === b.family && a.model === b.model;

/** A family's default or first model, for a slice the handoff rule moves out of the crew. */
function modelOf(entry: ChatCatalogEntry): string | null {
  return entry.defaultModel ?? entry.models[0]?.model ?? null;
}
