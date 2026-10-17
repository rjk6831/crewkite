import {
  CommandIdSchema,
  type CommandResult,
  type ConversationContextBundle,
  type ConversationContextRef,
  ConversationContextRefsSchema,
  type ConversationEntry,
  type ConversationPlanningSelection,
  ConversationPlanningSelectionSchema,
  canonicalJson,
  HashSchema,
  ProjectIdSchema,
  RevisionSchema,
  type Snapshot,
  type Task,
  type TaskConversationState,
  TaskIdSchema,
} from '@crewkite/contracts';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Dialog, familyName, titleCase } from './components.tsx';
import { Conversation, type ConversationMessage } from './conversation.tsx';
import { ConversationContextCaptureError, type DesktopCommand, type Workspace } from './source.ts';
import { roleLabels } from './templates.ts';

const applied = (outcome: string) => outcome === 'applied' || outcome === 'already-applied';
const reasonText = (reason: string) => `${titleCase(reason.replaceAll('-', ' '))}.`;
const mergeEntries = (current: ConversationEntry[], incoming: ConversationEntry[]) => {
  const entries = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    const prior = entries.get(entry.id);
    if (!prior || prior.revision <= entry.revision) entries.set(entry.id, entry);
  }
  return [...entries.values()].sort((a, b) => (BigInt(a.cursor) < BigInt(b.cursor) ? -1 : 1));
};

function useConversation(task: Task, workspace: Workspace, visible: boolean) {
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [state, setState] = useState<TaskConversationState | null>(null);
  const [before, setBefore] = useState<string | null | undefined>(undefined);
  const [reading, setReading] = useState(false);
  const [earlier, setEarlier] = useState(false);
  const [error, setError] = useState<string>();
  const [historyNotice, setHistoryNotice] = useState<string>();
  const latestPage = useRef<ConversationEntry[]>([]);
  const [questionToFocus, setQuestionToFocus] = useState<string | null>(null);
  const request = useRef(false);
  const active = useRef(true);
  const lastRead = useRef('');
  const knownEntries = useRef(entries);
  knownEntries.current = entries;
  const eventCursor = workspace.events.findLast(
    (event) => event.taskId === task.id && event.type === 'conversation.entry',
  )?.cursor;
  const trigger = `${task.id}:${task.revision}:${workspace.connection}:${eventCursor}:${workspace.historyGap}`;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const read = useCallback(
    async (beforeCursor?: string) => {
      if (request.current || workspace.pending || workspace.connection !== 'connected') return;
      request.current = true;
      setReading(true);
      setEarlier(Boolean(beforeCursor));
      setError(undefined);
      try {
        if (!beforeCursor) {
          const result = await workspace.command({
            command: 'GetTaskConversationState',
            payload: { taskId: task.id },
          });
          if (
            !applied(result.outcome) ||
            result.data?.kind !== 'conversation-state' ||
            result.data.state.taskId !== task.id
          )
            throw new Error(result.reason ?? 'Conversation state is unavailable.');
          if (!active.current) return;
          setState(result.data.state);
        }
        const result = await workspace.command({
          command: 'GetTaskConversation',
          payload: { taskId: task.id, ...(beforeCursor ? { beforeCursor } : {}) },
        });
        if (
          !applied(result.outcome) ||
          result.data?.kind !== 'conversation' ||
          result.data.taskId !== task.id
        )
          throw new Error(result.reason ?? 'Conversation history is unavailable.');
        if (!active.current) return;
        const page = result.data;
        const disjoint =
          !beforeCursor &&
          latestPage.current.length > 0 &&
          page.entries.length > 0 &&
          !page.entries.some((entry) => latestPage.current.some((prior) => prior.id === entry.id));
        if (disjoint) {
          setEntries(page.entries);
          setBefore(page.nextBeforeCursor);
          setHistoryNotice(
            'Newer saved messages were loaded. Load earlier messages to restore the previous history.',
          );
        } else {
          setEntries((current) => mergeEntries(current, page.entries));
          setBefore((current) =>
            beforeCursor || current === undefined ? page.nextBeforeCursor : current,
          );
        }
        if (!beforeCursor) latestPage.current = page.entries;
        else if (!page.nextBeforeCursor) setHistoryNotice(undefined);
      } catch (failure) {
        if (active.current)
          setError(failure instanceof Error ? failure.message : 'Conversation read failed.');
      } finally {
        request.current = false;
        if (active.current) {
          setReading(false);
          setEarlier(false);
        }
      }
    },
    [task.id, workspace.command, workspace.connection, workspace.pending],
  );
  useEffect(() => {
    if (
      workspace.connection !== 'connected' ||
      workspace.pending ||
      reading ||
      request.current ||
      lastRead.current === trigger
    )
      return;
    lastRead.current = trigger;
    void read();
  }, [read, trigger, workspace.connection, workspace.pending, reading]);
  useEffect(() => {
    if (!visible) {
      setQuestionToFocus(null);
      return;
    }
    if (!questionToFocus || !entries.some((entry) => entry.id === questionToFocus)) return;
    document.getElementById(`conversation-message-${questionToFocus}`)?.focus();
    setQuestionToFocus(null);
  }, [entries, questionToFocus, visible]);
  const loadQuestion = async (id: string, cursor: string) => {
    setQuestionToFocus(id);
    if (knownEntries.current.some((entry) => entry.id === id)) {
      document.getElementById(`conversation-message-${id}`)?.focus();
      return;
    }
    if (request.current || workspace.pending) return;
    request.current = true;
    setReading(true);
    try {
      const result = await workspace.command({
        command: 'GetTaskConversation',
        payload: { taskId: task.id, beforeCursor: (BigInt(cursor) + 1n).toString() },
      });
      if (
        !applied(result.outcome) ||
        result.data?.kind !== 'conversation' ||
        result.data.taskId !== task.id
      )
        throw new Error(result.reason ?? 'The pending question is unavailable.');
      const question = result.data.entries.find(
        (entry) => entry.id === id && entry.kind === 'question',
      );
      if (!question)
        throw new Error('The saved question is unavailable. Refresh the conversation.');
      if (active.current) setEntries((current) => mergeEntries(current, [question]));
    } catch (failure) {
      if (active.current)
        setError(failure instanceof Error ? failure.message : 'Question read failed.');
    } finally {
      request.current = false;
      if (active.current) {
        setReading(false);
      }
    }
  };
  return {
    entries,
    state,
    before,
    reading,
    earlier,
    error,
    historyNotice,
    loadEarlier: () => before && void read(before),
    loadQuestion,
    refresh: () => {
      lastRead.current = '';
      void read();
    },
  };
}

type CapturedContext = { ref: ConversationContextRef; bundle: ConversationContextBundle };
type ContextCaptureReceipt = { receiptId: string; projectId: string; base: string };
type ContextFact = { hash: string; files: number; bytes: number };
type ContextDraft = {
  refs: ConversationContextRef[];
  facts?: Record<string, ContextFact>;
  priorSend: boolean;
  captureReceipt?: ContextCaptureReceipt;
};
type ContextSendCommand = Extract<
  DesktopCommand,
  { command: 'CreateTaskDiscussion' | 'SendTaskMessage' | 'QueueTaskGuidance' }
>;
const contextSendReceipts = new Map<
  string,
  { command: ContextSendCommand; submitted: string; refs: ConversationContextRef[] }
>();
function captureReceipt(value: unknown): ContextCaptureReceipt | undefined {
  if (!value || typeof value !== 'object') return;
  const receiptId = 'receiptId' in value ? CommandIdSchema.safeParse(value.receiptId) : undefined;
  const projectId = 'projectId' in value ? ProjectIdSchema.safeParse(value.projectId) : undefined;
  const base = 'base' in value && value.base;
  if (
    receiptId?.success &&
    projectId?.success &&
    typeof base === 'string' &&
    /^[a-f0-9]{40}$/.test(base)
  )
    return { receiptId: receiptId.data, projectId: projectId.data, base };
}
const emptyContextDraft: ContextDraft = { refs: [], priorSend: false };
const contextDraftKey = 'crewkite-context-drafts-v1';
let contextDraftStore: { drafts: Record<string, ContextDraft>; error?: string } | undefined;
const contextDraftListeners = new Set<() => void>();
function readContextDrafts() {
  if (contextDraftStore) return contextDraftStore;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(contextDraftKey) ?? '{}');
    const drafts: Record<string, ContextDraft> = {};
    if (!stored || typeof stored !== 'object' || Array.isArray(stored))
      throw new Error('Invalid saved context drafts.');
    const entries = Object.entries(stored);
    if (entries.length > 2000) throw new Error('Too many saved context drafts.');
    for (const [key, value] of entries) {
      const validKey = key.startsWith('goal:')
        ? ProjectIdSchema.safeParse(key.slice(5)).success
        : key.startsWith('task:') && TaskIdSchema.safeParse(key.slice(5)).success;
      if (!validKey || !value || typeof value !== 'object') continue;
      const refs =
        'refs' in value ? ConversationContextRefsSchema.safeParse(value.refs) : undefined;
      if (!refs?.success) continue;
      const facts: Record<string, ContextFact> = {};
      if ('facts' in value && value.facts && typeof value.facts === 'object') {
        for (const ref of refs.data) {
          const fact = Object.getOwnPropertyDescriptor(value.facts, ref.artifactId)?.value;
          if (!fact || typeof fact !== 'object') continue;
          const hash = HashSchema.safeParse(fact.hash);
          const files = RevisionSchema.min(1).max(32).safeParse(fact.files);
          const bytes = RevisionSchema.min(1).max(32768).safeParse(fact.bytes);
          if (hash.success && hash.data === ref.hash && files.success && bytes.success)
            facts[ref.artifactId] = { hash: hash.data, files: files.data, bytes: bytes.data };
        }
      }
      drafts[key] = {
        refs: refs.data,
        facts,
        priorSend: 'priorSend' in value && value.priorSend === true,
        captureReceipt:
          'captureReceipt' in value ? captureReceipt(value.captureReceipt) : undefined,
      };
    }
    contextDraftStore = { drafts };
  } catch {
    contextDraftStore = {
      drafts: {},
      error: 'Saved context could not be read. New context stays in this window.',
    };
  }
  return contextDraftStore;
}
function writeContextDraft(key: string, update: (draft: ContextDraft) => ContextDraft) {
  const current = readContextDrafts();
  const updated = update(current.drafts[key] ?? emptyContextDraft);
  const next = {
    ...updated,
    facts: Object.fromEntries(
      updated.refs.flatMap((ref) => {
        const fact = updated.facts?.[ref.artifactId];
        return fact?.hash === ref.hash ? [[ref.artifactId, fact] as const] : [];
      }),
    ),
  };
  const drafts = { ...current.drafts, [key]: next };
  if (!next.refs.length && !next.priorSend && !next.captureReceipt) delete drafts[key];
  if (Object.keys(drafts).length > 2000)
    throw new Error('The saved context draft limit was reached.');
  let error = current.error;
  try {
    if (!current.error) localStorage.setItem(contextDraftKey, JSON.stringify(drafts));
  } catch {
    error = 'Context stays in this window because saved drafts could not be written.';
  }
  contextDraftStore = { drafts, error };
  for (const listener of contextDraftListeners) listener();
}
const subscribeContextDrafts = (listener: () => void) => {
  contextDraftListeners.add(listener);
  return () => {
    contextDraftListeners.delete(listener);
  };
};
const contextBytes = (capture: CapturedContext) =>
  new TextEncoder().encode(canonicalJson(capture.bundle)).length;
const sameContext = (left: ConversationContextRef[], right: ConversationContextRef[]) =>
  canonicalJson(left) === canonicalJson(right);
type ContextRecipient = { summary: string; details?: string };
function ContextPreview({
  captures,
  recipient,
  text,
  blocked,
  onClose,
  onSend,
  recovery,
}: {
  captures: CapturedContext[];
  recipient?: ContextRecipient;
  text?: string;
  blocked?: string;
  onClose: () => void;
  onSend?: () => void;
  recovery?: ReactNode;
}) {
  return (
    <Dialog
      title={onSend ? 'Review message and context' : 'Captured context'}
      onClose={onClose}
      wide
    >
      <div className="launch-content" style={{ maxHeight: '55vh', overflowY: 'auto' }}>
        {recipient && (
          <p>
            <strong>Selected planning recipient</strong>
            <br />
            {recipient.summary}
          </p>
        )}
        {text && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</pre>}
        {captures.map((capture) => (
          <section key={capture.ref.artifactId}>
            <p className="muted small">
              {capture.bundle.files.length} {capture.bundle.files.length === 1 ? 'file' : 'files'} ·{' '}
              {contextBytes(capture).toLocaleString()} bytes
            </p>
            {capture.bundle.files.map((file) => (
              <section key={file.path}>
                <p>
                  <code>{file.path}</code> · {file.kind} · {file.bytes.toLocaleString()} bytes
                </p>
                <pre
                  style={{
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    maxHeight: 180,
                    overflowY: 'auto',
                  }}
                >
                  {file.text}
                </pre>
              </section>
            ))}
          </section>
        ))}
        <details>
          <summary>Details</summary>
          {recipient?.details && <p className="muted small">{recipient.details}</p>}
          {captures.map((capture, index) => (
            <p key={capture.ref.artifactId} className="muted small">
              Context {index + 1}
              <br />
              Base <code>{capture.bundle.base}</code>
              <br />
              Capture <code>{capture.ref.hash}</code>
            </p>
          ))}
        </details>
        {onSend && (
          <p className="muted small">
            This sends the shown files with your message. It grants no extra execution permission.
          </p>
        )}
        {blocked && (
          <p className="notice" role="alert">
            {blocked}
          </p>
        )}
        {recovery}
      </div>
      {onSend && (
        <div className="dialog-footer">
          <button
            className="button primary"
            type="button"
            disabled={Boolean(blocked)}
            onClick={onSend}
          >
            Send reviewed message
          </button>
        </div>
      )}
    </Dialog>
  );
}

function withContext(
  command: ContextSendCommand,
  refs: ConversationContextRef[],
): ContextSendCommand {
  if (!refs.length) return command;
  switch (command.command) {
    case 'CreateTaskDiscussion':
      return { ...command, payload: { ...command.payload, context: refs } };
    case 'SendTaskMessage':
      return { ...command, payload: { ...command.payload, context: refs } };
    case 'QueueTaskGuidance':
      return { ...command, payload: { ...command.payload, context: refs } };
  }
}
function useContextComposer({
  draftKey,
  projectId,
  sourceBase,
  scope,
  recipient,
  workspace,
  afterApplied,
}: {
  draftKey: string;
  projectId: string;
  sourceBase?: string;
  scope: string;
  recipient: ContextRecipient;
  workspace: Workspace;
  afterApplied: (result: CommandResult, submitted: string) => void;
}) {
  const saved = useSyncExternalStore(subscribeContextDrafts, readContextDrafts);
  const draft = saved.drafts[draftKey] ?? emptyContextDraft;
  const [cache, setCache] = useState<Record<string, CapturedContext>>({});
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const reads = useRef(new Map<string, Promise<CapturedContext>>());
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string>();
  const [panel, setPanel] = useState<
    | { kind: 'choose' }
    | { kind: 'reading' }
    | {
        kind: 'preview';
        captures: CapturedContext[];
        scope: string;
        recipient?: ContextRecipient;
        command?: ContextSendCommand;
        submitted?: string;
      }
    | null
  >(null);
  const latest = useRef({ draftKey, projectId, scope, workspace, afterApplied });
  latest.current = { draftKey, projectId, scope, workspace, afterApplied };
  const refSignature = canonicalJson(draft.refs);
  const panelScope = `${scope}:${refSignature}`;
  const currentPanelScope = useRef(panelScope);
  currentPanelScope.current = panelScope;
  const message = (failure: unknown) =>
    failure instanceof Error ? failure.message : 'Context could not be prepared.';
  const readCapture = useCallback(
    async (ref: ConversationContextRef) => {
      const existing = cacheRef.current[ref.artifactId];
      if (existing && existing.ref.hash === ref.hash) {
        if (existing.bundle.projectId !== projectId)
          throw new Error('The captured context belongs to another project.');
        return existing;
      }
      const identity = `${ref.artifactId}:${ref.hash}`;
      const pending = reads.current.get(identity);
      if (pending)
        return pending.then((capture) => {
          if (capture.bundle.projectId !== projectId)
            throw new Error('The captured context belongs to another project.');
          return capture;
        });
      const expectedProject = projectId;
      const reading = latest.current.workspace
        .resolveConversationContext(ref)
        .then((capture) => {
          if (
            capture.ref.artifactId !== ref.artifactId ||
            capture.ref.hash !== ref.hash ||
            capture.bundle.projectId !== expectedProject
          )
            throw new Error('The captured context does not belong to this project.');
          setCache((current) =>
            Object.fromEntries([...Object.entries(current), [ref.artifactId, capture]].slice(-8)),
          );
          const currentDraft = readContextDrafts().drafts[latest.current.draftKey];
          if (
            latest.current.projectId === expectedProject &&
            currentDraft?.refs.some(
              (value) => value.artifactId === ref.artifactId && value.hash === ref.hash,
            )
          )
            writeContextDraft(latest.current.draftKey, (current) => ({
              ...current,
              facts: {
                ...current.facts,
                [ref.artifactId]: {
                  hash: ref.hash,
                  files: capture.bundle.files.length,
                  bytes: contextBytes(capture),
                },
              },
            }));
          return capture;
        })
        .finally(() => {
          reads.current.delete(identity);
        });
      reads.current.set(identity, reading);
      return reading;
    },
    [projectId],
  );
  function finish(result: CommandResult, submitted: string, refs: ConversationContextRef[]) {
    contextSendReceipts.delete(draftKey);
    writeContextDraft(draftKey, (current) => ({
      ...current,
      refs: sameContext(current.refs, refs) ? [] : current.refs,
      priorSend: false,
    }));
    afterApplied(result, submitted);
  }
  async function dispatch(command: ContextSendCommand, submitted: string, retry = false) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setSending(true);
    setError(undefined);
    const refs = 'context' in command.payload ? (command.payload.context ?? []) : [];
    const receipt = { command, submitted, refs };
    contextSendReceipts.set(draftKey, receipt);
    try {
      writeContextDraft(draftKey, (current) => ({ ...current, priorSend: true }));
      const result = retry
        ? await workspace.retryCommand(command)
        : await workspace.command(command);
      if (result && applied(result.outcome)) {
        finish(result, submitted, refs);
        if (latest.current.draftKey === draftKey) setPanel(null);
      } else if (!result || result.outcome === 'outcome-unknown') {
        setError('The send outcome is unknown. Retry this exact send before changing the message.');
      } else {
        contextSendReceipts.delete(draftKey);
        writeContextDraft(draftKey, (current) => ({ ...current, priorSend: false }));
        setError([result.reason ?? result.outcome, result.next].filter(Boolean).join(' '));
      }
    } catch (failure) {
      setError(
        `${message(failure)} The draft and context have been kept. A prior send may have been saved.`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
      setSending(false);
    }
  }
  async function review(command: ContextSendCommand, submitted: string) {
    if (busyRef.current || draft.priorSend || workspace.pending || workspace.retryAvailable) return;
    const frozenRefs = draft.refs.map((ref) => ({ ...ref }));
    const frozenCommand = withContext(command, frozenRefs);
    if (!frozenRefs.length) return dispatch(frozenCommand, submitted);
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    setPanel({ kind: 'reading' });
    const expectedScope = panelScope;
    try {
      const captures: CapturedContext[] = [];
      for (const ref of frozenRefs) {
        const capture = await readCapture(ref);
        if (sourceBase && capture.bundle.base !== sourceBase)
          throw new Error(
            'Captured context uses an earlier source base. Remove it and capture again.',
          );
        captures.push(capture);
      }
      if (captures.some((capture) => capture.bundle.base !== captures[0]?.bundle.base))
        throw new Error(
          'Captured context uses different source bases. Remove it and capture again.',
        );
      if (latest.current.draftKey === draftKey)
        setPanel({
          kind: 'preview',
          captures,
          scope: expectedScope,
          recipient,
          command: frozenCommand,
          submitted,
        });
    } catch (failure) {
      if (latest.current.draftKey === draftKey) {
        setPanel({ kind: 'choose' });
        setError(message(failure));
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function preview(ref: ConversationContextRef, history = false) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    setPanel({ kind: 'reading' });
    try {
      const capture = await readCapture(ref);
      if (latest.current.draftKey === draftKey)
        setPanel({
          kind: 'preview',
          captures: [capture],
          scope: panelScope,
          recipient: history ? undefined : recipient,
        });
    } catch (failure) {
      setPanel({ kind: 'choose' });
      setError(message(failure));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function add(
    mode: 'source-file' | 'source-folder' | 'log-file',
    retryReceipt?: ContextCaptureReceipt,
  ) {
    if (
      busyRef.current ||
      workspace.pending ||
      draft.priorSend ||
      (!retryReceipt && workspace.retryAvailable)
    )
      return;
    if (draft.refs.length >= 4) {
      setError('Keep at most four captured context items in one draft.');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      let capture: CapturedContext | null;
      if (retryReceipt) {
        if (retryReceipt.projectId !== projectId)
          throw new Error('The capture receipt belongs to another project.');
        capture = await workspace.retryConversationContext(retryReceipt);
      } else {
        let base = sourceBase;
        if (!base) {
          const inspection = await workspace.command({
            command: 'InspectSource',
            payload: { projectId },
          });
          if (
            !applied(inspection.outcome) ||
            inspection.data?.kind !== 'source' ||
            inspection.data.source.projectId !== projectId
          )
            throw new Error(inspection.reason ?? 'The committed source is unavailable.');
          base = inspection.data.source.base;
        }
        if (!/^[a-f0-9]{40}$/.test(base))
          throw new Error('Context capture needs a supported committed source base.');
        capture = await workspace.pickConversationContext({ projectId, base, mode });
      }
      if (!capture) return;
      if (capture.bundle.projectId !== projectId)
        throw new Error('The capture belongs to another project.');
      writeContextDraft(draftKey, (current) => {
        if (
          current.refs.some(
            (ref) => ref.artifactId === capture.ref.artifactId || ref.hash === capture.ref.hash,
          )
        )
          return {
            ...current,
            captureReceipt: undefined,
            facts: {
              ...current.facts,
              [capture.ref.artifactId]: {
                hash: capture.ref.hash,
                files: capture.bundle.files.length,
                bytes: contextBytes(capture),
              },
            },
          };
        const refs = ConversationContextRefsSchema.parse([...current.refs, capture.ref]);
        return {
          ...current,
          refs,
          captureReceipt: undefined,
          facts: {
            ...current.facts,
            [capture.ref.artifactId]: {
              hash: capture.ref.hash,
              files: capture.bundle.files.length,
              bytes: contextBytes(capture),
            },
          },
        };
      });
      setCache((current) => ({ ...current, [capture.ref.artifactId]: capture }));
      if (latest.current.draftKey === draftKey)
        setPanel({ kind: 'preview', captures: [capture], scope: panelScope, recipient });
    } catch (failure) {
      if (failure instanceof ConversationContextCaptureError) {
        const receipt = captureReceipt(failure.receipt);
        if (receipt?.projectId === projectId)
          writeContextDraft(draftKey, (current) => ({ ...current, captureReceipt: receipt }));
      }
      if (latest.current.draftKey === draftKey) setError(message(failure));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const uncertain = draft.priorSend
    ? 'A prior send may have been saved. Resolve its exact retry, then check the saved conversation. The draft has been kept.'
    : draft.captureReceipt
      ? 'The context capture is uncertain. Retry the exact capture before sending.'
      : undefined;
  const controlsBlocked =
    busy ||
    workspace.pending ||
    workspace.retryAvailable ||
    workspace.connection !== 'connected' ||
    draft.priorSend ||
    Boolean(draft.captureReceipt);
  const frozen = panel?.kind === 'preview' && Boolean(panel.command);
  const changed = frozen && panel.scope !== currentPanelScope.current;
  const previewBlocked = changed
    ? 'The recipient, draft context or task changed. Close this preview and review again.'
    : controlsBlocked
      ? (uncertain ?? 'Wait for the current request before sending.')
      : undefined;
  const recovery = (draft.priorSend || draft.captureReceipt) && (
    <div style={{ flexShrink: 0, maxHeight: '25%', overflowY: 'auto' }}>
      {uncertain && (
        <p className="notice" role="status">
          {uncertain}
        </p>
      )}
      {draft.priorSend && workspace.retryAvailable && contextSendReceipts.has(draftKey) && (
        <button
          className="button secondary"
          type="button"
          disabled={busy || workspace.pending || workspace.connection !== 'connected'}
          onClick={() => {
            const receipt = contextSendReceipts.get(draftKey);
            if (receipt) void dispatch(receipt.command, receipt.submitted, true);
          }}
        >
          Retry exact message
        </button>
      )}
      {draft.priorSend && !workspace.retryAvailable && !workspace.pending && (
        <button
          className="button secondary"
          type="button"
          onClick={() => {
            contextSendReceipts.delete(draftKey);
            writeContextDraft(draftKey, (current) => ({ ...current, priorSend: false }));
            setError(undefined);
          }}
        >
          Keep as a new draft after reviewing history
        </button>
      )}
      {draft.captureReceipt && (
        <button
          className="button secondary"
          type="button"
          disabled={busy || workspace.pending || workspace.connection !== 'connected'}
          onClick={() => {
            setPanel({ kind: 'choose' });
            void add('source-file', draft.captureReceipt);
          }}
        >
          Retry exact context capture
        </button>
      )}
    </div>
  );
  return {
    refs: draft.refs,
    busy,
    sending,
    error: error ?? saved.error,
    uncertain,
    review,
    openHistory: (ref: ConversationContextRef) => {
      void preview(ref, true);
    },
    composer: {
      attachments: draft.refs.map((ref, index) => ({
        id: ref.artifactId,
        label: draft.facts?.[ref.artifactId]
          ? `Context ${index + 1} · ${draft.facts[ref.artifactId].files} ${draft.facts[ref.artifactId].files === 1 ? 'file' : 'files'} · ${draft.facts[ref.artifactId].bytes.toLocaleString()} bytes`
          : `Context ${index + 1} · ${ref.hash.slice(0, 8)}`,
      })),
      onAddContext: () => {
        setError(undefined);
        setPanel({ kind: 'choose' });
      },
      onPreviewContext: (id: string) => {
        const ref = draft.refs.find((ref) => ref.artifactId === id);
        if (ref) void preview(ref);
      },
      onRemoveContext: (id: string) => {
        if (!controlsBlocked)
          writeContextDraft(draftKey, (current) => ({
            ...current,
            refs: current.refs.filter((ref) => ref.artifactId !== id),
          }));
      },
      contextDisabled: controlsBlocked,
      addContextDisabled: busy || workspace.pending || workspace.connection !== 'connected',
    },
    panel:
      panel &&
      (panel.kind === 'preview' ? (
        <ContextPreview
          captures={panel.captures}
          recipient={panel.recipient}
          text={panel.command?.payload.text}
          blocked={panel.command ? (error ?? previewBlocked) : error}
          onClose={() => setPanel(null)}
          recovery={recovery}
          onSend={
            panel.command
              ? () => {
                  if (!previewBlocked && !error && panel.command)
                    void dispatch(panel.command, panel.submitted ?? panel.command.payload.text);
                }
              : undefined
          }
        />
      ) : (
        <Dialog
          title="Add context"
          onClose={() => {
            if (!busy) setPanel(null);
          }}
        >
          <div className="launch-content">
            <p className="muted small">
              Choose committed source or one project log. Captured text is reviewed before sending.
            </p>
            {panel.kind === 'reading' || busy ? (
              <p role="status">Reading captured context.</p>
            ) : (
              <div className="form-stack">
                {(['source-file', 'source-folder', 'log-file'] as const).map((mode) => (
                  <button
                    className="button secondary"
                    type="button"
                    key={mode}
                    disabled={
                      controlsBlocked || Boolean(draft.captureReceipt) || draft.refs.length >= 4
                    }
                    onClick={() => void add(mode)}
                  >
                    {
                      {
                        'source-file': 'Source file',
                        'source-folder': 'Source folder',
                        'log-file': 'Project log',
                      }[mode]
                    }
                  </button>
                ))}
              </div>
            )}
            {draft.refs.length >= 4 && (
              <p className="notice" role="status">
                This draft has four context captures. Close this dialog and remove context to add
                more.
              </p>
            )}
            {workspace.retryAvailable && !draft.priorSend && !draft.captureReceipt && (
              <p className="notice" role="status">
                Close this dialog and use Retry exact command before adding context.
              </p>
            )}
            {draft.captureReceipt && !workspace.retryAvailable && !workspace.pending && (
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  writeContextDraft(draftKey, (current) => ({
                    ...current,
                    captureReceipt: undefined,
                  }));
                  setError(undefined);
                }}
              >
                Choose context again
              </button>
            )}
            {recovery}
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
          </div>
        </Dialog>
      )),
    recovery,
  };
}

type PlanningFields = {
  role: 'lead' | 'orchestrator';
  attempts: string;
  minutes: string;
  concurrency: string;
  credits: boolean;
  consent: boolean;
};
const getPlanningProfile = (snapshot: Snapshot) =>
  snapshot.nativeProfiles.find(
    (profile): profile is Extract<Snapshot['nativeProfiles'][number], { family: 'openai' }> =>
      profile.family === 'openai' && profile.id === 'openai-file-v1',
  );
const initialPlanning = (selection?: ConversationPlanningSelection): PlanningFields => ({
  role: selection?.role ?? 'lead',
  attempts: String(selection?.limits.attempts ?? 4),
  minutes: String(selection?.limits.minutes ?? 15),
  concurrency: String(selection?.limits.concurrency ?? 1),
  credits: selection?.creditPolicy === 'existing-credits',
  consent: false,
});
const planningSelection = (fields: PlanningFields) =>
  ConversationPlanningSelectionSchema.safeParse({
    role: fields.role,
    profileId: 'openai-file-v1',
    creditPolicy: fields.credits ? 'existing-credits' : 'ordinary',
    limits: {
      attempts: Number(fields.attempts),
      minutes: Number(fields.minutes),
      concurrency: Number(fields.concurrency),
    },
    consent: 'explicit',
  });
function PlanningControls({
  value,
  onChange,
  snapshot,
}: {
  value: PlanningFields;
  onChange: (value: PlanningFields) => void;
  snapshot: Snapshot;
}) {
  const profile = getPlanningProfile(snapshot);
  return (
    <>
      <p className="muted small">
        {profile?.displayName ?? 'Planning profile unavailable'} · Requested model{' '}
        {profile?.model ?? 'unknown'} · Requested effort {profile?.effort ?? 'unknown'}. Planning
        route unqualified.
      </p>
      <div className="policy-grid">
        <label>
          Primary role
          <select
            value={value.role}
            onChange={(event) =>
              onChange({ ...value, role: event.target.value as PlanningFields['role'] })
            }
          >
            <option value="lead">Lead</option>
            <option value="orchestrator">Orchestrator</option>
          </select>
        </label>
        {(['attempts', 'minutes', 'concurrency'] as const).map((axis) => (
          <label key={axis}>
            {axis === 'concurrency' ? 'Active model agents' : titleCase(axis)}
            <input
              type="number"
              min={1}
              max={axis === 'attempts' ? 100 : axis === 'minutes' ? 1440 : 16}
              value={value[axis]}
              onChange={(event) => onChange({ ...value, [axis]: event.target.value })}
            />
          </label>
        ))}
      </div>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={value.credits}
          onChange={(event) =>
            onChange({ ...value, credits: event.target.checked, consent: false })
          }
        />
        Allow existing credits after ordinary access is exhausted
      </label>
    </>
  );
}

export function NewGoal({
  snapshot,
  workspace,
  onCreated,
  onManual,
  text,
  onTextChange,
}: {
  text: string;
  onTextChange: (text: string) => void;
  snapshot: Snapshot;
  workspace: Workspace;
  onCreated: (id: string, submitted: string) => void;
  onManual: () => void;
}) {
  const [projectId, setProjectId] = useState(snapshot.projects[0]?.id ?? '');
  const [planning, setPlanning] = useState(() => initialPlanning());
  const selection = planningSelection(planning);
  const profile = getPlanningProfile(snapshot);
  const context = useContextComposer({
    draftKey: `goal:${projectId}`,
    projectId,
    scope: canonicalJson({
      projectId,
      planning,
      model: profile?.model ?? null,
      effort: profile?.effort ?? null,
    }),
    recipient: profile
      ? {
          summary: `${roleLabels[planning.role]} · ${familyName(profile.family)} · Requested model ${profile.model}`,
          details: `Profile ${profile.id} · Requested model ${profile.model} · Requested effort ${profile.effort} · Route selected when planning is admitted`,
        }
      : { summary: 'Planning recipient has not been selected.' },
    workspace,
    afterApplied: (result, submitted) => {
      if (result.entity && 'state' in result.entity) onCreated(result.entity.id, submitted);
    },
  });
  const blocked =
    workspace.connection !== 'connected'
      ? 'Reconnect to send the goal.'
      : workspace.retryAvailable
        ? 'Resolve the uncertain command with exact retry.'
        : context.uncertain
          ? context.uncertain
          : context.busy || workspace.pending
            ? 'Wait for the current request.'
            : !projectId
              ? 'Choose a project before sending the goal.'
              : !profile?.available
                ? `Planning profile unavailable: ${profile?.reason ?? 'not configured'}.`
                : !selection.success
                  ? 'Choose finite planning limits within the displayed bounds.'
                  : !planning.consent
                    ? 'Confirm the bounded planning permission above.'
                    : undefined;
  async function create(goal: string) {
    if (blocked || !selection.success || workspace.pending) return;
    await context.review(
      {
        command: 'CreateTaskDiscussion',
        expectedRevision: 0,
        payload: { projectId, text: goal, planning: selection.data },
      },
      text,
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div className="launch-content">
        <div className="section-heading">
          <h1>New goal</h1>
          <button className="button secondary" type="button" onClick={onManual}>
            Create task manually
          </button>
        </div>
        <label>
          Project
          <select
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setPlanning((value) => ({ ...value, consent: false }));
            }}
          >
            {snapshot.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <details>
          <summary>
            Planning settings · {planning.attempts} attempts · {planning.minutes} minutes ·{' '}
            {planning.concurrency} active model agents
          </summary>
          <div className="form-stack">
            <PlanningControls
              value={planning}
              onChange={(value) => setPlanning({ ...value, consent: false })}
              snapshot={snapshot}
            />
          </div>
        </details>
        {
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={planning.consent}
              onChange={(event) => setPlanning({ ...planning, consent: event.target.checked })}
            />
            Allow bounded planning ·{' '}
            {planning.credits ? 'Existing credits permitted' : 'Ordinary access only'} · Execution
            requires a separate decision
          </label>
        }
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Conversation
          conversationId="new-goal"
          messages={[]}
          primary={
            profile
              ? {
                  name: roleLabels[planning.role],
                  role: titleCase(planning.role),
                  route: familyName(profile.family),
                  model: `${profile.model} (requested)`,
                  effort: `${profile.effort} (requested)`,
                }
              : null
          }
          detailsStatus={context.uncertain ? 'Outcome uncertain' : undefined}
          details={context.recovery}
          status="Goal not sent"
          next="Planning route unqualified. Describe the outcome; the lead can propose criteria."
          composer={{
            value: text,
            onChange: onTextChange,
            onSend: (goal) => void create(goal),
            sending: context.sending,
            disabledReason: blocked,
            ...context.composer,
          }}
          error={context.error ?? workspace.error ?? undefined}
        />
      </div>
      {context.panel}
    </div>
  );
}

export function ConversationView({
  task,
  visible,
  snapshot,
  workspace,
  onState,
  onPrepare,
  draft,
  onDraftChange,
  onDraftSaved,
  answerDrafts,
  onAnswerDraftChange,
}: {
  visible: boolean;
  answerDrafts: Record<string, string>;
  onAnswerDraftChange: (id: string, text: string) => void;
  draft: string;
  onDraftChange: (text: string) => void;
  onDraftSaved: (submitted: string) => void;
  task: Task;
  snapshot: Snapshot;
  workspace: Workspace;
  onState: (state: TaskConversationState | null) => void;
  onPrepare: () => void;
}) {
  const history = useConversation(task, workspace, visible);
  const { state, entries } = history;
  const [settings, setSettings] = useState(false);
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null);
  const [planning, setPlanning] = useState(() => initialPlanning());
  const [pendingDecision, setPendingDecision] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string>();
  const [settingsRetry, setSettingsRetry] = useState(false);
  useEffect(() => {
    onState(state);
  }, [state, onState]);
  useEffect(() => {
    setSelectedQuestion((current) =>
      current && state?.pendingQuestions.some((question) => question.id === current)
        ? current
        : (state?.pendingQuestions[0]?.id ?? null),
    );
  }, [state?.pendingQuestions]);
  const pendingQuestion =
    state?.pendingQuestions.find((question) => question.id === selectedQuestion) ??
    state?.pendingQuestions[0];
  const current = Boolean(state && state.revision === task.revision);
  const decisionsBlocked =
    workspace.pending ||
    workspace.connection !== 'connected' ||
    workspace.retryAvailable ||
    !current;
  const decisionBlockedReason =
    workspace.connection !== 'connected'
      ? 'Reconnect to make a decision.'
      : workspace.retryAvailable
        ? 'Resolve the uncertain command with exact retry.'
        : !current
          ? 'Refreshing the current conversation state.'
          : workspace.pending
            ? 'Waiting for the current request.'
            : undefined;
  const recipientRoute = snapshot.routes.find(
    (route) => route.id === state?.configuration?.routeId,
  );
  const context = useContextComposer({
    draftKey: `task:${task.id}`,
    projectId: task.projectId,
    sourceBase: snapshot.runs.find((run) => run.id === state?.currentRunId)?.source.base,
    scope: canonicalJson({
      taskId: task.id,
      revision: task.revision,
      configuration: state?.configuration ?? null,
      recipientFamily: recipientRoute?.family ?? null,
    }),
    recipient: state?.configuration
      ? {
          summary: `${roleLabels[state.configuration.selection.role]} · ${recipientRoute ? familyName(recipientRoute.family) : 'Provider not yet selected'} · ${state.configuration.effectiveModel ? `Effective model ${state.configuration.effectiveModel}` : `Requested model ${state.configuration.requestedModel ?? 'unknown'}`}`,
          details: `Profile ${state.configuration.selection.profileId} · Route ${state.configuration.routeId ?? 'not yet selected'} · Requested model ${state.configuration.requestedModel ?? 'unknown'} · Effective model ${state.configuration.effectiveModel ?? 'unknown'} · Requested effort ${state.configuration.requestedEffort ?? 'unknown'} · Effective effort ${state.configuration.effectiveEffort ?? 'unknown'}`,
        }
      : { summary: 'Planning recipient has not been selected.' },
    workspace,
    afterApplied: (_result, submitted) => onDraftSaved(submitted),
  });
  const blocked =
    workspace.connection !== 'connected'
      ? 'Reconnect to send a message.'
      : workspace.retryAvailable
        ? 'Resolve the uncertain command with exact retry.'
        : context.uncertain
          ? context.uncertain
          : context.busy || workspace.pending
            ? 'Wait for the current request.'
            : !current
              ? 'Refreshing the current conversation state.'
              : !state?.send.available
                ? reasonText(state?.send.reason ?? 'not-configured')
                : undefined;
  async function mutate(command: DesktopCommand) {
    try {
      return await workspace.command(command);
    } catch {
      return null;
    }
  }
  async function decide(id: string, command: DesktopCommand) {
    setPendingDecision(id);
    try {
      return await mutate(command);
    } finally {
      setPendingDecision(null);
    }
  }
  async function send(text: string) {
    if (blocked || !state || workspace.pending) return;
    await context.review(
      {
        command: state.send.disposition === 'queue' ? 'QueueTaskGuidance' : 'SendTaskMessage',
        expectedRevision: task.revision,
        payload: { taskId: task.id, text },
      },
      draft,
    );
  }
  const messages = useMemo<ConversationMessage[]>(() => {
    const included = new Set(
      entries.filter((entry) => entry.kind === 'input-delivery').map((entry) => entry.replyTo),
    );
    const answered = new Set(
      entries.filter((entry) => entry.kind === 'answer').map((entry) => entry.replyTo),
    );
    const rows: ConversationMessage[] = entries
      .filter((entry) => entry.kind !== 'input-delivery')
      .map((entry) => {
        const author = entry.author;
        const agent = author.kind === 'agent';
        const row: ConversationMessage = {
          id: entry.id,
          kind: agent ? 'primary' : 'user',
          author: author.kind === 'agent' ? roleLabels[author.role] : 'You',
          at: entry.at,
          text: entry.text,
          attachments:
            'context' in entry
              ? entry.context?.map((ref, index) => ({
                  id: ref.artifactId,
                  label: `Captured context ${index + 1} · ${ref.hash.slice(0, 8)}`,
                }))
              : undefined,
        };
        if (author.kind === 'agent') {
          const route = snapshot.routes.find((value) => value.id === author.routeId);
          row.role = titleCase(author.role);
          row.route = route ? `${familyName(route.family)} · ${route.id}` : author.routeId;
        } else row.delivery = included.has(entry.id) ? 'included' : 'queued';
        if (entry.kind === 'question') row.text = '';
        if (entry.kind === 'question')
          row.decision = {
            id: entry.id,
            kind: 'question',
            title: 'The primary role needs an answer',
            text: entry.text,
            answerLabel: `Answer for ${roleLabels[entry.author.role]}`,
            pending: pendingDecision === entry.id,
            disabledReason: decisionBlockedReason,
            resolution:
              state?.pendingQuestions.some((question) => question.id === entry.id) &&
              entry.binding.runId === state.currentRunId
                ? undefined
                : answered.has(entry.id)
                  ? 'Answer recorded.'
                  : 'No current answer is requested.',
          };
        if (entry.kind === 'plan-proposal')
          row.decision = {
            id: entry.id,
            kind: 'plan',
            title: entry.proposal.summary,
            text: 'Review this proposal before adopting it as the task contract.',
            criteria: entry.proposal.criteria,
            slices: entry.proposal.slices,
            facts: [
              {
                label: 'Scope',
                value: entry.proposal.slices
                  .map((slice) => `${slice.title}: ${slice.scope.join(', ')}`)
                  .join('\n'),
              },
              { label: 'Checks', value: entry.proposal.checks.join('\n') || 'No checks proposed.' },
            ],
            pending: pendingDecision === entry.id,
            disabledReason: decisionBlockedReason,
            resolution: state?.adoptedProposal?.id === entry.id ? 'Plan adopted.' : undefined,
            choices: [
              {
                id: 'adopt',
                label: 'Adopt plan',
                tone: 'primary',
                disabledReason:
                  current && state?.adopt.available && state.proposal?.id === entry.id
                    ? undefined
                    : reasonText(state?.adopt.reason ?? 'proposal-not-current'),
              },
            ],
          };
        return row;
      });
    for (const approval of snapshot.approvals.filter(
      (value) => value.taskId === task.id && value.status === 'pending',
    ))
      rows.push({
        id: approval.approvalId,
        kind: 'system',
        author: 'Controller',
        text: '',
        decision: {
          id: approval.approvalId,
          kind: 'approval',
          title: 'Permission request',
          text: 'This decision applies only to the exact request below.',
          approval,
          pending: pendingDecision === approval.approvalId,
          disabledReason: decisionBlockedReason,
        },
      });
    return rows;
  }, [
    entries,
    snapshot.routes,
    snapshot.approvals,
    task.id,
    state,
    current,
    pendingDecision,
    decisionBlockedReason,
  ]);
  const config = state?.configuration;
  const selection = planningSelection(planning);
  async function configure() {
    if (
      !planning.consent ||
      !selection.success ||
      decisionsBlocked ||
      state?.activeAttempt ||
      state?.phase === 'unknown' ||
      state?.phase === 'stopping'
    )
      return;
    setSettingsError(undefined);
    setSettingsRetry(false);
    const result = await mutate({
      command: 'ConfigureTaskConversation',
      expectedRevision: task.revision,
      payload: { taskId: task.id, planning: selection.data },
    });
    if (result && applied(result.outcome)) setSettings(false);
    else {
      setSettingsRetry(!result || result.outcome === 'outcome-unknown');
      setSettingsError(
        result?.reason ?? 'The settings result is unknown. Use exact retry to resolve it.',
      );
    }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {history.error && (
        <button
          className="button secondary"
          type="button"
          disabled={workspace.pending || history.reading}
          onClick={history.refresh}
        >
          Refresh conversation
        </button>
      )}
      {pendingQuestion && (
        <div
          className="launch-summary"
          style={{ flexShrink: 0, flexWrap: 'wrap', gap: '8px 16px', padding: '4px 24px' }}
        >
          <label
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              minWidth: 0,
            }}
          >
            Pending questions ({state?.pendingQuestions.length})
            <select
              aria-label="Pending question"
              style={{ width: 'auto' }}
              value={pendingQuestion.id}
              disabled={workspace.pending || history.reading}
              onChange={(event) => setSelectedQuestion(event.target.value)}
            >
              {state?.pendingQuestions.map((question, index) => (
                <option key={question.id} value={question.id}>
                  Question {index + 1}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button secondary"
            type="button"
            disabled={workspace.pending || history.reading}
            onClick={() => void history.loadQuestion(pendingQuestion.id, pendingQuestion.cursor)}
          >
            Show pending question
          </button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Conversation
          conversationId={task.id}
          visible={visible}
          messages={messages}
          onOpenAttachment={(id) => {
            for (const entry of entries) {
              const ref =
                'context' in entry
                  ? entry.context?.find((ref) => ref.artifactId === id)
                  : undefined;
              if (ref) {
                context.openHistory(ref);
                return;
              }
            }
          }}
          primary={
            config
              ? {
                  name: roleLabels[config.selection.role],
                  role: titleCase(config.selection.role),
                  route: config.routeId
                    ? snapshot.routes.find((route) => route.id === config.routeId)?.family
                      ? familyName(
                          snapshot.routes.find((route) => route.id === config.routeId)?.family ??
                            '',
                        )
                      : config.routeId
                    : 'Route unknown',
                  model: `Effective: ${config.effectiveModel ?? 'unknown'} · Requested: ${config.requestedModel ?? 'unknown'}`,
                  effort: `Effort ${config.effectiveEffort ?? 'unknown'} · Requested: ${config.requestedEffort ?? 'unknown'}`,
                }
              : null
          }
          detailsStatus={
            context.uncertain
              ? 'Outcome uncertain'
              : history.historyNotice
                ? 'History refreshed'
                : undefined
          }
          details={
            <>
              {history.historyNotice && (
                <p className="notice" role="status">
                  {history.historyNotice}
                </p>
              )}
              {state && (
                <div className="launch-summary">
                  <span>{titleCase(state.contractStatus)} contract</span>
                  <span>
                    {state.budget
                      ? `${state.budget.remaining.attempts}/${state.budget.limits.attempts} attempts · ${state.budget.remaining.minutes}/${state.budget.limits.minutes} minutes remaining`
                      : 'Task budget unknown'}
                  </span>
                  <span>{state.queuedInputCount} queued inputs</span>
                </div>
              )}
              {context.recovery}
            </>
          }
          activeWorkers={
            state?.phase === 'unknown'
              ? undefined
              : new Set([
                  ...snapshot.attempts
                    .filter(
                      (attempt) =>
                        attempt.runId === state?.currentRunId &&
                        ['intent', 'running', 'stopping'].includes(attempt.state),
                    )
                    .map((attempt) => attempt.id),
                  ...(state?.activeAttempt &&
                  ['intent', 'running', 'stopping'].includes(state.activeAttempt.state)
                    ? [state.activeAttempt.id]
                    : []),
                ]).size
          }
          maximumWorkers={state?.budget?.limits.concurrency}
          status={state ? titleCase(state.phase) : 'Conversation state unavailable'}
          next={
            state?.purpose === 'conversation'
              ? 'Planning route unqualified. Execution needs a separate decision.'
              : (task.next ?? undefined)
          }
          loading={!state && history.reading}
          error={context.error ?? history.error}
          onLoadEarlier={history.before ? history.loadEarlier : undefined}
          loadingEarlier={history.earlier}
          historyBlocked={history.reading || workspace.pending}
          composer={{
            value: draft,
            onChange: onDraftChange,
            onSend: (text) => void send(text),
            sending: context.sending,
            disabledReason: blocked,
            ...context.composer,
            hint:
              state?.send.disposition === 'queue'
                ? 'Guidance is retained for a later, explicitly admitted planning turn.'
                : undefined,
          }}
          answerDrafts={answerDrafts}
          onAnswerDraftChange={onAnswerDraftChange}
          onAnswer={(questionId, text) => {
            if (
              decisionsBlocked ||
              !state?.pendingQuestions.some((question) => question.id === questionId)
            )
              return;
            void decide(questionId, {
              command: 'AnswerTaskQuestion',
              expectedRevision: task.revision,
              payload: { taskId: task.id, questionId, text },
            });
          }}
          onChoice={(proposalId, choice) => {
            if (
              choice !== 'adopt' ||
              decisionsBlocked ||
              !state?.adopt.available ||
              state.proposal?.id !== proposalId ||
              workspace.pending
            )
              return;
            void decide(proposalId, {
              command: 'AdoptTaskPlan',
              expectedRevision: task.revision,
              payload: { taskId: task.id, proposalId, proposalHash: state.proposal.hash },
            }).then((result) => {
              if (result && applied(result.outcome)) onPrepare();
            });
          }}
          onApproval={(approval, decision) => {
            if (
              workspace.pending ||
              workspace.connection !== 'connected' ||
              workspace.retryAvailable
            )
              return;
            const { requester: _, consequence: __, status: ___, ...binding } = approval;
            void decide(approval.approvalId, {
              command: 'ResolveApproval',
              expectedRevision: task.revision,
              payload: { binding, decision },
            });
          }}
          onOpenSettings={() => {
            setSettingsError(undefined);
            setSettingsRetry(false);
            setPlanning(initialPlanning(config?.selection));
            setSettings(true);
          }}
        />
      </div>
      {context.panel}
      {settings && (
        <Dialog title="Session settings" onClose={() => setSettings(false)}>
          <div className="launch-content">
            {settingsError && (
              <p className="notice" role="alert">
                {settingsError}
              </p>
            )}
            {settingsRetry && (
              <p className="muted small">
                The outcome is uncertain. Retry the exact command before changing the settings.
              </p>
            )}
            {settingsRetry && workspace.retryAvailable && (
              <button
                className="button secondary"
                type="button"
                disabled={workspace.pending || workspace.connection !== 'connected'}
                onClick={() => {
                  void workspace
                    .retryCommand()
                    .then((result) => {
                      if (result && applied(result.outcome)) setSettings(false);
                      else {
                        setSettingsError(result?.reason ?? 'The settings result is still unknown.');
                        setSettingsRetry(!result || result.outcome === 'outcome-unknown');
                      }
                    })
                    .catch(() =>
                      setSettingsError(
                        'The settings result is still unknown. Reconnect and retry the exact command.',
                      ),
                    );
                }}
              >
                Retry exact settings command
              </button>
            )}
            <PlanningControls
              value={planning}
              onChange={(value) => setPlanning({ ...value, consent: false })}
              snapshot={snapshot}
            />
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={planning.consent}
                onChange={(event) => setPlanning({ ...planning, consent: event.target.checked })}
              />
              Allow bounded planning with this profile and these limits
            </label>
            <p className="muted small">
              The controller rechecks the configuration at a safe boundary. Saved execution limits
              and permissions keep their own review.
            </p>
            <button
              className="button secondary"
              type="button"
              disabled={
                !current ||
                state?.contractStatus !== 'confirmed' ||
                Boolean(state.activeAttempt) ||
                state.phase === 'unknown' ||
                state.phase === 'stopping'
              }
              onClick={() => {
                setSettings(false);
                onPrepare();
              }}
            >
              Review execution team and permissions
            </button>
          </div>
          <div className="dialog-footer">
            <button
              className="button primary"
              type="button"
              disabled={
                decisionsBlocked ||
                Boolean(state?.activeAttempt) ||
                state?.phase === 'unknown' ||
                state?.phase === 'stopping' ||
                !planning.consent ||
                !selection.success ||
                workspace.pending ||
                workspace.connection !== 'connected' ||
                workspace.retryAvailable
              }
              onClick={() => void configure()}
            >
              Save planning settings
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
