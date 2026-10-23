import {
  type ChatCatalogRead,
  type ChatEffort,
  type ChatFamily,
  type ChatModelSelection,
  rankFamilies,
  tightestAllowance,
} from '@crewkite/contracts';
import { ArrowRightLeft, Check, ChevronDown } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { familyName } from '../components.tsx';
import { formatSpan } from '../usage-gauges.tsx';

type Entry = ChatCatalogRead['families'][number];

export const effortLabels: Record<ChatEffort, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  default: 'Default',
};

const left = (percent: number | null) =>
  percent === null ? 'Allowance unknown' : `${Math.floor(percent)}% left`;

// The window with the least left decides what the person can still do, so it is the one shown. The
// family line follows its default model. A window named for another model does not count.
function allowance(entry: Entry, nowMs: number): string {
  if (entry.family === 'local' && entry.remaining.length === 0) return 'Runs on this computer';
  const { percent, resetsAt } = tightestAllowance(entry, entry.defaultModel);
  const reset = resetsAt ? Date.parse(resetsAt) - nowMs : null;
  return percent !== null && reset !== null && reset > 0
    ? `${left(percent)}, resets in ${formatSpan(reset)}`
    : left(percent);
}

// A model with a window of its own, such as a weekly pool for one model, shows what it has left
// on its row when that differs from the family line.
function modelAllowance(entry: Entry, model: string): string | null {
  const own = left(tightestAllowance(entry, model).percent);
  return own === left(tightestAllowance(entry, entry.defaultModel).percent) ? null : own;
}

export function findModel(catalog: ChatCatalogRead | null, selection: ChatModelSelection | null) {
  const entry = catalog?.families.find(({ family }) => family === selection?.family);
  return { entry, model: entry?.models.find(({ model }) => model === selection?.model) };
}

// The top family in the contract ranking, on its default model. A family with no models listed
// cannot be picked, so it does not compete.
export function defaultSelection(
  catalog: ChatCatalogRead | null,
  exclude: readonly ChatFamily[] = [],
): ChatModelSelection | null {
  const [entry] = rankFamilies(
    (catalog?.families ?? []).filter((value) => value.models.length > 0),
    exclude,
  );
  const model = entry?.models.find(({ model }) => model === entry.defaultModel) ?? entry?.models[0];
  return entry && model
    ? { family: entry.family, model: model.model, effort: model.defaultEffort }
    : null;
}

// The picked model moves the thread when it belongs to another family. Otherwise the best ranked
// other family is offered, so the action works without a prior pick.
function handoffTarget(
  catalog: ChatCatalogRead | null,
  selection: ChatModelSelection | null,
  currentFamily: ChatFamily | null,
): ChatModelSelection | null {
  if (!currentFamily) return null;
  if (selection && selection.family !== currentFamily) return selection;
  return defaultSelection(catalog, [currentFamily]);
}

export function ModelPicker({
  catalog,
  selection,
  currentFamily,
  running,
  nowMs,
  onOpen,
  onSelect,
  onHandoff,
  label: menuLabel = 'Provider and model',
}: {
  catalog: ChatCatalogRead | null;
  selection: ChatModelSelection | null;
  currentFamily: ChatFamily | null;
  running: boolean;
  nowMs: number;
  onOpen: () => void;
  onSelect: (selection: ChatModelSelection) => void;
  /** Without it the menu lists models only. The thread moves providers from the main composer. */
  onHandoff?: (selection: ChatModelSelection) => Promise<void>;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        // Claimed here so the inspector, which listens after this, stays open for this press.
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      } else if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    // Focus that moves to something else, such as the search dialog, closes the menu too.
    const leave = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && !root.current?.contains(event.relatedTarget))
        setOpen(false);
    };
    const element = root.current;
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close, true);
    element?.addEventListener('focusout', leave);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close, true);
      element?.removeEventListener('focusout', leave);
    };
  }, [open]);
  // Focus lands on the chosen model, so the arrow keys work as soon as the menu opens.
  useEffect(() => {
    if (!open) return;
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    (
      menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)') ??
      items?.[0]
    )?.focus();
  }, [open]);
  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const items = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const to =
      event.key === 'ArrowDown'
        ? (at + 1) % items.length
        : event.key === 'ArrowUp'
          ? (at <= 0 ? items.length : at) - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : null;
    if (event.key === 'Tab') setOpen(false);
    if (to === null || items.length === 0) return;
    event.preventDefault();
    items[to].focus();
  }
  const { entry, model } = findModel(catalog, selection);
  const label = selection
    ? `${familyName(selection.family)} · ${model?.label ?? selection.model}`
    : 'Choose a model';
  const target = onHandoff ? handoffTarget(catalog, selection, currentFamily) : null;
  const targetName = target
    ? `${familyName(target.family)} · ${findModel(catalog, target).model?.label ?? target.model}`
    : null;
  const handoffTitle = running
    ? 'Wait for the current turn to finish.'
    : target
      ? `Move this thread to ${targetName} now.`
      : 'No other provider is connected.';
  return (
    <div className="th-picker" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="th-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (!open) onOpen();
          setOpen(!open);
        }}
      >
        {selection && <span className={`th-dot family-${selection.family}`} aria-hidden="true" />}
        <span>{label}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="th-menu"
          id={menuId}
          ref={menu}
          role="menu"
          aria-label={menuLabel}
          tabIndex={-1}
          onKeyDown={onMenuKey}
        >
          {!catalog && <p className="th-menu-empty">Models are not available yet.</p>}
          {catalog?.families.map((family) => (
            <div
              key={family.family}
              className="th-menu-group"
              title={family.connected ? undefined : (family.reason ?? 'Not connected')}
            >
              <div className={family.connected ? 'th-menu-head' : 'th-menu-head is-off'}>
                <span className={`th-dot family-${family.family}`} aria-hidden="true" />
                <strong>{familyName(family.family)}</strong>
                <span>{family.connected ? allowance(family, nowMs) : 'Not connected'}</span>
              </div>
              {family.models.map((item) => {
                const checked =
                  selection?.family === family.family && selection.model === item.model;
                const own = family.connected ? modelAllowance(family, item.model) : null;
                return (
                  <button
                    key={item.model}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    disabled={!family.connected}
                    title={family.connected ? undefined : (family.reason ?? 'Not connected')}
                    onClick={() => {
                      onSelect({
                        family: family.family,
                        model: item.model,
                        effort: checked && selection ? selection.effort : item.defaultEffort,
                      });
                      setOpen(false);
                    }}
                  >
                    <span>{item.label}</span>
                    {own && <em>{own}</em>}
                    {checked && <Check size={14} aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          ))}
          {onHandoff && (
            <button
              type="button"
              role="menuitem"
              className="th-menu-foot"
              disabled={running || !target}
              title={handoffTitle}
              onClick={() => {
                if (!target) return;
                setOpen(false);
                void onHandoff(target);
              }}
            >
              <ArrowRightLeft size={14} aria-hidden="true" />
              <span>Continue on another provider</span>
              {target && !running && <em>{targetName}</em>}
            </button>
          )}
        </div>
      )}
      {entry && model && model.efforts.length > 0 && selection && (
        <label className="th-effort">
          <span className="th-sr">Effort</span>
          <select
            value={selection.effort}
            onChange={(event) =>
              onSelect({ ...selection, effort: event.target.value as ChatEffort })
            }
          >
            {model.efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effortLabels[effort]}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
