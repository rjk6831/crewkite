import type {
  ChatPermissionPolicy,
  ChatRole,
  ChatThread,
  ChatTurn,
  WorkspaceState,
} from '@crewkite/contracts';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { familyName } from '../components.tsx';
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
const policies: { id: ChatPermissionPolicy; label: string }[] = [
  { id: 'ask', label: 'Ask each time' },
  { id: 'allow-edits', label: 'Allow edits' },
  { id: 'allow-all', label: 'Allow all' },
];

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
          {policies.map((policy) => (
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
    <aside className="th-inspector" aria-label="Inspector">
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
