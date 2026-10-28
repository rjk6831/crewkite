import type { ChatCatalogRead, ChatModelSelection, WorkspaceState } from '@crewkite/contracts';
import { GitBranch, PanelRight } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { familyName } from '../components.tsx';
import { OutputLimitControl, RerunControl, TryWith } from './cards.tsx';
import {
  cancelPlan,
  configureThread,
  handoffThread,
  resolvePermission,
  retryTurn,
  runPlan,
  sendMessage,
  steerMessage,
  stopTurn,
  type ThreadSource,
} from './commands.ts';
import { Composer, type ComposerHandle, type SendInput } from './composer.tsx';
import { EmptyThread } from './empty-thread.tsx';
import { FamilyMark } from './family-mark.tsx';
import { tryWithChoices } from './file-fit.ts';
import { LimitOfferCard } from './handoff-card.tsx';
import { limitOffer } from './handoff-offer.ts';
import { Inspector, type InspectorTab } from './inspector.tsx';
import { MessageList, modelLine } from './message-list.tsx';
import { outputLimitLine } from './output-limit.ts';
import { PlanCard } from './plan-card.tsx';
import { QueuedList } from './queued-list.tsx';
import {
  announcements,
  type LiveSignals,
  lastFamily,
  lastReply,
  lastUserMessage,
  latestContext,
  liveSignals,
  newestTurnId,
  type ThreadItem,
  type ThreadSettings,
  triedFamilies,
  turnFiles,
} from './thread-state.ts';
import { ThreadTitle } from './thread-title.tsx';
import type { TurnView } from './turn-fold.ts';
import { useThread } from './use-thread.ts';
import './thread.css';

export type ThreadTask = { id: string; title: string };

// Grey lines where the conversation will be while the thread opens. A read that is only slow
// never shows a failure; use-thread reports one after ten seconds of retries.
export function OpeningThread() {
  return (
    <div className="th-skeleton" role="status" aria-label="Opening thread">
      <i />
      <i />
      <i />
    </div>
  );
}

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
  refresh,
  onNewThread,
  onOpenSettings,
}: {
  source: ThreadSource;
  task: ThreadTask;
  projectName: string;
  header: WorkspaceState | null;
  preview: boolean;
  connection: string;
  refresh?: () => Promise<WorkspaceState>;
  onNewThread?: () => void;
  onOpenSettings?: () => void;
}) {
  const {
    state,
    items,
    dispatch,
    error,
    activeTurn,
    wantsHistory,
    loadHistory,
    hasEarlier,
    loadEarlier,
    earlierNote,
    reload,
    retry,
  } = useThread(source, task.id, connection);
  const [catalog, setCatalog] = useState<ChatCatalogRead | null>(null);
  const [inspector, setInspector] = useState<{
    open: boolean;
    tab: InspectorTab;
    focus: string | null;
  }>({ open: false, tab: 'changes', focus: null });
  const [notice, setNotice] = useState<string | null>(null);
  const counter = useRef(0);
  const composer = useRef<ComposerHandle>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const thread = state.thread;
  const changesKey = useMemo(() => changeCount(items), [items]);
  const turns = useMemo(() => Object.values(state.turnMeta), [state.turnMeta]);
  const offer = useMemo(() => limitOffer(state), [state]);

  // One polite live region says a reply finished or a permission request arrived. The first view
  // of a thread is the baseline and says nothing.
  const signals = useMemo(() => liveSignals(items), [items]);
  const seen = useRef<LiveSignals | null>(null);
  const [said, setSaid] = useState({ count: 0, text: '' });
  useEffect(() => {
    if (!state.loaded) return;
    const lines = announcements(seen.current, signals);
    seen.current = signals;
    if (lines.length > 0)
      setSaid((previous) => ({ count: previous.count + 1, text: lines.join(' ') }));
  }, [state.loaded, signals]);
  const lastMessage = useMemo(() => lastUserMessage(state), [state]);

  const queued = thread?.queued;
  // The controller queues a message while the thread is busy. The queued list shows that one, so
  // the pending bubble is only for a message that starts now.
  const waits = activeTurn !== null || !!queued?.length || !!thread?.ownershipUnknown;
  const send = useCallback(
    async ({ text, files: added, selection }: SendInput) => {
      counter.current += 1;
      const localId = `local-${counter.current}`;
      // The composer stores each file under the thread as it is added.
      const files = added.flatMap((item) => (item.file ? [item.file] : []));
      if (!waits)
        dispatch({
          type: 'sending',
          pending: { localId, text, files, at: new Date().toISOString() },
        });
      try {
        await sendMessage(source, {
          taskId: task.id,
          text,
          files,
          ...(selection ? { selection } : {}),
        });
        setNotice(null);
      } catch (failure) {
        dispatch({ type: 'dismiss', localId });
        throw failure;
      }
    },
    [source, task.id, dispatch, waits],
  );
  // Stop clears the queue, and the texts the controller took out go back into an empty composer.
  const stop = useCallback(async () => {
    if (!activeTurn) return;
    const result = await stopTurn(source, { taskId: task.id, turnId: activeTurn });
    const cleared = result.data?.kind === 'chat-queue' ? result.data.messages : [];
    if (cleared.length)
      composer.current?.restore(
        cleared.map((item) => item.text).join('\n\n'),
        cleared.flatMap((item) => item.files),
      );
    // The text and files come back as one plain message. A queued action has to be chosen again.
    if (cleared.some((item) => item.role !== 'assistant' || item.attachments.length))
      setNotice('The queued text is back in the composer. Pick the action or attachments again.');
  }, [source, task.id, activeTurn]);
  // The controller stops the reply and starts this message with what the stopped turn was doing.
  const sendNow = useCallback(
    (id: string) =>
      steerMessage(source, { taskId: task.id, messageId: id }).then(
        () => setNotice(null),
        (failure: unknown) =>
          setNotice(failure instanceof Error ? failure.message : 'The message was not sent.'),
      ),
    [source, task.id],
  );
  const dequeue = useCallback(
    (id: string) =>
      configureThread(source, { taskId: task.id, dequeue: id }).then(
        () => setNotice(null),
        (failure: unknown) =>
          setNotice(failure instanceof Error ? failure.message : 'The message was not removed.'),
      ),
    [source, task.id],
  );
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
  // The controller can change more than the patch, such as automatic handoff on entering Glide.
  // Its chat.thread event brings the whole record; the patch shows at once until then.
  const configure = useCallback(
    (patch: ThreadSettings) =>
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
  // Retry and Regenerate run the message that started the turn again, on the model the menu shows.
  const rerun = useCallback(
    async (
      turnId: string,
      mode: 'retry' | 'regenerate' | 'continue',
      selection: ChatModelSelection | null,
    ) => {
      await retryTurn(source, {
        taskId: task.id,
        turnId,
        mode,
        ...(selection ? { selection } : {}),
      });
      setNotice(null);
    },
    [source, task.id],
  );
  // The plan card reads thread.plan. Each button is one command, and the controller answers with
  // the plan's new state on its chat.thread event.
  const plan = thread?.plan ?? null;
  const planned = plan && thread && (
    <PlanCard
      plan={plan}
      flight={thread.flightMode}
      onRun={async (input) => {
        await runPlan(source, { taskId: task.id, planId: plan.planId, ...input });
        setNotice(null);
      }}
      onCancel={async () => {
        await cancelPlan(source, { taskId: task.id, planId: plan.planId });
        setNotice(null);
      }}
      onStop={async () => {
        if (activeTurn) await stop();
        else await cancelPlan(source, { taskId: task.id, planId: plan.planId });
      }}
    />
  );
  const replyId = useMemo(
    () => (activeTurn ? null : lastReply(state, items)),
    [activeTurn, state, items],
  );
  const newestId = useMemo(() => newestTurnId(state), [state]);
  const current = thread?.selection ?? null;
  // The line is shown here unless the controller wrote the same line into the thread.
  const limitLine = (limit: Parameters<typeof outputLimitLine>[0]) => {
    const line = outputLimitLine(limit);
    return state.messages.some((message) => message.text === line) ? null : line;
  };
  const actions = (item: ThreadItem): ReactNode => {
    if (item.kind !== 'turn' && item.kind !== 'failure') return null;
    const turnId = item.kind === 'turn' ? item.turn.id : item.turnId;
    const note = item.kind === 'turn' ? state.historyNotes[turnId] : undefined;
    // The controller reruns only the newest turn, so an older failure offers nothing to run.
    const newest = turnId === newestId;
    const retryable = newest && (item.kind === 'failure' || item.turn.status === 'stopped');
    const regenerate = item.kind === 'turn' && turnId === replyId;
    const rejected =
      newest && item.kind === 'failure' && item.failure.kind === 'attachment-rejected';
    const limit = item.kind === 'turn' && newest && item.turn.ended ? item.turn.outputLimit : null;
    if (!note && !retryable && !regenerate && !limit) return null;
    const choices =
      rejected && catalog
        ? tryWithChoices(
            catalog,
            triedFamilies(state, turnId),
            turnFiles(state, turnId).map((file) => file.mimeType),
            thread?.handoffMode,
          )
        : [];
    return (
      <div className="th-row th-turn-actions">
        {note && <p className="th-muted">{note}</p>}
        {(retryable || regenerate) && !activeTurn && (
          <RerunControl
            label={regenerate ? 'Regenerate' : 'Retry'}
            catalog={catalog}
            current={current}
            onRun={(selection) => rerun(turnId, regenerate ? 'regenerate' : 'retry', selection)}
          />
        )}
        {limit && !activeTurn && (
          <OutputLimitControl
            line={limitLine(limit)}
            onContinue={() => rerun(turnId, 'continue', null)}
          />
        )}
        {rejected && !activeTurn && (
          <TryWith choices={choices} onRun={(selection) => rerun(turnId, 'retry', selection)} />
        )}
      </div>
    );
  };
  // Focus inside the panel moves to the toolbar button first, so closing does not drop it.
  const closeInspector = useCallback(() => {
    if (document.activeElement?.closest('.th-inspector')) toggle.current?.focus();
    setInspector((current) => ({ ...current, open: false }));
  }, []);
  const openChanges = useCallback(
    (path: string) => setInspector({ open: true, tab: 'changes', focus: path }),
    [],
  );

  // A running turn is the usual reason to wait. These two hold the queue after a turn has ended.
  const held = thread?.ownershipUnknown
    ? 'Waiting for a provider process from an earlier turn to exit. Quit it, then send another message.'
    : offer
      ? 'Waiting for a provider. Continue on another one above, or send another message.'
      : null;
  const badge = thread?.scratchReady
    ? 'Scratch copy'
    : thread?.base
      ? `Base ${thread.base.slice(0, 7)}`
      : 'No edits yet';
  // The read retries for ten seconds before it reports a failure, so a slow controller shows the
  // skeleton and nothing else.
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
      <OpeningThread />
    )
  ) : (
    <EmptyThread onPick={(text) => composer.current?.fill(text)} />
  );

  return (
    <div className={inspector.open ? 'thread has-inspector' : 'thread'}>
      <section className="th-main" aria-label="Thread">
        <header className="th-bar">
          {thread?.selection && (
            <span className="th-bar-family" title={modelLine(thread.selection)}>
              <FamilyMark family={thread.selection.family} />
              <span className="th-sr">{familyName(thread.selection.family)}</span>
            </span>
          )}
          <ThreadTitle source={source} task={task} />
          <span className="th-project">{projectName}</span>
          <span className="th-badge" title={thread?.base ?? 'No base commit yet'}>
            <GitBranch size={11} aria-hidden="true" />
            {badge}
          </span>
          <button
            ref={toggle}
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
        <MessageList
          items={items}
          empty={empty}
          footer={
            (planned || offer) && (
              <>
                {planned}
                {offer && (
                  <LimitOfferCard
                    key={offer.turnId}
                    source={source}
                    taskId={task.id}
                    offer={offer}
                  />
                )}
              </>
            )
          }
          actions={actions}
          wantsHistory={wantsHistory}
          onTurnVisible={loadHistory}
          taskId={task.id}
          earlier={hasEarlier ? { onLoad: loadEarlier, note: earlierNote } : null}
          onResolve={resolve}
          onOpenChanges={openChanges}
        />
        <QueuedList
          queued={queued ?? []}
          held={held}
          running={activeTurn !== null}
          onRemove={dequeue}
          onSendNow={sendNow}
        />
        <Composer
          ref={composer}
          key={task.id}
          source={source}
          taskId={task.id}
          thread={thread}
          running={activeTurn !== null}
          context={latestContext(items)}
          currentFamily={lastFamily(state, items)}
          blocked={connection === 'connected' ? null : 'Reconnect to the controller to send.'}
          notice={notice}
          onSend={send}
          onStop={stop}
          onConfigured={(selection) => dispatch({ type: 'configured', patch: { selection } })}
          onHandoff={handoff}
          onOpenCrew={() => setInspector({ open: true, tab: 'crew', focus: null })}
          onCatalog={setCatalog}
          localState={refresh ? { setup: header?.localSetup, refresh } : undefined}
          lastMessage={lastMessage}
          onNewThread={onNewThread}
          onOpenSettings={onOpenSettings}
          onOpenChanges={() => setInspector({ open: true, tab: 'changes', focus: null })}
        />
        {/* A zero-width mark on alternate lines lets the same sentence be read twice in a row. */}
        <p className="th-sr" role="status" aria-live="polite" aria-atomic="true">
          {said.text}
          {said.count % 2 === 0 ? '' : '\u200b'}
        </p>
      </section>
      {inspector.open && (
        <Inspector
          source={source}
          taskId={task.id}
          title={task.title}
          thread={thread}
          turns={turns}
          messages={state.messages}
          loaded={state.loaded}
          header={header}
          preview={preview}
          tab={inspector.tab}
          onTab={(tab) => setInspector({ ...inspector, tab })}
          onClose={closeInspector}
          changesKey={changesKey}
          focusPath={inspector.focus}
          onConfigure={(patch) => void configure(patch)}
        />
      )}
    </div>
  );
}
