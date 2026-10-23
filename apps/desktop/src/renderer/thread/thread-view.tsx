import type { ChatModelSelection, ChatPermissionPolicy, WorkspaceState } from '@crewkite/contracts';
import { GitBranch, PanelRight } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  configureThread,
  handoffThread,
  resolvePermission,
  sendMessage,
  stopTurn,
  type ThreadSource,
} from './commands.ts';
import { Composer, type SendInput } from './composer.tsx';
import { LimitOfferCard } from './handoff-card.tsx';
import { type LimitOffer, limitOffer } from './handoff-offer.ts';
import { Inspector, type InspectorTab } from './inspector.tsx';
import { MessageList } from './message-list.tsx';
import { lastFamily, latestContext } from './thread-state.ts';
import type { TurnView } from './turn-fold.ts';
import { useThread } from './use-thread.ts';
import './thread.css';

export type ThreadTask = { id: string; title: string };

// A change in the number of edited files or finished turns asks the Changes tab to read again.
function changeCount(items: ReturnType<typeof useThread>['items']) {
  let count = 0;
  for (const item of items)
    if (item.kind === 'turn') {
      if (item.turn.ended) count += 1;
      for (const block of item.turn.blocks) if (block.kind === 'tool' && block.diff) count += 1;
    }
  return count;
}

export function ThreadView({
  source,
  task,
  projectName,
  header,
  preview,
  connection,
}: {
  source: ThreadSource;
  task: ThreadTask;
  projectName: string;
  header: WorkspaceState | null;
  preview: boolean;
  connection: string;
}) {
  const { state, items, dispatch, error, activeTurn, reload, retry } = useThread(
    source,
    task.id,
    connection,
  );
  const [inspector, setInspector] = useState<{
    open: boolean;
    tab: InspectorTab;
    focus: string | null;
  }>({ open: false, tab: 'changes', focus: null });
  const [notice, setNotice] = useState<string | null>(null);
  const counter = useRef(0);
  const thread = state.thread;
  const changesKey = useMemo(() => changeCount(items), [items]);
  const offer = useMemo(() => limitOffer(state), [state]);

  const send = useCallback(
    async ({ text, attachments, selection }: SendInput) => {
      counter.current += 1;
      const localId = `local-${counter.current}`;
      dispatch({
        type: 'sending',
        pending: { localId, text, attachments, at: new Date().toISOString() },
      });
      try {
        await sendMessage(source, {
          taskId: task.id,
          text,
          attachments,
          ...(selection ? { selection } : {}),
        });
        setNotice(null);
      } catch (failure) {
        dispatch({ type: 'dismiss', localId });
        throw failure;
      }
    },
    [source, task.id, dispatch],
  );
  const stop = useCallback(async () => {
    if (activeTurn) await stopTurn(source, { taskId: task.id, turnId: activeTurn });
  }, [source, task.id, activeTurn]);
  const resolve = useCallback(
    (turn: TurnView, requestId: string, choice: string) =>
      resolvePermission(source, { taskId: task.id, turnId: turn.id, requestId, choice }).then(
        () => undefined,
      ),
    [source, task.id],
  );
  const handoff = useCallback(
    async (selection: ChatModelSelection) => {
      await handoffThread(source, { taskId: task.id, selection, reason: 'manual' });
      await reload();
    },
    [source, task.id, reload],
  );
  // Move the thread when it is not on the chosen family yet, then send the stopped message again.
  // Sending hides the card, so a refusal there reaches the person through the composer notice.
  const continueOnLimit = useCallback(
    async (selection: ChatModelSelection, stopped: LimitOffer) => {
      if (thread?.selection?.family !== selection.family)
        await handoffThread(source, { taskId: task.id, selection, reason: 'limit' });
      await send({ text: stopped.text, attachments: stopped.attachments, selection }).catch(
        (failure: unknown) =>
          setNotice(failure instanceof Error ? failure.message : 'The message was not sent.'),
      );
    },
    [source, task.id, thread?.selection?.family, send],
  );
  const configure = useCallback(
    (patch: { permissionPolicy?: ChatPermissionPolicy; autoHandoff?: boolean }) =>
      configureThread(source, { taskId: task.id, ...patch }).then(
        () => {
          dispatch({ type: 'configured', patch });
          setNotice(null);
        },
        (failure: unknown) =>
          setNotice(failure instanceof Error ? failure.message : 'The setting was not saved.'),
      ),
    [source, task.id, dispatch],
  );
  const openChanges = useCallback(
    (path: string) => setInspector({ open: true, tab: 'changes', focus: path }),
    [],
  );

  const badge = thread?.scratchReady
    ? 'Scratch copy'
    : thread?.base
      ? `Base ${thread.base.slice(0, 7)}`
      : 'No edits yet';
  const empty = !state.loaded ? (
    error ? (
      <div className="th-empty" role="alert">
        <p>The thread could not be loaded.</p>
        <p className="th-muted">{error}</p>
        <button type="button" className="th-button" onClick={retry}>
          Try again
        </button>
      </div>
    ) : (
      <div className="th-empty" role="status">
        <p className="th-muted">Opening thread.</p>
      </div>
    )
  ) : (
    <div className="th-empty">
      <p>{projectName}</p>
      <p className="th-muted">Edits happen in a scratch copy. Review them under Changes.</p>
    </div>
  );

  return (
    <div className={inspector.open ? 'thread has-inspector' : 'thread'}>
      <section className="th-main" aria-label="Thread">
        <header className="th-bar">
          <h1 className="th-title" title={task.title}>
            {task.title}
          </h1>
          <span className="th-project">{projectName}</span>
          <span className="th-badge" title={thread?.base ?? 'No base commit yet'}>
            <GitBranch size={11} aria-hidden="true" />
            {badge}
          </span>
          <button
            type="button"
            className="th-icon th-bar-toggle"
            aria-label="Toggle inspector"
            aria-pressed={inspector.open}
            title="Inspector"
            onClick={() => setInspector({ ...inspector, open: !inspector.open })}
          >
            <PanelRight size={16} aria-hidden="true" />
          </button>
        </header>
        <MessageList items={items} empty={empty} onResolve={resolve} onOpenChanges={openChanges} />
        {offer && (
          <LimitOfferCard
            key={offer.turnId}
            source={source}
            taskId={task.id}
            offer={offer}
            onContinue={continueOnLimit}
          />
        )}
        <Composer
          key={task.id}
          source={source}
          taskId={task.id}
          thread={thread}
          running={activeTurn !== null}
          context={latestContext(items)}
          currentFamily={lastFamily(items)}
          blocked={connection === 'connected' ? null : 'Reconnect to the controller to send.'}
          notice={notice}
          onSend={send}
          onStop={stop}
          onConfigured={(selection) => dispatch({ type: 'configured', patch: { selection } })}
          onHandoff={handoff}
        />
      </section>
      {inspector.open && (
        <Inspector
          source={source}
          taskId={task.id}
          thread={thread}
          header={header}
          preview={preview}
          tab={inspector.tab}
          onTab={(tab) => setInspector({ ...inspector, tab })}
          onClose={() => setInspector({ ...inspector, open: false })}
          changesKey={changesKey}
          focusPath={inspector.focus}
          onConfigure={(patch) => void configure(patch)}
        />
      )}
    </div>
  );
}
