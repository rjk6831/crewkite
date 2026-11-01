import {
  type ChatCatalogRead,
  type ChatFamily,
  type ChatModelSelection,
  type ChatRole,
  type ChatThread,
  rankFamilies,
} from '@crewkite/contracts';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { familyName } from '../components.tsx';
import { askFamily, sendMessage, type ThreadSource } from './commands.ts';
import { defaultSelection, ModelPicker } from './model-picker.tsx';

export type RoleAction = Exclude<ChatRole, 'assistant' | 'fixer' | 'orchestrator' | 'ask'>;
/** The actions the row can open: the three role runs, and Quick question for a side question. */
export type RowAction = RoleAction | 'ask';
export const roleActions: Record<RoleAction, { label: string; prompt: string }> = {
  reviewer: { label: 'Review changes', prompt: 'Review the current changes.' },
  advisor: { label: 'Second opinion', prompt: 'Give a second opinion on the last answer.' },
  challenger: {
    label: 'Challenge assumptions',
    prompt: 'Challenge the assumptions behind the last answer.',
  },
};

export const ASK_NEEDS_TEXT = 'Type the question in the box first.';
/** The composer action that opens the side question row. */
export const QUICK_QUESTION = 'Quick question';
/** The row's send button names the provider the question goes to. */
export const askLabel = (selection: ChatModelSelection | null) =>
  selection ? `Send to ${familyName(selection.family)}` : 'Send the question';

/** The row's note when no model is picked and no provider offers a default. */
export const PICK_A_MODEL = 'Pick a model in the row to send.';

// A connected family whose client lists no models still names the model it runs by default.
function providerDefault(
  catalog: ChatCatalogRead | null,
  exclude: readonly ChatFamily[] = [],
): ChatModelSelection | null {
  const [entry] = rankFamilies(catalog?.families ?? [], exclude).filter(
    (value) => value.defaultModel,
  );
  return entry?.defaultModel
    ? { family: entry.family, model: entry.defaultModel, effort: 'default' }
    : null;
}

// The default is a family other than the one that answered last, so the second look is
// independent. With one connected family, that family is the only choice. A family whose client
// lists no models takes its default model.
function roleDefault(
  catalog: ChatCatalogRead | null,
  answeredBy: ChatFamily | null,
): ChatModelSelection | null {
  const exclude = answeredBy ? [answeredBy] : null;
  return (
    (exclude ? defaultSelection(catalog, exclude) : null) ??
    defaultSelection(catalog) ??
    (exclude ? providerDefault(catalog, exclude) : null) ??
    providerDefault(catalog)
  );
}

/**
 * The Review changes, Second opinion and Challenge assumptions actions, and Quick question. `row`
 * is the one-line picker under the text box while an action is open. The model is picked for this
 * one turn and the thread keeps its own. Quick question sends the text in the box as a read-only
 * side question to the picked provider and posts the answer as a side reply, so it also works
 * while a turn runs. It never starts the crew.
 */
export function useRoleRun({
  source,
  taskId,
  thread,
  catalog,
  currentFamily,
  running,
  blocked,
  onOpenCatalog,
  onNote,
  question,
  onAsked,
}: {
  source: ThreadSource;
  taskId: string | null;
  thread: ChatThread | null;
  catalog: ChatCatalogRead | null;
  currentFamily: ChatFamily | null;
  running: boolean;
  blocked: string | null;
  onOpenCatalog: () => void;
  onNote: (note: string | null) => void;
  /** The text in the box, which Ask sends. */
  question: string;
  /** Ask went out, so the box can clear. */
  onAsked: () => void;
}) {
  const [role, setRole] = useState<RowAction | null>(null);
  const [pick, setPick] = useState<ChatModelSelection | null>(null);
  const picked = pick ?? roleDefault(catalog, currentFamily);
  const rowRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  // Focus moves into the row when it opens, so Escape reaches it from the keyboard.
  useEffect(() => {
    if (role) rowRef.current?.querySelector('button')?.focus();
  }, [role]);

  function why(action: RowAction): string | null {
    if (blocked) return blocked;
    if (running && action !== 'ask') return 'Wait for the current turn to finish.';
    if (!roleDefault(catalog, null)) return 'No connected provider has allowance left.';
    if (action === 'ask') return null;
    if (action === 'reviewer' && !thread?.scratchReady)
      return 'There is no scratch copy to review yet.';
    if (action !== 'reviewer' && !currentFamily) return 'There is no answer to look at yet.';
    return null;
  }
  function toggle(action: RowAction) {
    if (role === action) return setRole(null);
    onOpenCatalog();
    setPick(null);
    opener.current = document.activeElement;
    setRole(action);
  }
  async function run() {
    if (!role || !taskId || blocked) return;
    if (!picked) return onNote(PICK_A_MODEL);
    if (role !== 'ask' && running) return;
    try {
      if (role === 'ask') {
        await askFamily(source, {
          taskId,
          family: picked.family,
          model: picked.model,
          question,
        });
        onAsked();
      } else
        await sendMessage(source, {
          taskId,
          text: roleActions[role].prompt,
          selection: picked,
          role,
        });
      setRole(null);
      onNote(null);
    } catch (failure) {
      onNote(failure instanceof Error ? failure.message : 'The request was not sent.');
    }
  }
  // Escape closes the row unless an open menu inside it already took the key. Focus goes back to
  // the button that opened it.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    setRole(null);
    if (opener.current instanceof HTMLElement) opener.current.focus();
  }

  const row =
    taskId && role ? (
      // biome-ignore lint/a11y/noStaticElementInteractions: the handler only closes the row on Escape
      <div className="th-attach-row" id="th-role-row" ref={rowRef} onKeyDown={onKeyDown}>
        <ModelPicker
          catalog={catalog}
          selection={picked}
          currentFamily={null}
          running={running}
          nowMs={Date.now()}
          onOpen={onOpenCatalog}
          onSelect={setPick}
          label={`${role === 'ask' ? QUICK_QUESTION : roleActions[role].label}: provider and model`}
        />
        {!picked && <span className="th-row-note">{PICK_A_MODEL}</span>}
        {role === 'ask' ? (
          <button
            type="button"
            disabled={!picked || question.trim() === '' || !!blocked}
            title={question.trim() === '' ? ASK_NEEDS_TEXT : undefined}
            onClick={() => void run()}
          >
            {askLabel(picked)}
          </button>
        ) : (
          <button
            type="button"
            disabled={!picked || running || !!blocked}
            onClick={() => void run()}
          >
            Run
          </button>
        )}
        <button type="button" onClick={() => setRole(null)}>
          Cancel
        </button>
      </div>
    ) : null;
  /** Send the box as the side question, when the Quick question row is open. */
  const ask = role === 'ask' ? run : null;
  return { role, why, toggle, row, ask };
}
