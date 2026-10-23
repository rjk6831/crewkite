import type {
  ChatPermissionPolicy,
  ChatRole,
  ChatThread,
  ChatTurn,
  WorkspaceState,
} from '@crewkite/contracts';
import { X } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { familyName } from '../components.tsx';
import { permissionPolicies } from '../settings/preferences.ts';
import { UsageGauges } from '../usage-gauges.tsx';
import { projectUsagePresentation } from '../usage-presentation.ts';
import { ChangesPanel } from './changes-panel.tsx';
import { readThread, type ThreadSource } from './commands.ts';
import { usageCards, useUsageClock } from './usage-cards.ts';

export type InspectorTab = 'changes' | 'usage' | 'thread';
const tabs: { id: InspectorTab; label: string }[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'usage', label: 'Usage' },
  { id: 'thread', label: 'Thread' },
];
const roleNames: Record<ChatRole, string> = {
  assistant: 'Assistant',
  reviewer: 'Reviewer',
  advisor: 'Advisor',
};

// The chosen width is a local preference. Storage can be blocked, and the panel falls back to the
// default width when it is.
const widthKey = 'crewkite-inspector-width-v1';
const minWidth = 320;
const maxShare = 0.6;
const keyStep = 16;
const narrowWindow = 1180;

// A narrow window keeps the smaller default so the thread still has room beside the panel.
const defaultWidth = (viewport: number) => (viewport <= narrowWindow ? 320 : 380);
const maxWidth = (viewport: number) => Math.max(minWidth, Math.floor(viewport * maxShare));
const clampWidth = (width: number, viewport: number) =>
  Math.min(Math.max(Math.round(width), minWidth), maxWidth(viewport));

function readWidth(): number | null {
  try {
    const width = Number.parseInt(localStorage.getItem(widthKey) ?? '', 10);
    return Number.isFinite(width) ? width : null;
  } catch {
    return null;
  }
}
function writeWidth(width: number | null) {
  try {
    if (width === null) localStorage.removeItem(widthKey);
    else localStorage.setItem(widthKey, String(width));
  } catch {}
}

/**
 * The width follows the window as it shrinks, and the chosen value stays as picked, so a window
 * that grows again gets the panel back at the width the person set.
 */
function useInspectorWidth() {
  const [chosen, setChosen] = useState<number | null>(readWidth);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const width = clampWidth(chosen ?? defaultWidth(viewport), viewport);
  return {
    width,
    min: minWidth,
    max: maxWidth(viewport),
    // A drag changes the width on every move and saves it once, when the pointer is released.
    preview: (next: number) => setChosen(clampWidth(next, window.innerWidth)),
    save: (next: number | null) => {
      const value = next === null ? null : clampWidth(next, window.innerWidth);
      setChosen(value);
      writeWidth(value);
    },
  };
}

function ResizeHandle({
  width,
  min,
  max,
  onPreview,
  onSave,
}: {
  width: number;
  min: number;
  max: number;
  onPreview: (width: number) => void;
  onSave: (width: number | null) => void;
}) {
  const drag = useRef<{ x: number; start: number; latest: number | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const begin = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, start: width, latest: null };
    setDragging(true);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // The panel sits on the right, so moving the pointer left makes it wider.
    const next = clampWidth(drag.current.start + drag.current.x - event.clientX, window.innerWidth);
    drag.current.latest = next;
    onPreview(next);
  };
  const end = () => {
    if (!drag.current) return;
    // A click or a double-click never moves the pointer, and it must not pin the default width.
    if (drag.current.latest !== null) onSave(drag.current.latest);
    drag.current = null;
    setDragging(false);
  };
  const press = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // The handle is on the left edge, so Left moves the edge left and widens the panel.
    const target: Record<string, number> = {
      ArrowLeft: width + keyStep,
      ArrowRight: width - keyStep,
      Home: min,
      End: max,
    };
    if (!Object.hasOwn(target, event.key)) return;
    event.preventDefault();
    onSave(target[event.key]);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a separator that takes focus and keys is a window splitter, which <hr> cannot be
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize inspector"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      className={dragging ? 'th-resize is-dragging' : 'th-resize'}
      title="Drag to resize. Double-click to reset."
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onSave(null)}
      onKeyDown={press}
    />
  );
}

function UsageTab({ header, preview }: { header: WorkspaceState | null; preview: boolean }) {
  const now = useUsageClock(header?.usage ?? [], preview);
  if (!header) return <p className="th-muted">Usage is not available yet.</p>;
  const cards = usageCards(projectUsagePresentation(header, null, now), header);
  if (cards.length === 0)
    return (
      <p className="th-muted">
        No provider usage has been read yet. Connect a provider in Settings.
      </p>
    );
  return <UsageGauges cards={cards} nowMs={now} />;
}

function ThreadTab({
  source,
  taskId,
  thread,
  onConfigure,
}: {
  source: ThreadSource;
  taskId: string;
  thread: ChatThread | null;
  onConfigure: (patch: { permissionPolicy?: ChatPermissionPolicy; autoHandoff?: boolean }) => void;
}) {
  const [turns, setTurns] = useState<ChatTurn[] | null>(null);
  const active = thread?.activeTurnId ?? null;
  const accepted = thread?.lastAcceptance;
  // The thread record changes when a turn starts and when it ends, and the list follows it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the active turn reloads the list
  useEffect(() => {
    let current = true;
    readThread(source, taskId).then(
      (read) => current && setTurns(read.turns),
      () => current && setTurns(null),
    );
    return () => {
      current = false;
    };
  }, [source, taskId, active]);
  return (
    <div className="th-facts">
      <dl>
        <dt>Task</dt>
        <dd>
          <code>{taskId}</code>
        </dd>
        <dt>Base</dt>
        <dd>{thread?.base ? <code>{thread.base}</code> : 'None yet'}</dd>
        <dt>Scratch copy</dt>
        <dd>{thread?.scratchReady ? 'Ready' : 'Created on the first edit'}</dd>
        <dt>Accepted</dt>
        <dd>
          {accepted
            ? `${accepted.branch} · ${accepted.fileCount} ${accepted.fileCount === 1 ? 'file' : 'files'}`
            : 'Not yet'}
        </dd>
        <dt>Sessions</dt>
        <dd>
          {thread && thread.sessions.length > 0 ? (
            <ul>
              {thread.sessions.map((session) => (
                <li key={session.family}>
                  {familyName(session.family)} · {session.model}
                  <code title={session.sessionId}>{session.sessionId.slice(0, 12)}</code>
                </li>
              ))}
            </ul>
          ) : (
            'None yet'
          )}
        </dd>
        <dt>Turns</dt>
        <dd>
          {turns === null ? (
            'Not available yet'
          ) : turns.length > 0 ? (
            <ul>
              {turns.map((turn) => (
                <li key={turn.id}>
                  {roleNames[turn.role]} · {familyName(turn.selection.family)} ·{' '}
                  {turn.selection.model}
                </li>
              ))}
            </ul>
          ) : (
            'None yet'
          )}
        </dd>
      </dl>
      <label>
        Permissions
        <select
          value={thread?.permissionPolicy ?? 'ask'}
          disabled={!thread}
          onChange={(event) =>
            onConfigure({ permissionPolicy: event.target.value as ChatPermissionPolicy })
          }
        >
          {permissionPolicies.map((policy) => (
            <option key={policy.id} value={policy.id}>
              {policy.label}
            </option>
          ))}
        </select>
      </label>
      <label className="th-toggle">
        <input
          type="checkbox"
          checked={thread?.autoHandoff ?? false}
          disabled={!thread}
          onChange={(event) => onConfigure({ autoHandoff: event.target.checked })}
        />
        Continue on another provider when a limit is reached
      </label>
    </div>
  );
}

export function Inspector({
  source,
  taskId,
  title,
  thread,
  header,
  preview,
  tab,
  onTab,
  onClose,
  changesKey,
  focusPath,
  onConfigure,
}: {
  source: ThreadSource;
  taskId: string;
  title: string;
  thread: ChatThread | null;
  header: WorkspaceState | null;
  preview: boolean;
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  onClose: () => void;
  changesKey: number;
  focusPath: string | null;
  onConfigure: (patch: { permissionPolicy?: ChatPermissionPolicy; autoHandoff?: boolean }) => void;
}) {
  const size = useInspectorWidth();
  // Escape closes the panel unless a picker or field inside it already took the key, or a dialog
  // such as search is open and owns it.
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('dialog[open]')) return;
      onClose();
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);
  return (
    <aside className="th-inspector" aria-label="Inspector" style={{ width: size.width }}>
      <ResizeHandle
        width={size.width}
        min={size.min}
        max={size.max}
        onPreview={size.preview}
        onSave={size.save}
      />
      <div className="th-inspector-head">
        <div role="tablist" aria-label="Inspector sections">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`th-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls="th-inspector-panel"
              className={tab === item.id ? 'active' : ''}
              onClick={() => onTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button type="button" className="th-icon" aria-label="Close inspector" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <div
        className="th-inspector-body"
        id="th-inspector-panel"
        role="tabpanel"
        aria-labelledby={`th-tab-${tab}`}
      >
        {tab === 'changes' && (
          <ChangesPanel
            source={source}
            taskId={taskId}
            title={title}
            thread={thread}
            refreshKey={changesKey}
            focusPath={focusPath}
          />
        )}
        {tab === 'usage' && <UsageTab header={header} preview={preview} />}
        {tab === 'thread' && (
          <ThreadTab source={source} taskId={taskId} thread={thread} onConfigure={onConfigure} />
        )}
      </div>
    </aside>
  );
}
