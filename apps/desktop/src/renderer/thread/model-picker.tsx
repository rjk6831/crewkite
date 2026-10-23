import type {
  ChatCatalogRead,
  ChatEffort,
  ChatFamily,
  ChatModelSelection,
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

// The window with the least left decides what the person can still do, so it is the one shown.
function allowance(entry: Entry, nowMs: number): string {
  if (entry.family === 'local' && entry.remaining.length === 0) return 'Runs on this computer';
  const known = entry.remaining.filter((window) => window.percent !== null);
  if (known.length === 0) return 'Allowance unknown';
  const tight = known.reduce((least, window) =>
    (window.percent ?? 100) < (least.percent ?? 100) ? window : least,
  );
  const left = `${Math.floor(tight.percent ?? 0)}% left`;
  const reset = tight.resetsAt ? Date.parse(tight.resetsAt) - nowMs : null;
  return reset !== null && reset > 0 ? `${left}, resets in ${formatSpan(reset)}` : left;
}

export function findModel(catalog: ChatCatalogRead | null, selection: ChatModelSelection | null) {
  const entry = catalog?.families.find(({ family }) => family === selection?.family);
  return { entry, model: entry?.models.find(({ model }) => model === selection?.model) };
}

// A new thread starts on the connected family with the most allowance left. A family that reports
// nothing ranks below one that reports something, and the local family ranks last.
export function defaultSelection(catalog: ChatCatalogRead | null): ChatModelSelection | null {
  const rank = (entry: Entry) => {
    const known = entry.remaining.flatMap(({ percent }) => (percent === null ? [] : [percent]));
    return known.length > 0 ? Math.min(...known) : entry.family === 'local' ? -2 : -1;
  };
  const ranked = (catalog?.families ?? [])
    .filter((entry) => entry.connected && entry.models.length > 0)
    .sort((a, b) => rank(b) - rank(a));
  const entry = ranked[0];
  const model = entry?.models.find(({ model }) => model === entry.defaultModel) ?? entry?.models[0];
  return entry && model
    ? { family: entry.family, model: model.model, effort: model.defaultEffort }
    : null;
}

// The picked model moves the thread when it belongs to another family. Otherwise the connected family
// with the most allowance left is offered, so the action works without a prior pick.
function handoffTarget(
  catalog: ChatCatalogRead | null,
  selection: ChatModelSelection | null,
  currentFamily: ChatFamily | null,
): ChatModelSelection | null {
  if (!currentFamily) return null;
  if (selection && selection.family !== currentFamily) return selection;
  const left = (entry: Entry) =>
    Math.min(100, ...entry.remaining.map((window) => window.percent ?? 100));
  const options = (catalog?.families ?? [])
    .filter((entry) => entry.connected && entry.family !== currentFamily && entry.models.length > 0)
    .sort((a, b) => left(b) - left(a));
  const entry = options[0];
  const model = entry?.models.find(({ model }) => model === entry.defaultModel) ?? entry?.models[0];
  return entry && model
    ? { family: entry.family, model: model.model, effort: model.defaultEffort }
    : null;
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
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close, true);
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
