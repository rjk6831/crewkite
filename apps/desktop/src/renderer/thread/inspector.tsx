import {
  allowsSubagents,
  type ChatCrewChain,
  ChatCrewRoleSchema,
  type ChatFlightMode,
  type ChatHandoffMode,
  type ChatMessage,
  type ChatModelSelection,
  type ChatPermissionPolicy,
  type ChatRole,
  type ChatThread,
  type ChatTurn,
  type WorkspaceState,
  writesScratch,
} from '@crewkite/contracts';
import { ArrowRightLeft, RefreshCw, X } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { AnalyticsView } from '../analytics-view.tsx';
import { familyName } from '../components.tsx';
import {
  ExtensionInspectorTab,
  extensionTabId,
  slotsOf,
  useExtensions,
} from '../extension-slots.tsx';
import { clientFor } from '../settings/client-status.tsx';
import { modelChoices, SelectionFields } from '../settings/general-card.tsx';
import { McpThreadMenu } from '../settings/mcp-card.tsx';
import {
  crewFromPreset,
  crewPresetNames,
  crewRoleNames,
  flightModes,
  handoffModes,
  permissionPolicies,
  readCrewPresets,
} from '../settings/preferences.ts';
import { useProviderActions } from '../settings/provider-actions.ts';
import { useCatalog } from '../settings/use-catalog.ts';
import { UsageGauges } from '../usage-gauges.tsx';
import { projectUsagePresentation } from '../usage-presentation.ts';
import { ChangesPanel } from './changes-panel.tsx';
import { ChecksSettings } from './checks-card.tsx';
import { configureThread, type ThreadSource } from './commands.ts';
import { FamilyMark } from './family-mark.tsx';
import { modelLine } from './message-list.tsx';
import type { ThreadSettings } from './thread-state.ts';
import { usageCards, useUsageClock } from './usage-cards.ts';
import './crew.css';
import { useModelLabel } from './model-labels.ts';
import { RoleInfo } from './role-info.tsx';
import { SubagentSwitch } from './subagent-switch.tsx';

export type InspectorTab = 'changes' | 'usage' | 'analytics' | 'crew' | 'thread' | `ext:${string}`;
const tabs: { id: InspectorTab; label: string }[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'usage', label: 'Usage' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'crew', label: 'Crew' },
  { id: 'thread', label: 'Thread' },
];
const roleNames: Record<ChatRole, string> = {
  assistant: 'Assistant',
  reviewer: 'Reviewer',
  advisor: 'Advisor',
  challenger: 'Challenger',
  fixer: 'Fixer',
  orchestrator: 'Orchestrator',
  ask: 'Ask',
};

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

const refreshFamilies = ['openai', 'anthropic', 'google'] as const;

function UsageTab({
  source,
  header,
  preview,
}: {
  source: ThreadSource;
  header: WorkspaceState | null;
  preview: boolean;
}) {
  const now = useUsageClock(header?.usage ?? [], preview);
  // The same quota commands the Settings cards send. The workspace reads its snapshot again on
  // the reader events they cause, so the gauges below update without a reload here.
  const actions = useProviderActions({ metadataCommand: (input) => source.command(input) });
  if (!header) return <p className="th-muted">Usage is not available yet.</p>;
  const cards = usageCards(projectUsagePresentation(header, null, now), header);
  const refresh = refreshFamilies.flatMap((family) => {
    const { label, reader, cooldownSeconds } = clientFor(header, family, now);
    if (!reader) return [];
    const reading = reader.readState === 'intent' || reader.readState === 'owned';
    return [
      <li key={family} className="th-usage-refresh-row">
        <span>{label}</span>
        <button
          type="button"
          className="th-button"
          aria-label={`Refresh ${label} usage`}
          disabled={
            preview ||
            !reader.available ||
            actions.busy[family] ||
            reading ||
            reader.readState === 'unknown' ||
            cooldownSeconds > 0
          }
          title={cooldownSeconds > 0 ? `Refresh available in ${cooldownSeconds}s.` : undefined}
          onClick={() =>
            void (family === 'anthropic'
              ? actions.refreshAnthropic()
              : actions.observeUsage(family))
          }
        >
          <RefreshCw size={13} aria-hidden="true" /> {reading ? 'Reading' : 'Refresh'}
        </button>
        {actions.messages[family] && <small role="status">{actions.messages[family]}</small>}
      </li>,
    ];
  });
  return (
    <>
      {refresh.length > 0 && (
        <ul className="th-usage-refresh" aria-label="Refresh usage">
          {refresh}
        </ul>
      )}
      {cards.length === 0 ? (
        <p className="th-muted">
          No provider usage has been read yet. Connect a provider in Settings.
        </p>
      ) : (
        <UsageGauges cards={cards} nowMs={now} />
      )}
    </>
  );
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

// The effort the client reported on the reply beats the one the thread asked for.
function TurnRow({ turn, reply }: { turn: ChatTurn; reply: ChatMessage | undefined }) {
  const label = useModelLabel();
  const state = turnState(turn);
  const effort = reply?.author.kind === 'assistant' ? reply.author.effort : undefined;
  return (
    <li className="th-turn">
      <div className="th-turn-line">
        <FamilyMark family={turn.selection.family} />
        <span className="th-turn-model" title={turn.selection.model}>
          {modelLine({ ...turn.selection, effort: effort ?? turn.selection.effort }, label)}
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

/** The thread's own automatic handoff setting. Glide turns it on; the person can turn it off. */
function AutoHandoff({
  thread,
  onConfigure,
}: {
  thread: ChatThread | null;
  onConfigure: (patch: ThreadSettings) => void;
}) {
  return (
    <label className="th-toggle">
      <input
        type="checkbox"
        checked={thread?.autoHandoff ?? false}
        disabled={!thread}
        onChange={(event) => onConfigure({ autoHandoff: event.target.checked })}
      />
      Continue on another provider when a limit is reached
    </label>
  );
}

// The turns and messages come from the thread view's own state, which the stream keeps current and
// a failed reload leaves as it was. A read of its own would queue behind other controller reads,
// and one that timed out would empty the list.
function ThreadTab({
  taskId,
  thread,
  turns,
  messages,
  loaded,
  onConfigure,
}: {
  taskId: string;
  thread: ChatThread | null;
  turns: readonly ChatTurn[];
  messages: readonly ChatMessage[];
  loaded: boolean;
  onConfigure: (patch: ThreadSettings) => void;
}) {
  const accepted = thread?.lastAcceptance;
  const groups = turnGroups(turns, messages);
  const replies = new Map(messages.map((message) => [message.id, message]));
  const mode = handoffModes.find(({ id }) => id === thread?.handoffMode) ?? handoffModes[0];
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
      <McpThreadMenu taskId={taskId} permissionPolicy={thread?.permissionPolicy ?? 'ask'} />
      <div className="th-handoff">
        <AutoHandoff thread={thread} onConfigure={onConfigure} />
        {/* The limit offer and the picker rank by the mode too, so it stays open with the box off. */}
        <label>
          Handoff mode
          <select
            value={mode.id}
            title={mode.title}
            disabled={!thread}
            onChange={(event) =>
              onConfigure({ handoffMode: event.target.value as ChatHandoffMode })
            }
          >
            {handoffModes.map((item) => (
              <option key={item.id} value={item.id} title={item.title}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <section className="th-turns" aria-labelledby="th-turns-head">
        <h3 id="th-turns-head">Turns</h3>
        {!loaded ? (
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
                    <TurnRow
                      key={turn.id}
                      turn={turn}
                      reply={
                        turn.assistantMessageId ? replies.get(turn.assistantMessageId) : undefined
                      }
                    />
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

const counted = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

function chainLine(chain: ChatCrewChain | null): string {
  if (!chain) return 'No chain has run in this thread yet.';
  switch (chain.step) {
    case 'review':
      return `Reviewing, round ${chain.reviewRounds + 1}`;
    case 'fix':
      return 'Fixing';
    case 'challenge':
      return 'Challenging';
    case 'finished':
      return `Finished: ${counted(chain.reviewRounds, 'review round', 'review rounds')}, ${counted(chain.fixes, 'fix', 'fixes')}.`;
    case 'stopped':
      return `Stopped: ${chain.reason ?? 'no reason was recorded.'}`;
  }
}

function CrewTab({
  source,
  thread,
  onConfigure,
}: {
  source: ThreadSource;
  thread: ChatThread | null;
  onConfigure: (patch: ThreadSettings) => void;
}) {
  // Read once when the tab opens and again when a model read ends. A preset only needs to know
  // which families are connected, and every extra catalog read waits in the controller's queue.
  const { catalog } = useCatalog(source, null);
  const label = useModelLabel();
  const [note, setNote] = useState<string | null>(null);
  const crew = thread?.crew ?? null;
  const mode = flightModes.find(({ id }) => id === thread?.flightMode) ?? flightModes[0];
  const choices = modelChoices(catalog);
  const idBase = useId();
  // Builder turns run on the thread's selection, which the composer follows. Moving it in the same
  // configure call keeps the builder row and the composer on one model.
  function assign(role: string, selection: ChatModelSelection | null) {
    if (!crew || !selection) return;
    onConfigure({
      crew: {
        ...crew,
        members: crew.members.map((member) =>
          member.role === role ? { ...member, selection } : member,
        ),
      },
      ...(role === 'builder' ? { selection } : {}),
    });
  }
  // The person's choice is saved as set, since a role with no choice takes its family default.
  function allowSubagents(role: string, on: boolean) {
    if (!crew) return;
    onConfigure({
      crew: {
        ...crew,
        members: crew.members.map((member) =>
          member.role === role ? { ...member, allowSubagents: on } : member,
        ),
      },
    });
  }
  // The orchestrator starts on the builder's model, and the row's select changes it. Removing it
  // goes back to one builder turn per message.
  function setOrchestrator(on: boolean) {
    if (!crew) return;
    const builder = crew.members.find((member) => member.role === 'builder');
    if (on && !builder) return;
    const rest = crew.members.filter((member) => member.role !== 'orchestrator');
    onConfigure({
      crew: {
        ...crew,
        members:
          on && builder ? [...rest, { role: 'orchestrator', selection: builder.selection }] : rest,
      },
    });
  }
  function start(name: string) {
    const preset = readCrewPresets().find((value) => value.name === name);
    if (!preset || !thread) return;
    const next = catalog && crewFromPreset(preset, catalog, thread.selection, thread.handoffMode);
    setNote(next ? null : 'Connect a provider in Settings, then start from a preset.');
    if (!next) return;
    const builder = next.members.find((member) => member.role === 'builder')?.selection;
    const moved =
      builder &&
      (builder.family !== thread.selection?.family ||
        builder.model !== thread.selection?.model ||
        builder.effort !== thread.selection?.effort);
    onConfigure({ crew: next, ...(moved ? { selection: builder } : {}) });
  }
  return (
    <div className="th-facts">
      <dl>
        <dt>Crew</dt>
        <dd>{crew?.name ?? 'None yet'}</dd>
        <dt>Chain</dt>
        <dd>{chainLine(thread?.crewChain ?? null)}</dd>
      </dl>
      <ul className="th-crew-roles" aria-label="Roles">
        {ChatCrewRoleSchema.options.map((role) => {
          const member = crew?.members.find((value) => value.role === role);
          // The fixer is the builder again unless the crew names its own.
          const fallback = role === 'fixer' && crew ? 'The builder, with the findings' : null;
          // A role stays read only until the catalog arrives, so its select never shows a gap.
          const editable = member && choices.length > 0;
          return (
            <li key={role}>
              <span className="role-name">
                {editable ? (
                  <label className="th-crew-role" htmlFor={`${idBase}-${role}`}>
                    {crewRoleNames[role]}
                  </label>
                ) : (
                  <span className="th-crew-role">{crewRoleNames[role]}</span>
                )}
                <RoleInfo of={role} />
              </span>
              {editable ? (
                <span className="th-crew-pick">
                  <SelectionFields
                    id={`${idBase}-${role}`}
                    effortLabel={`${crewRoleNames[role]} effort`}
                    choices={choices}
                    value={member.selection}
                    onChange={(selection) => assign(role, selection)}
                  />
                  <SubagentSwitch
                    id={`${idBase}-${role}-subagents`}
                    role={crewRoleNames[role]}
                    family={member.selection.family}
                    checked={allowsSubagents(member, member.selection.family)}
                    onChange={(on) => allowSubagents(role, on)}
                  />
                </span>
              ) : member ? (
                <span className="th-session" title={member.selection.model}>
                  <FamilyMark family={member.selection.family} />
                  <span className="th-crew-model">{modelLine(member.selection, label)}</span>
                </span>
              ) : (
                <span className="th-muted">{fallback ?? 'Not in this crew'}</span>
              )}
              {role === 'orchestrator' && crew && (
                <button
                  type="button"
                  className="th-pill th-outline th-crew-toggle"
                  onClick={() => setOrchestrator(!member)}
                >
                  {member ? 'Remove orchestrator' : 'Add orchestrator'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="th-muted role-name">
        Also in threads: Advisor <RoleInfo of="advisor" /> and Ask <RoleInfo of="ask" />
      </p>
      {crew?.members.some((member) => member.role === 'orchestrator') && (
        <p className="th-muted">
          The orchestrator replaces the single builder turn with a plan of slices. The controller
          assigns each slice to a connected family and shows the plan before it runs.
        </p>
      )}
      <label>
        Start from preset
        <select value="" disabled={!thread} onChange={(event) => start(event.target.value)}>
          <option value="" disabled>
            Choose a preset
          </option>
          {crewPresetNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Flight mode
        <select
          value={mode.id}
          title={mode.title}
          disabled={!thread}
          onChange={(event) => onConfigure({ flightMode: event.target.value as ChatFlightMode })}
        >
          {flightModes.map((item) => (
            <option
              key={item.id}
              value={item.id}
              title={item.title}
              disabled={!crew && item.id !== 'manual'}
            >
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <p className="th-muted">
        {crew ? mode.title : 'Start from a preset to run the crew in Balanced or Glide.'}
      </p>
      <AutoHandoff thread={thread} onConfigure={onConfigure} />
      <ChecksSettings
        thread={thread}
        onEdit={(checks) =>
          thread
            ? configureThread(source, { taskId: thread.taskId, checks }).then(() => {})
            : Promise.resolve()
        }
      />
      {note && (
        <p className="th-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

export function Inspector({
  source,
  taskId,
  title,
  thread,
  turns,
  messages,
  loaded,
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
  turns: readonly ChatTurn[];
  messages: readonly ChatMessage[];
  loaded: boolean;
  header: WorkspaceState | null;
  preview: boolean;
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  onClose: () => void;
  changesKey: number;
  focusPath: string | null;
  onConfigure: (patch: ThreadSettings) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const size = useInspectorWidth(panel);
  const extensionRead = useExtensions(source).read;
  const extensionTabs = slotsOf(extensionRead, 'inspector-tab');
  // An extension tab whose extension turned off falls back to Changes once the read is in.
  const missingTab =
    tab.startsWith('ext:') &&
    extensionRead !== null &&
    !extensionTabs.some((slot) => extensionTabId(slot) === tab);
  useEffect(() => {
    if (missingTab) onTab('changes');
  }, [missingTab, onTab]);
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
          {[
            ...tabs,
            ...extensionTabs.map((slot) => ({ id: extensionTabId(slot), label: slot.title })),
          ].map((item) => (
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
            lastReply={
              messages.findLast(
                ({ author }) => author.kind === 'assistant' && writesScratch(author.role),
              )?.text
            }
          />
        )}
        {tab === 'usage' && <UsageTab source={source} header={header} preview={preview} />}
        {tab === 'analytics' && (
          <AnalyticsView
            source={source}
            input={{ scope: 'thread', taskId }}
            refreshKey={`${turns.length}:${turns.at(-1)?.state ?? ''}`}
          />
        )}
        {tab === 'crew' && <CrewTab source={source} thread={thread} onConfigure={onConfigure} />}
        {tab === 'thread' && (
          <ThreadTab
            taskId={taskId}
            thread={thread}
            turns={turns}
            messages={messages}
            loaded={loaded}
            onConfigure={onConfigure}
          />
        )}
        {extensionTabs
          .filter((slot) => tab === extensionTabId(slot))
          .map((slot) => (
            <ExtensionInspectorTab key={tab} source={source} taskId={taskId} slot={slot} />
          ))}
      </div>
    </aside>
  );
}
