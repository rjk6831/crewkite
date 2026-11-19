import {
  type DesignSystem,
  type DesignSystemDraft,
  DesignSystemSchema,
  TokenGroupSchema,
} from '@crewkite/contracts';
import type { ChatTurnResult } from '../chat/adapter.ts';
import { git } from '../host/source.ts';
import { Draft, isObject } from './import.ts';

// A draft from a description asks the orchestrator model once, in a read-only turn that belongs to
// no thread and sees no project file. The answer is read the way an import reads a file: each value
// the contract accepts becomes a token, a component or a rule, and the rest count as skipped.
// Nothing is saved until the person reviews the draft and saves it.

/** Runs one read-only turn. Null when no provider is connected to run it on. */
export type DraftTurn = (input: {
  projectId: string;
  systemContext: string;
  prompt: string;
  deadlineMs: number;
}) => Promise<ChatTurnResult | null>;

/** The person waits on the draft with the editor open, so it gets three minutes. */
const DEADLINE_MS = 3 * 60_000;
/** The most style file paths the prompt names. */
const LISTED = 40;
const STYLE_FILE =
  /(?:^|\/)(?:[^/]+\.(?:css|scss|sass|less)|tailwind\.config\.[cm]?[jt]s|[^/]*tokens[^/]*\.json|DESIGN\.md|design-system\.json)$/;

const INSTRUCTION = `You draft a design system for a software project from the person's description. You read no files and run no commands. Answer with one JSON object in a fenced json block and nothing else.

The object has this shape:
{"schema":1,"tokens":{"color":{},"type":{},"spacing":{},"radius":{},"shadow":{},"motion":{}},"components":[],"rules":[]}

A token is {"$type": ..., "$value": ...} with an optional one-line "$description". Its name has letters, digits, - and _, starts with a letter or digit, and has at most 64 characters. One value per token: no references to other tokens, no themes and no modes.
- color: {"$type":"color","$value":"#2f6feb"}, any CSS color string.
- type: fontFamily with a family name or a list of them, fontWeight with a number from 1 to 1000, dimension for sizes, number for line heights.
- spacing and radius: {"$type":"dimension","$value":{"value":8,"unit":"px"}}, in px or rem.
- shadow: {"$type":"shadow","$value":{"color":"#0000001f","offsetX":{"value":0,"unit":"px"},"offsetY":{"value":1,"unit":"px"},"blur":{"value":3,"unit":"px"},"spread":{"value":0,"unit":"px"}}}.
- motion: {"$type":"duration","$value":{"value":150,"unit":"ms"}} or {"$type":"cubicBezier","$value":[0.2,0,0,1]}.

A component is {"id":"button","name":"Button","do":[],"dont":[],"example":"<button>Save</button>"}. A rule is {"id":"one-accent","text":"Use one accent color per screen.","do":[],"dont":[],"example":"..."}. IDs use lower case letters, digits and hyphens. Each do and dont entry is one short line. The example is a short piece of code or text.

Give the tokens the description calls for, and a few components and rules that follow from it.`;

/**
 * Ask for a draft and read the answer. A refusal says why there is none: no provider, a usage
 * limit, a turn that failed, or an answer with nothing the contract can hold. Nothing retries, and
 * nothing moves to another provider or to credits.
 */
export async function describeDraft(
  run: DraftTurn | undefined,
  input: { projectId: string; description: string; root: string },
): Promise<DesignSystemDraft | { refused: string; next: string }> {
  const result =
    (await run?.({
      projectId: input.projectId,
      systemContext: INSTRUCTION,
      prompt: draftPrompt(input.description, styleFiles(input.root)),
      deadlineMs: DEADLINE_MS,
    })) ?? null;
  if (!result)
    return {
      refused: 'provider-not-connected',
      next: 'Connect a provider in Settings, then draft again.',
    };
  const said = result.failure?.message ?? 'The draft stopped before it finished.';
  if (result.stopReason === 'limit')
    return {
      refused: 'design-draft-limit',
      next: `${said} Try again after the reset, or start from a template.`,
    };
  if (result.stopReason !== 'done')
    return { refused: 'design-draft-failed', next: `${said} Try again or start from a template.` };
  const read = readAnswer(result.assistantText);
  return read
    ? { source: 'description', path: null, ...read }
    : {
        refused: 'design-draft-unreadable',
        next: 'The draft could not be read. Try again or start from a template.',
      };
}

function draftPrompt(description: string, files: readonly string[]) {
  const listed = files.length
    ? [
        'Style files in the project, by path. You cannot open them. Their names show what the project already uses.',
        ...files.slice(0, LISTED).map((path) => `- ${path}`),
        ...(files.length > LISTED ? [`- and ${files.length - LISTED} more`] : []),
      ]
    : ['The project has no style files yet.'];
  return ['Description:', description, '', ...listed].join('\n');
}

/** The project's style files by path. Names only: no file is read. */
function styleFiles(root: string): string[] {
  try {
    return git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
      .toString('utf8')
      .split('\0')
      .filter(
        (path) =>
          STYLE_FILE.test(path) && !/(?:^|\/)node_modules\//.test(path) && !/\p{Cc}/u.test(path),
      )
      .sort();
  } catch {
    // A folder Git cannot list still gets a draft. The prompt then names no files.
    return [];
  }
}

/**
 * The design system in a model's answer, value by value. The first json block is read, else the
 * text from the first brace to the last. Null when there is no JSON object or nothing in it fits.
 */
function readAnswer(text: string): { system: DesignSystem; skipped: number } | null {
  const fenced = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/i.exec(text)?.[1];
  let answer: unknown;
  try {
    answer = JSON.parse(fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
  if (!isObject(answer) || !isObject(answer.tokens)) return null;
  const draft = new Draft();
  for (const [group, tokens] of Object.entries(answer.tokens)) {
    const known = TokenGroupSchema.safeParse(group).data;
    // A group the format has no place for skips each of its values.
    const entries: [string, unknown][] = isObject(tokens) ? Object.entries(tokens) : [['', tokens]];
    for (const [name, token] of entries)
      if (known) draft.token(known, name, token);
      else draft.skip();
  }
  // A lone object where a list belongs is read as a list of one.
  const list = (value: unknown) =>
    Array.isArray(value) ? value : value === undefined ? [] : [value];
  for (const item of list(answer.components)) draft.component(item);
  for (const item of list(answer.rules)) draft.rule(item);
  const system = DesignSystemSchema.safeParse(draft.system()).data;
  const kept =
    system &&
    (TokenGroupSchema.options.some((group) => Object.keys(system.tokens[group]).length > 0) ||
      system.components.length > 0 ||
      system.rules.length > 0);
  return kept ? { system, skipped: draft.skipped } : null;
}
