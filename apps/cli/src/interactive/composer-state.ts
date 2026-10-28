import {
  completeSlash,
  findMentionTrigger,
  insertMention,
  type MentionCandidate,
  type SlashCommand,
} from '../chat/composer-shared.ts';

// The message box as plain data: text, caret and history. Every key the box takes is one pure
// step here, so the view only draws it.

export type Composer = {
  text: string;
  caret: number;
  /** Sent messages, oldest first. Up walks back from the newest. */
  history: readonly string[];
  /** The history entry Up reached, or null while editing a new message. */
  recall: number | null;
  /** What the box held before Up, given back when Down passes the newest entry. */
  draft: string;
  completion: Completion | null;
};
export type Completion =
  | { kind: 'slash'; items: readonly SlashCommand[]; index: number }
  | { kind: 'mention'; items: readonly MentionCandidate[]; index: number };

export const emptyComposer = (history: readonly string[] = []): Composer => ({
  text: '',
  caret: 0,
  history,
  recall: null,
  draft: '',
  completion: null,
});

const MAX_HISTORY = 200;

const lineStart = (text: string, caret: number) => text.lastIndexOf('\n', caret - 1) + 1;
const lineEnd = (text: string, caret: number) => {
  const end = text.indexOf('\n', caret);
  return end === -1 ? text.length : end;
};

/** The slash list follows the text as it is typed. Mentions arrive from the controller. */
function withSlash(state: Composer): Composer {
  const items = completeSlash(state.text);
  return {
    ...state,
    completion:
      items.length > 0 && !state.text.includes(' ')
        ? { kind: 'slash', items, index: 0 }
        : state.completion?.kind === 'mention'
          ? state.completion
          : null,
  };
}

export function insert(state: Composer, value: string): Composer {
  const text = state.text.slice(0, state.caret) + value + state.text.slice(state.caret);
  return withSlash({ ...state, text, caret: state.caret + value.length, recall: null });
}

export function backspace(state: Composer): Composer {
  if (state.caret === 0) return state;
  const before = Array.from(state.text.slice(0, state.caret));
  before.pop();
  const head = before.join('');
  return withSlash({
    ...state,
    text: head + state.text.slice(state.caret),
    caret: head.length,
    recall: null,
  });
}

export function moveCaret(state: Composer, direction: 'left' | 'right' | 'home' | 'end'): Composer {
  const { text, caret } = state;
  const step = (from: number, delta: number) => {
    const chars = Array.from(text);
    let position = 0;
    let index = 0;
    while (position < from && index < chars.length) position += chars[index++].length;
    const target = Math.max(0, Math.min(chars.length, index + delta));
    return chars.slice(0, target).join('').length;
  };
  const next =
    direction === 'left'
      ? step(caret, -1)
      : direction === 'right'
        ? step(caret, 1)
        : direction === 'home'
          ? lineStart(text, caret)
          : lineEnd(text, caret);
  return { ...state, caret: next };
}

/**
 * Up and Down move between the lines of a message. On its first line Up recalls the previous sent
 * message, and on its last line Down walks forward again to the text that was being written.
 */
export function vertical(state: Composer, direction: 'up' | 'down'): Composer {
  if (state.completion && state.completion.items.length > 0) {
    const count = state.completion.items.length;
    const index = (state.completion.index + (direction === 'up' ? count - 1 : 1)) % count;
    return { ...state, completion: { ...state.completion, index } as Completion };
  }
  const { text, caret } = state;
  const start = lineStart(text, caret);
  const column = caret - start;
  if (direction === 'up' && start > 0) {
    const previous = lineStart(text, start - 1);
    return { ...state, caret: Math.min(previous + column, start - 1) };
  }
  const end = lineEnd(text, caret);
  if (direction === 'down' && end < text.length) {
    const nextEnd = lineEnd(text, end + 1);
    return { ...state, caret: Math.min(end + 1 + column, nextEnd) };
  }
  if (direction === 'up') {
    if (state.history.length === 0) return state;
    const recall = state.recall === null ? state.history.length - 1 : Math.max(0, state.recall - 1);
    const value = state.history[recall];
    return {
      ...state,
      recall,
      draft: state.recall === null ? text : state.draft,
      text: value,
      caret: value.length,
      completion: null,
    };
  }
  if (state.recall === null) return state;
  const recall = state.recall + 1;
  const value = recall >= state.history.length ? state.draft : state.history[recall];
  return {
    ...state,
    recall: recall >= state.history.length ? null : recall,
    text: value,
    caret: value.length,
    completion: null,
  };
}

/** The mention being typed, for the controller's ranked list. Null when the caret is elsewhere. */
export const mentionQuery = (state: Composer) => findMentionTrigger(state.text, state.caret);

export function offerMentions(state: Composer, items: readonly MentionCandidate[]): Composer {
  if (!mentionQuery(state)) return state;
  return { ...state, completion: items.length ? { kind: 'mention', items, index: 0 } : null };
}

/** Tab or Enter on an open list takes the highlighted entry. */
export function acceptCompletion(state: Composer): Composer {
  const completion = state.completion;
  if (!completion) return state;
  if (completion.kind === 'slash') {
    const command = completion.items[completion.index];
    const text = `/${command.name}${command.argument ? ' ' : ''}`;
    return { ...state, text, caret: text.length, completion: null };
  }
  const trigger = mentionQuery(state);
  if (!trigger) return { ...state, completion: null };
  const next = insertMention(state.text, trigger, completion.items[completion.index]);
  return { ...state, ...next, completion: null };
}

export const closeCompletion = (state: Composer): Composer => ({ ...state, completion: null });

/** The box after a send: empty, with the message at the end of its history. */
export function sent(state: Composer): Composer {
  const text = state.text;
  const history =
    text.trim() === '' || state.history.at(-1) === text
      ? state.history
      : [...state.history, text].slice(-MAX_HISTORY);
  return emptyComposer(history);
}

/**
 * Paths after an at sign that start at the root or the home folder are files to attach, read by
 * the controller from disk. Paths inside the project stay mentions in the text.
 */
export function attachmentPaths(text: string, home: string): { text: string; paths: string[] } {
  const paths: string[] = [];
  const rest = text.replace(
    /(^|\s)@((?:\/|~\/)\S+)[ \t]?/g,
    (_whole, space: string, path: string) => {
      paths.push(path.startsWith('~/') ? `${home}/${path.slice(2)}` : path);
      return space;
    },
  );
  return { text: paths.length ? rest.trim() : text, paths };
}
