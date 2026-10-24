import type {
  ChatHandoffMode,
  ChatMessage,
  ChatPermissionPolicy,
  ChatRole,
  ChatThread,
  ChatTurn,
  WorkspaceState,
} from '@crewkite/contracts';
import { ArrowRightLeft, X } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { familyName } from '../components.tsx';
import { permissionPolicies } from '../settings/preferences.ts';
import { UsageGauges } from '../usage-gauges.tsx';
import { projectUsagePresentation } from '../usage-presentation.ts';
import { ChangesPanel } from './changes-panel.tsx';
import { readThread, type ThreadSource } from './commands.ts';
import { FamilyMark } from './family-mark.tsx';
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
  challenger: 'Challenger',
};
const handoffModes: { id: ChatHandoffMode; label: string }[] = [
  { id: 'most-left', label: 'the provider with the most allowance left' },
  { id: 'resets-first', label: 'the provider whose allowance resets soonest' },
];

// The chosen width is a local preference. Storage can be blocked, and the panel falls back to the
// default width when it is.
const widthKey = 'crewkite-inspector-width-v1';
const minWidth = 320;
const threadMinWidth = 520;
const keyStep = 16;
const narrowWindow = 1180;

// A narrow window keeps the smaller default so the thread still has room beside the panel.
const defaultWidth = (viewport: number) => (viewport <= narrowWindow ? 320 : 380);

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
 * The thread and the panel share the window less the navigation rail. The panel stops where the
 * thread would drop below its minimum, which at the 1080 px window minimum with the rail open is
 * 360 px. Room too narrow for both keeps the panel at its own minimum. The chosen value stays as
 * picked, so a wider window or a collapsed rail gets the panel back at the width the person set.
 */
function useInspectorWidth(panel: RefObject<HTMLElement | null>) {
  const [chosen, setChosen] = useState<number | null>(readWidth);
  const [room, setRoom] = useState(() => window.innerWidth);
  // Measured before paint, so a saved width never shows wider than the room allows. The rail has
  // its own widths per window size and when collapsed, so the room is read from the layout.
  useLayoutEffect(() => {
    const area = panel.current?.parentElement;
    if (!area) return;
    const measure = () => setRoom(area.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, [panel]);
  const max = Math.max(minWidth, room - threadMinWidth);
  const clamp = (width: number) => Math.min(Math.max(Math.round(width), minWidth), max);
  return {
    width: clamp(chosen ?? defaultWidth(window.innerWidth)),
    min: minWidth,
    max,
    // A drag changes the width on every move and saves it once, when the pointer is released.
    preview: (next: number) => setChosen(clamp(next)),
    save: (next: number | null) => {
      const value = next === null ? null : clamp(next);
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
    const wanted = Math.round(drag.current.start + drag.current.x - event.clientX);
    const next = Math.min(Math.max(wanted, min), max);
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
      // The capture can end without a pointerup reaching the handle, for example when the button
      // is released outside the window. The drag ends with it, so a later hover never resizes.
      onLostPointerCapture={end}
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

const stateLabels: Record<ChatTurn['state'], string> = {
  queued: 'Queued',
  running: 'Running',
  'waiting-permission': 'Waiting',
  done: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
};

// The stored stop reason is exact. A turn written before it existed falls back to the failure.
function turnState(turn: ChatTurn): { label: string; tone: string } {
  const limited = turn.stopReason
    ? turn.stopReason === 'limit'
    : turn.failure?.kind === 'usage-limit';
  if (turn.state === 'failed' && limited) return { label: 'Limit reached', tone: 'limit' };
  if (turn.failure?.kind === 'stopped') return { label: 'Stopped', tone: 'stopped' };
  return { label: stateLabels[turn.state], tone: turn.state };
}

const endedLabel = (iso: string) => {
  const at = new Date(iso);
  return at.toDateString() === new Date().toDateString()
    ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : at.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const asked = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

type TurnGroup = { messageId: string; text: string | null; turns: ChatTurn[] };

// Turns in sequence order under the message each one answered. A rerun after a handoff answers the
// same message, so it lands in the same group as the turn that stopped.
function turnGroups(turns: readonly ChatTurn[], messages: readonly ChatMessage[]): TurnGroup[] {
  const texts = new Map(messages.map((message) => [message.id, message.text]));
  const groups = new Map<string, TurnGroup>();
  for (const turn of turns.toSorted((a, b) => a.sequence - b.sequence)) {
    const group = groups.get(turn.userMessageId) ?? {
      messageId: turn.userMessageId,
      text: texts.get(turn.userMessageId) ?? null,
      turns: [],
    };
    group.turns.push(turn);
    groups.set(turn.userMessageId, group);
  }
  return [...groups.values()];
}

function TurnRow({ turn }: { turn: ChatTurn }) {
  const { family, model } = turn.selection;
  const state = turnState(turn);
  return (
    <li className="th-turn">
      <div className="th-turn-line">
        <FamilyMark family={family} />
        <span className="th-turn-model" title={model}>
          {familyName(family)} · {model}
        </span>
        <span className={`th-turn-state is-${state.tone}`}>{state.label}</span>
      </div>
      <div className="th-turn-meta">
        <span>{roleNames[turn.role]}</span>
        {turn.handoffFrom && (
          <span>
            <ArrowRightLeft size={11} aria-hidden="true" />
            From {familyName(turn.handoffFrom)}
          </span>
        )}
        {turn.endedAt && (
          <time dateTime={turn.endedAt} title={turn.endedAt}>
            Ended {endedLabel(turn.endedAt)}
          </time>
        )}
      </div>
    </li>
  );
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
  onConfigure: (patch: {
    permissionPolicy?: ChatPermissionPolicy;
    autoHandoff?: boolean;
    handoffMode?: ChatHandoffMode;
  }) => void;
}) {
  const [read, setRead] = useState<{ turns: ChatTurn[]; messages: ChatMessage[] } | null>(null);
  const active = thread?.activeTurnId ?? null;
  const accepted = thread?.lastAcceptance;
  // The thread record changes when a turn starts and when it ends, and the list follows it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the active turn reloads the list
  useEffect(() => {
    let current = true;
    readThread(source, taskId).then(
      (value) => current && setRead({ turns: value.turns, messages: value.messages }),
      () => current && setRead(null),
    );
    return () => {
      current = false;
    };
  }, [source, taskId, active]);
  const groups = read ? turnGroups(read.turns, read.messages) : [];
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
                  <span className="th-session">
                    <FamilyMark family={session.family} />
                    {familyName(session.family)} · {session.model}
                  </span>
                  <code title={session.sessionId}>{session.sessionId.slice(0, 12)}</code>
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
      <div className="th-handoff">
        <label className="th-toggle">
          <input
            type="checkbox"
            checked={thread?.autoHandoff ?? false}
            disabled={!thread}
            onChange={(event) => onConfigure({ autoHandoff: event.target.checked })}
          />
          Continue on another provider when a limit is reached
        </label>
        <label>
          When a limit is reached, continue on
          <select
            value={thread?.handoffMode ?? 'most-left'}
            disabled={!thread?.autoHandoff}
            onChange={(event) =>
              onConfigure({ handoffMode: event.target.value as ChatHandoffMode })
            }
          >
            {handoffModes.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <section className="th-turns" aria-labelledby="th-turns-head">
        <h3 id="th-turns-head">Turns</h3>
        {read === null ? (
          <p className="th-muted">Not available yet.</p>
        ) : groups.length === 0 ? (
          <p className="th-muted">None yet.</p>
        ) : (
          <ol>
            {groups.map((group) => (
              <li key={group.messageId}>
                <p className="th-turn-ask" title={group.text ?? undefined}>
                  {group.text ? asked(group.text) : 'An earlier message'}
                </p>
                <ol className="th-turn-list">
                  {group.turns.map((turn) => (
                    <TurnRow key={turn.id} turn={turn} />
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        )}
      </section>
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
  onConfigure: (patch: {
    permissionPolicy?: ChatPermissionPolicy;
    autoHandoff?: boolean;
    handoffMode?: ChatHandoffMode;
  }) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const size = useInspectorWidth(panel);
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
    <aside
      ref={panel}
      className="th-inspector"
      aria-label="Inspector"
      style={{ width: size.width }}
    >
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
