import type {
  ChatCatalogRead,
  ChatFamily,
  ChatModelSelection,
  ChatRole,
  ChatThread,
} from '@crewkite/contracts';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { familyName } from '../components.tsx';
import { askFamily, sendMessage, type ThreadSource } from './commands.ts';
import { defaultSelection, ModelPicker } from './model-picker.tsx';

export type RoleAction = Exclude<ChatRole, 'assistant' | 'fixer' | 'orchestrator' | 'ask'>;
/** The actions the row can open: the three role runs, and Ask for a side question. */
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
/** The Ask button names the family it will ask. */
export const askLabel = (selection: ChatModelSelection | null) =>
  selection ? `Ask ${familyName(selection.family)}` : 'Ask another model';

// The default is a family other than the one that answered last, so the second look is
// independent. With one connected family, that family is the only choice.
function roleDefault(
  catalog: ChatCatalogRead | null,
  answeredBy: ChatFamily | null,
): ChatModelSelection | null {
  return (answeredBy ? defaultSelection(catalog, [answeredBy]) : null) ?? defaultSelection(catalog);
}

/**
 * The Review changes, Second opinion and Challenge assumptions actions, and Ask. `row` is the
 * one-line picker under the text box while an action is open. The model is picked for this one turn
 * and the thread keeps its own. Ask sends the text in the box as a read-only question to the picked
 * family and posts the answer as a side reply, so it also works while a turn runs.
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
    if (!defaultSelection(catalog)) return 'No connected provider has allowance left.';
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
    if (!role || !taskId || !picked || blocked) return;
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
          label={`${role === 'ask' ? askLabel(picked) : roleActions[role].label}: provider and model`}
        />
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
  return { role, why, toggle, row, askLabel: askLabel(picked) };
}
