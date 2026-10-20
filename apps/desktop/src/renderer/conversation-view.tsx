import {
  CommandIdSchema,
  type CommandResult,
  CommandSchema,
  type ConversationContextBundle,
  type ConversationContextRef,
  ConversationContextRefsSchema,
  type ConversationEntry,
  type ConversationModelChoices,
  type ConversationModelRequest,
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
import { actionName, Dialog, familyName, TaskNext, titleCase } from './components.tsx';
import type { ComposerControlsProps } from './composer-controls.tsx';
import { ContextGauge } from './context-gauge.tsx';
import { Conversation, type ConversationMessage } from './conversation.tsx';
import type { ExecutionPolicySeed } from './launch.tsx';
import { ConversationContextCaptureError, type DesktopCommand, type Workspace } from './source.ts';
import { roleLabels } from './templates.ts';

export type RegisterComposerRetry = (retry: () => Promise<void>) => () => void;

const applied = (outcome: string) => outcome === 'applied' || outcome === 'already-applied';
const reasonText = (reason: string) =>
  reason === 'task-not-discussing'
    ? 'The current execution run stays current. Material planning changes are unavailable here.'
    : `${titleCase(reason.replaceAll('-', ' '))}.`;

// Preparation needs the adopted proposal to remain the controller's current, adoptable proposal.
export const adoptedPlanCurrent = (state: TaskConversationState) =>
  state.purpose !== 'conversation' ||
  Boolean(
    state.adoptedProposal &&
      state.adoptedProposal.runId === state.currentRunId &&
      state.proposal?.id === state.adoptedProposal.id &&
      state.proposal.hash === state.adoptedProposal.hash &&
      state.adopt.available,
  );
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
type ContextFact = { hash: string; files: number; bytes: number; name?: string };
type ContextDraft = {
  refs: ConversationContextRef[];
  facts?: Record<string, ContextFact>;
  priorSend: boolean;
  captureReceipt?: ContextCaptureReceipt;
  sendReceipt?: { command: ContextSendCommand; submitted: string };
};
type ContextSendCommand = Extract<
  DesktopCommand,
  { command: 'CreateTaskDiscussion' | 'SendTaskMessage' | 'QueueTaskGuidance' }
>;
const contextSendSchemas = CommandSchema.options
  .filter(
    (
      schema,
    ): schema is Extract<
      (typeof CommandSchema.options)[number],
      { shape: { command: { value: ContextSendCommand['command'] } } }
    > =>
      ['CreateTaskDiscussion', 'SendTaskMessage', 'QueueTaskGuidance'].includes(
        schema.shape.command.value,
      ),
  )
  .map((schema) => schema.omit({ protocol: true, key: true, actor: true }));
function sendReceipt(value: unknown, draftKey: string): ContextDraft['sendReceipt'] {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 2 ||
    !('command' in value) ||
    !('submitted' in value) ||
    typeof value.submitted !== 'string' ||
    new TextEncoder().encode(JSON.stringify(value)).length > 32768
  )
    return;
  for (const schema of contextSendSchemas) {
    const parsed = schema.safeParse(value.command);
    if (!parsed.success) continue;
    const command = parsed.data;
    if (
      (command.command === 'CreateTaskDiscussion' &&
        draftKey === `goal:${command.payload.projectId}`) ||
      ((command.command === 'SendTaskMessage' || command.command === 'QueueTaskGuidance') &&
        draftKey === `task:${command.payload.taskId}`)
    )
      return { command, submitted: value.submitted };
  }
}
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
          const name =
            typeof fact.name === 'string' && fact.name.length <= 1024 ? fact.name : undefined;
          if (hash.success && hash.data === ref.hash && files.success && bytes.success)
            facts[ref.artifactId] = {
              hash: hash.data,
              files: files.data,
              bytes: bytes.data,
              ...(name ? { name } : {}),
            };
        }
      }
      drafts[key] = {
        refs: refs.data,
        facts,
        priorSend: 'priorSend' in value && value.priorSend === true,
        sendReceipt: 'sendReceipt' in value ? sendReceipt(value.sendReceipt, key) : undefined,
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
export function pendingGoalProject() {
  return Object.entries(readContextDrafts().drafts)
    .find(([key, draft]) => key.startsWith('goal:') && draft.priorSend)?.[0]
    .slice(5);
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
// A capture is named by its only file, or by the folder its files share.
const contextName = ({ files }: ConversationContextBundle) => {
  if (files.length === 1) return files[0].path;
  const [first, ...rest] = files.map((file) => file.path.split('/'));
  let shared = first.length - 1;
  for (const parts of rest) {
    let index = 0;
    while (index < shared && parts[index] === first[index]) index++;
    shared = index;
  }
  return shared ? `${first.slice(0, shared).join('/')}/` : 'Project root';
};
const contextFact = (capture: CapturedContext): ContextFact => ({
  hash: capture.ref.hash,
  files: capture.bundle.files.length,
  bytes: contextBytes(capture),
  name: contextName(capture.bundle),
});
const contextRefusals = new Map([
  [
    'conversation-context-too-large',
    'The selection is too large. Context takes up to 32 text files, 8 KiB each and 32 KiB in total.',
  ],
  [
    'conversation-context-outside-project',
    'Choose a file or folder inside the registered project.',
  ],
  ['conversation-context-source-changed', 'The project changed during capture. Choose it again.'],
  [
    'conversation-context-unavailable',
    'This selection cannot be captured. Use committed UTF-8 text, or a text log inside the project outside hidden folders. Links, empty or binary files and credential paths are refused.',
  ],
  [
    'conversation-context-invalid',
    'The captured context no longer matches this project commit. Remove it and capture again.',
  ],
]);
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
  registerRetry,
}: {
  draftKey: string;
  projectId: string;
  sourceBase?: string;
  scope: string;
  recipient: ContextRecipient;
  workspace: Workspace;
  afterApplied: (result: CommandResult, submitted: string) => void;
  registerRetry?: RegisterComposerRetry;
}) {
  const saved = useSyncExternalStore(subscribeContextDrafts, readContextDrafts);
  const draft = saved.drafts[draftKey] ?? emptyContextDraft;
  const [cache, setCache] = useState<Record<string, CapturedContext>>({});
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const reads = useRef(new Map<string, Promise<CapturedContext>>());
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const releaseRetry = useRef<(() => void) | null>(null);
  function clearRetry() {
    releaseRetry.current?.();
    releaseRetry.current = null;
  }
  function retainRetry(retry: () => Promise<void>) {
    clearRetry();
    releaseRetry.current = registerRetry?.(retry) ?? null;
  }
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
  function captureProjectReason() {
    const current = latest.current;
    if (
      !current.projectId ||
      (!current.workspace.projects.some((project) => project.id === current.projectId) &&
        !(
          current.draftKey.startsWith('task:') &&
          current.workspace.snapshot?.tasks.some(
            (task) =>
              `task:${task.id}` === current.draftKey && task.projectId === current.projectId,
          ) &&
          current.workspace.snapshot.projects.some((project) => project.id === current.projectId)
        ))
    )
      return 'Choose a project before adding context.';
    if (current.workspace.preview) return 'Context capture is unavailable in preview.';
    if (current.draftKey !== draftKey || current.projectId !== projectId || current.scope !== scope)
      return 'The draft changed. Choose context again.';
  }
  const refSignature = canonicalJson(draft.refs);
  const panelScope = `${scope}:${refSignature}`;
  const currentPanelScope = useRef(panelScope);
  currentPanelScope.current = panelScope;
  const message = (failure: unknown) =>
    failure instanceof Error
      ? (contextRefusals.get(failure.message.split(' ')[0]) ?? failure.message)
      : 'Context could not be prepared.';
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
              facts: { ...current.facts, [ref.artifactId]: contextFact(capture) },
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
    clearRetry();
    writeContextDraft(draftKey, (current) => ({
      ...current,
      refs: sameContext(current.refs, refs) ? [] : current.refs,
      priorSend: false,
      sendReceipt: undefined,
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
    try {
      const receipt = sendReceipt({ command, submitted }, draftKey);
      if (!receipt) throw new Error('The exact send could not be kept in this draft.');
      writeContextDraft(draftKey, (current) => ({
        ...current,
        priorSend: true,
        sendReceipt: receipt,
      }));
      const result = retry
        ? await workspace.retryCommand(command)
        : await workspace.command(command);
      if (result && applied(result.outcome)) {
        finish(result, submitted, refs);
        if (latest.current.draftKey === draftKey) setPanel(null);
      } else if (!result || result.outcome === 'outcome-unknown') {
        retainRetry(() => dispatch(command, submitted, true));
        setError('The send outcome is unknown. Retry this exact send before changing the message.');
      } else {
        clearRetry();
        writeContextDraft(draftKey, (current) => ({
          ...current,
          priorSend: false,
          sendReceipt: undefined,
        }));
        setError(
          result.reason === 'conversation-context-too-large'
            ? 'The message and its context exceed the planning input limit. Remove a capture and review again.'
            : (contextRefusals.get(result.reason ?? '') ??
                [result.reason ?? result.outcome, result.next].filter(Boolean).join(' ')),
        );
      }
    } catch (failure) {
      retainRetry(() => dispatch(command, submitted, true));
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
    if (!retryReceipt && captureProjectReason()) return;
    if (
      busyRef.current ||
      workspace.pending ||
      draft.priorSend ||
      (!retryReceipt && Boolean(draft.captureReceipt)) ||
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
        if (captureProjectReason()) return;
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
            facts: { ...current.facts, [capture.ref.artifactId]: contextFact(capture) },
          };
        const refs = ConversationContextRefsSchema.parse([...current.refs, capture.ref]);
        return {
          ...current,
          refs,
          captureReceipt: undefined,
          facts: { ...current.facts, [capture.ref.artifactId]: contextFact(capture) },
        };
      });
      clearRetry();
      setCache((current) => ({ ...current, [capture.ref.artifactId]: capture }));
      if (latest.current.draftKey === draftKey)
        setPanel({ kind: 'preview', captures: [capture], scope: panelScope, recipient });
    } catch (failure) {
      if (failure instanceof ConversationContextCaptureError) {
        const receipt = captureReceipt(failure.receipt);
        if (receipt?.projectId === projectId) {
          writeContextDraft(draftKey, (current) => ({ ...current, captureReceipt: receipt }));
          retainRetry(() => add('source-file', receipt));
        }
      }
      if (latest.current.draftKey === draftKey) {
        setPanel({ kind: 'choose' });
        setError(message(failure));
        if (failure instanceof Error && contextRefusals.has(failure.message.split(' ')[0]))
          workspace.dismissError(failure.message);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!workspace.retryAvailable) {
      clearRetry();
      return;
    }
    const receipt = draft.sendReceipt;
    if (draft.priorSend && receipt)
      retainRetry(() => dispatch(receipt.command, receipt.submitted, true));
    else if (draft.captureReceipt) {
      const capture = draft.captureReceipt;
      retainRetry(() => add('source-file', capture));
    }
  });
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
  const projectBlockedReason = captureProjectReason();
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
      {draft.priorSend && workspace.retryAvailable && draft.sendReceipt && (
        <button
          className="button secondary"
          type="button"
          disabled={busy || workspace.pending || workspace.connection !== 'connected'}
          onClick={() => {
            const receipt = draft.sendReceipt;
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
            clearRetry();
            writeContextDraft(draftKey, (current) => ({
              ...current,
              priorSend: false,
              sendReceipt: undefined,
            }));
            setError(undefined);
          }}
        >
          Keep as a new draft after reviewing history
        </button>
      )}
      {draft.captureReceipt && !workspace.retryAvailable && !workspace.pending && (
        <button
          className="button secondary"
          type="button"
          disabled={busy}
          onClick={() => {
            clearRetry();
            writeContextDraft(draftKey, (current) => ({ ...current, captureReceipt: undefined }));
            setError(undefined);
          }}
        >
          Choose context again
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
    controls: {
      contextActions: (
        [
          {
            id: 'source-file',
            kind: 'file',
            label: 'Source file',
            detail: 'Committed UTF-8 text, 8 KiB at most',
          },
          {
            id: 'source-folder',
            kind: 'folder',
            label: 'Source folder',
            detail: 'Up to 32 committed text files, 8 KiB each, 32 KiB in total',
          },
          {
            id: 'log-file',
            kind: 'log',
            label: 'Project log',
            detail: 'Text log inside the project, outside hidden folders, 8 KiB at most',
          },
        ] as const
      ).map((action) => ({
        ...action,
        disabledReason:
          projectBlockedReason ??
          (controlsBlocked
            ? (uncertain ?? 'Wait for the current request or reconnect before adding context.')
            : draft.refs.length >= 4
              ? 'Remove a context capture before adding another.'
              : undefined),
      })),
      onContextAction: (mode: string) => {
        if (
          !projectBlockedReason &&
          !controlsBlocked &&
          draft.refs.length < 4 &&
          (mode === 'source-file' || mode === 'source-folder' || mode === 'log-file')
        )
          void add(mode);
      },
    },
    composer: {
      attachments: draft.refs.map((ref, index) => {
        const fact = draft.facts?.[ref.artifactId];
        return {
          id: ref.artifactId,
          label: fact
            ? `Context ${index + 1} · ${fact.files} ${fact.files === 1 ? 'file' : 'files'} · ${fact.bytes.toLocaleString()} bytes${fact.name ? ` · ${fact.name}` : ''}`
            : `Context ${index + 1} · ${ref.hash.slice(0, 8)}`,
          status: fact ? 'Captured' : 'Details unavailable',
        };
      }),
      onAddContext: () => {
        if (captureProjectReason()) return;
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
      addContextDisabled:
        Boolean(projectBlockedReason) ||
        busy ||
        workspace.pending ||
        workspace.connection !== 'connected',
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
                      Boolean(projectBlockedReason) ||
                      controlsBlocked ||
                      Boolean(draft.captureReceipt) ||
                      draft.refs.length >= 4
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
  modelRequest?: ConversationModelRequest;
};
const getPlanningProfile = (snapshot: Pick<Snapshot, 'nativeProfiles'>) =>
  snapshot.nativeProfiles.find(
    (profile): profile is Extract<Snapshot['nativeProfiles'][number], { family: 'openai' }> =>
      profile.family === 'openai' && profile.id === 'openai-file-v1',
  );
function planningComposerControls(
  snapshot: Pick<Snapshot, 'nativeProfiles'>,
  role: PlanningFields['role'] | null,
  config?: TaskConversationState['configuration'],
  controls?: {
    choices?: ConversationModelChoices;
    disabledReason?: string;
    onSelectModel: (model: string) => void;
    onSelectEffort: (effort: string) => void;
  },
): Pick<ComposerControlsProps, 'primary' | 'policy'> {
  const profile = role === null ? undefined : getPlanningProfile(snapshot);
  const requestedModel = config
    ? (config.requestedModel ?? 'unknown')
    : (profile?.model ?? 'unknown');
  const requestedEffort = config
    ? (config.requestedEffort ?? 'unknown')
    : (profile?.effort ?? 'unknown');
  const advertised =
    controls?.choices?.status === 'last-observed' ? controls.choices.models : undefined;
  const reason = controls?.choices?.reason;
  // Until a turn succeeds the effective pair is unknown. Show the requested pair and say so.
  const unknown = !config?.effectiveModel;
  const shownModel = config
    ? (config.effectiveModel ?? config.requestedModel)
    : (profile?.model ?? null);
  const shownEffort = config
    ? (config.effectiveEffort ?? config.requestedEffort)
    : (profile?.effort ?? null);
  const mark = (value: string, shown: string | null) =>
    unknown && value === shown ? `${value} (requested)` : value;
  return {
    primary: {
      roleLabel: role === null ? 'Unassigned' : roleLabels[role],
      models: advertised
        ? advertised.map((choice) => ({
            id: choice.model,
            label: mark(choice.model, shownModel),
            route: 'OpenAI',
            efforts: choice.efforts.map((effort) => ({
              id: effort,
              label: choice.model === shownModel ? mark(effort, shownEffort) : effort,
            })),
          }))
        : shownModel
          ? [
              {
                id: shownModel,
                label: mark(shownModel, shownModel),
                route: profile ? familyName(profile.family) : undefined,
                efforts: shownEffort
                  ? [{ id: shownEffort, label: mark(shownEffort, shownEffort) }]
                  : [],
              },
            ]
          : [],
      currentModelId: shownModel,
      currentEffortId: shownEffort,
      requestedModelId: config?.selection.modelRequest ? config.requestedModel : undefined,
      requestedEffortId: config?.selection.modelRequest ? config.requestedEffort : undefined,
      scopeLabel: config?.selection.modelRequest
        ? `Saved for later planning turns.${reason && reason !== 'available' ? ` ${reasonText(reason)}` : ''}`
        : advertised
          ? 'Last-observed choices. Saving a change needs a newly adopted plan before execution.'
          : role === null
            ? 'No saved primary planning configuration.'
            : 'Planning profile',
      frozenReason:
        controls?.disabledReason ??
        (advertised
          ? undefined
          : role === null
            ? 'This task has no saved primary planning configuration.'
            : `Model and effort follow the planning profile. Requested model ${requestedModel}; effective model ${config?.effectiveModel ?? 'unknown'}. Requested effort ${requestedEffort}; effective effort ${config?.effectiveEffort ?? 'unknown'}.`),
      onSelectModel: advertised ? controls?.onSelectModel : undefined,
      onSelectEffort: advertised ? controls?.onSelectEffort : undefined,
    },
    policy: {
      label: 'Planning permissions',
      options: [{ id: 'read-only', label: 'Read-only conversation' }],
      currentId: 'read-only',
      scopeLabel: 'Conversation only',
      disabledReason: 'Execution permissions are set when preparing a run.',
    },
  };
}
const initialPlanning = (selection?: ConversationPlanningSelection): PlanningFields => ({
  role: selection?.role ?? 'lead',
  attempts: String(selection?.limits.attempts ?? 4),
  minutes: String(selection?.limits.minutes ?? 15),
  concurrency: String(selection?.limits.concurrency ?? 1),
  credits: selection?.creditPolicy === 'existing-credits',
  consent: false,
  ...(selection?.modelRequest ? { modelRequest: selection.modelRequest } : {}),
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
    ...(fields.modelRequest ? { modelRequest: fields.modelRequest } : {}),
  });
function PlanningControls({
  value,
  onChange,
  snapshot,
}: {
  value: PlanningFields;
  onChange: (value: PlanningFields) => void;
  snapshot: Pick<Snapshot, 'nativeProfiles'>;
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
  registerRetry,
  onCreated,
  onManual,
  text,
  onTextChange,
}: {
  text: string;
  onTextChange: (text: string) => void;
  snapshot: Pick<Snapshot, 'projects' | 'nativeProfiles'>;
  workspace: Workspace;
  registerRetry?: RegisterComposerRetry;
  onCreated: (id: string, submitted: string) => void;
  onManual: () => void;
}) {
  const [chosenProject, setProjectId] = useState(
    pendingGoalProject() ?? snapshot.projects[0]?.id ?? '',
  );
  const projectId = snapshot.projects.some((project) => project.id === chosenProject)
    ? chosenProject
    : (snapshot.projects[0]?.id ?? '');
  const [planning, setPlanning] = useState(() => initialPlanning());
  useEffect(() => {
    if (projectId) setPlanning((value) => (value.consent ? { ...value, consent: false } : value));
  }, [projectId]);
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
    registerRetry,
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
                ? `Planning profile unavailable. ${reasonText(profile?.reason ?? 'not-configured')}`
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
            {planning.concurrency} active model {planning.concurrency === '1' ? 'agent' : 'agents'}
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
            controls: {
              ...context.controls,
              ...planningComposerControls(snapshot, planning.role),
              disconnectedReason:
                workspace.connection !== 'connected'
                  ? 'Reconnect to use composer actions.'
                  : undefined,
            },
            contextMeter: (
              <ContextGauge
                usedTokens={null}
                capacityTokens={null}
                measurement="unknown"
                unavailableReason="Goal not sent. Context usage is unknown until a planning turn reports a measurement."
              />
            ),
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
  registerRetry,
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
  registerRetry?: RegisterComposerRetry;
  onState: (state: TaskConversationState | null) => void;
  onPrepare: (seed?: ExecutionPolicySeed) => void;
}) {
  const history = useConversation(task, workspace, visible);
  const { state, entries } = history;
  const [settings, setSettings] = useState(false);
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null);
  const [planning, setPlanning] = useState(() => initialPlanning());
  const [pendingDecision, setPendingDecision] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string>();
  const [settingsRetry, setSettingsRetry] = useState(false);
  const [settingsConfigurationRevision, setSettingsConfigurationRevision] = useState<number | null>(
    null,
  );
  const [settingsCommand, setSettingsCommand] = useState<Extract<
    DesktopCommand,
    { command: 'ConfigureTaskConversation' }
  > | null>(null);
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
    registerRetry,
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
            resolution:
              state?.adoptedProposal?.id === entry.id
                ? state.contractStatus === 'confirmed' && adoptedPlanCurrent(state)
                  ? 'Plan adopted.'
                  : 'Adopted earlier. Execution preparation needs a current adopted plan.'
                : undefined,
            choices: [
              {
                id: 'adopt',
                label: 'Adopt plan',
                tone: 'primary',
                disabledReason:
                  state?.proposal?.id !== entry.id
                    ? reasonText('proposal-not-current')
                    : !current
                      ? (decisionBlockedReason ?? 'Refreshing the current conversation state.')
                      : state.adopt.available
                        ? undefined
                        : reasonText(state.adopt.reason),
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
          title: actionName(approval.action),
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
  const choices = state?.modelChoices;
  const modelChoicesReason =
    !choices || choices.status === 'not-observed'
      ? 'Model choices appear after a successful planning turn.'
      : choices.status === 'client-changed'
        ? 'The installed client changed. Use the profile default for a normal planning turn to observe choices again.'
        : choices.status === 'unavailable'
          ? `Model choices are unavailable. ${reasonText(choices.reason)} Use the profile default to recover.`
          : `Choices last observed at ${choices.observedAt}. Availability is checked again before the next planning turn.${choices.reason === 'available' ? '' : ` ${reasonText(choices.reason)}`}`;
  const stageBlocked =
    decisionBlockedReason ??
    (state?.phase === 'unknown' || state?.phase === 'stopping'
      ? 'Resolve current work before changing the planning request.'
      : choices?.status !== 'last-observed' || !choices.observation
        ? modelChoicesReason
        : undefined);
  function requestFor(model: string, effort: string): ConversationModelRequest | undefined {
    if (stageBlocked || !choices?.observation) return;
    if (!choices.models.some((choice) => choice.model === model && choice.efforts.includes(effort)))
      return;
    return { version: 1, observation: { ...choices.observation }, model, effort };
  }
  function openSettings(request?: ConversationModelRequest) {
    if (!settingsRetry) {
      setSettingsError(undefined);
      setSettingsCommand(null);
      setSettingsConfigurationRevision(config?.revision ?? null);
      setPlanning({
        ...initialPlanning(config?.selection),
        ...(request ? { modelRequest: request } : {}),
      });
    }
    setSettings(true);
  }
  function stageModel(model: string) {
    const choice = choices?.models.find((choice) => choice.model === model);
    if (!choice) return;
    const request = requestFor(model, choice.defaultEffort);
    if (request) openSettings(request);
  }
  function stageEffort(effort: string) {
    const model = config?.selection.modelRequest
      ? config.requestedModel
      : (config?.effectiveModel ?? config?.requestedModel);
    if (!model) return;
    const request = requestFor(model, effort);
    if (request) openSettings(request);
  }
  function editPair(model: string, effort: string) {
    const request = requestFor(model, effort);
    if (request) setPlanning((value) => ({ ...value, modelRequest: request, consent: false }));
  }
  const combinedTask = snapshot.combinedRuns.some(
    (run) => run.taskId === task.id || run.members.some((member) => member.taskId === task.id),
  );
  const executionRun =
    state?.purpose === 'execution' ? snapshot.runs.find((run) => run.id === task.runId) : undefined;
  const executionPolicyReason = combinedTask
    ? 'Choose execution authority in Combined task preparation.'
    : (decisionBlockedReason ??
      (executionRun
        ? 'The saved execution policy is frozen. Review it in execution preparation.'
        : task.state !== 'draft'
          ? 'Execution preparation opens when planning returns the task to draft.'
          : !config
            ? 'Use Prepare run to choose execution authority for this task.'
            : state?.contractStatus !== 'confirmed'
              ? 'Adopt the task plan before choosing execution preparation.'
              : !adoptedPlanCurrent(state)
                ? state.adopt.available
                  ? 'A newer plan replaced the adopted one. Adopt it before preparing execution.'
                  : `The adopted plan cannot be prepared now. ${reasonText(state.adopt.reason)}`
                : state.activeAttempt || state.phase === 'unknown' || state.phase === 'stopping'
                  ? 'Resolve current work before preparing execution.'
                  : undefined));
  const executionPolicy: ComposerControlsProps['policy'] = combinedTask
    ? {
        label: 'Future execution policy',
        currentId: 'combined',
        options: [{ id: 'combined', label: 'Combined task preparation' }],
        scopeLabel: 'Combined task only',
        disabledReason: executionPolicyReason,
      }
    : {
        label: 'Future execution policy',
        currentId: executionRun?.policy.policy.authority ?? 'unprepared',
        options: [
          {
            id: 'unprepared',
            label: 'Not prepared',
          },
          {
            id: 'guided',
            label: 'Guided',
            detail:
              'Local requires Guided. Native file and repository runs keep their reviewed permissions.',
          },
          {
            id: 'balanced',
            label: 'Balanced',
            detail:
              'Google ACP accepts Balanced. Local requires Guided; native file and repository permissions stay as reviewed.',
          },
          {
            id: 'autopilot',
            label: 'Autopilot',
            detail:
              'Google ACP and Local refuse Autopilot. Native file and repository permissions stay as reviewed.',
          },
        ],
        scopeLabel: 'Opens a future execution draft. Planning stays read-only.',
        disabledReason: executionPolicyReason,
        onSelect: (authority) => {
          if (
            !executionPolicyReason &&
            config &&
            (authority === 'guided' || authority === 'balanced' || authority === 'autopilot')
          )
            onPrepare({
              taskId: task.id,
              taskRevision: task.revision,
              planningConfigurationRevision: config.revision,
              authority,
            });
        },
      };
  const primaryActive = Boolean(
    workspace.connection === 'connected' &&
      current &&
      state?.purpose === 'conversation' &&
      state.phase === 'planning' &&
      state.currentRunId === task.runId &&
      state.activeAttempt?.runId === state.currentRunId &&
      state.activeAttempt?.routeId === config?.routeId &&
      ['intent', 'running'].includes(state.activeAttempt?.state ?? ''),
  );
  const contextUsage = current ? state?.contextUsage : null;
  const contextActivity =
    workspace.connection !== 'connected'
      ? 'Reconnect to inspect current activity.'
      : !current
        ? 'Refreshing current conversation activity.'
        : state?.phase === 'unknown'
          ? 'Current conversation activity is unknown.'
          : state?.phase === 'stopping'
            ? 'The current work is stopping.'
            : primaryActive
              ? 'The primary role is planning.'
              : state?.activeAttempt
                ? 'Task work is active. Primary role activity is unknown.'
                : state?.pendingQuestions.length
                  ? 'Waiting for an answer.'
                  : snapshot.approvals.some(
                        (approval) => approval.taskId === task.id && approval.status === 'pending',
                      )
                    ? 'Waiting for a permission decision.'
                    : 'The primary role is idle.';
  const selection = planningSelection(planning);
  // Only the same selection with equal or lower limits keeps the adopted contract.
  const materialChange = Boolean(
    config &&
      selection.success &&
      (canonicalJson({ ...selection.data, limits: config.selection.limits }) !==
        canonicalJson(config.selection) ||
        (['attempts', 'minutes', 'concurrency'] as const).some(
          (axis) => selection.data.limits[axis] > config.selection.limits[axis],
        )),
  );
  const requestChanged =
    canonicalJson(planning.modelRequest ?? null) !==
    canonicalJson(config?.selection.modelRequest ?? null);
  const requestCurrent =
    !requestChanged ||
    !planning.modelRequest ||
    (choices?.status === 'last-observed' &&
      choices.observation &&
      canonicalJson(choices.observation) === canonicalJson(planning.modelRequest.observation) &&
      choices.models.some(
        (choice) =>
          choice.model === planning.modelRequest?.model &&
          choice.efforts.includes(planning.modelRequest.effort),
      ));
  const settingsBlocked =
    decisionBlockedReason ??
    ((config?.revision ?? null) !== settingsConfigurationRevision
      ? 'The saved planning settings changed. Close and reopen this dialog to review them. Your draft has been kept.'
      : state?.purpose === 'execution' && materialChange
        ? reasonText('task-not-discussing')
        : state?.activeAttempt || state?.phase === 'unknown' || state?.phase === 'stopping'
          ? 'This draft applies after current work stops. Save it explicitly at that boundary.'
          : !requestCurrent
            ? 'The observed model choices changed. Review and select the pair again before saving.'
            : undefined);
  async function configure() {
    if (!planning.consent || !selection.success || settingsBlocked) return;
    setSettingsError(undefined);
    setSettingsRetry(false);
    const command: Extract<DesktopCommand, { command: 'ConfigureTaskConversation' }> = {
      command: 'ConfigureTaskConversation',
      expectedRevision: task.revision,
      payload: { taskId: task.id, planning: selection.data },
    };
    setSettingsCommand(command);
    const result = await mutate(command);
    if (result && applied(result.outcome)) {
      setSettings(false);
      setSettingsCommand(null);
    } else {
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
            state?.purpose === 'conversation' ? (
              'Planning route unqualified. Execution needs a separate decision.'
            ) : task.next ? (
              <TaskNext text={task.next} />
            ) : undefined
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
            controls: visible
              ? {
                  ...context.controls,
                  ...planningComposerControls(snapshot, config?.selection.role ?? null, config, {
                    choices,
                    disabledReason: stageBlocked,
                    onSelectModel: stageModel,
                    onSelectEffort: stageEffort,
                  }),
                  policy: executionPolicy,
                  disconnectedReason:
                    workspace.connection !== 'connected'
                      ? 'Reconnect to use composer actions.'
                      : undefined,
                }
              : undefined,
            contextMeter: visible ? (
              <ContextGauge
                usedTokens={contextUsage?.usedTokens ?? null}
                capacityTokens={contextUsage?.capacityTokens ?? null}
                measurement={contextUsage ? 'last-observed' : 'unknown'}
                measuredAt={contextUsage?.observedAt}
                updating={primaryActive}
                unavailableReason={
                  contextUsage
                    ? contextUsage.capacityTokens === null
                      ? `The provider reported used tokens without context capacity. ${contextActivity}`
                      : undefined
                    : `No retained context usage is associated with this run and model. ${contextActivity}`
                }
              />
            ) : undefined,
            hint:
              state?.send.disposition === 'queue'
                ? state.purpose === 'execution'
                  ? 'Messages are saved as guidance. The current execution run and result stay current.'
                  : 'Guidance joins the next planning turn.'
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
          onOpenSettings={() => openSettings()}
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
                  if (!settingsCommand) return;
                  void workspace
                    .retryCommand(settingsCommand)
                    .then((result) => {
                      if (result && applied(result.outcome)) {
                        setSettings(false);
                        setSettingsRetry(false);
                        setSettingsCommand(null);
                        setSettingsError(undefined);
                      } else {
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
            {settingsRetry && !workspace.retryAvailable && !workspace.pending && (
              <button
                className="button secondary"
                type="button"
                onClick={() => {
                  setSettingsRetry(false);
                  setSettingsCommand(null);
                  setSettingsError(undefined);
                  setSettingsConfigurationRevision(config?.revision ?? null);
                  setPlanning(initialPlanning(config?.selection));
                }}
              >
                Review saved planning settings
              </button>
            )}
            <PlanningControls
              value={planning}
              onChange={(value) => setPlanning({ ...value, consent: false })}
              snapshot={snapshot}
            />
            <p className="muted small">{modelChoicesReason}</p>
            <p className="muted small" style={{ overflowWrap: 'anywhere' }}>
              Requested model {config?.requestedModel ?? 'unknown'} · Effective model{' '}
              {config?.effectiveModel ?? 'unknown'} · Requested effort{' '}
              {config?.requestedEffort ?? 'unknown'} · Effective effort{' '}
              {config?.effectiveEffort ?? 'unknown'}
            </p>
            {choices?.status === 'last-observed' && (
              <>
                <label>
                  Planning model
                  <select
                    disabled={Boolean(stageBlocked || settingsRetry)}
                    value={
                      choices.models.some((choice) => choice.model === planning.modelRequest?.model)
                        ? planning.modelRequest?.model
                        : ''
                    }
                    onChange={(event) => {
                      const choice = choices.models.find(
                        (choice) => choice.model === event.target.value,
                      );
                      if (choice) editPair(choice.model, choice.defaultEffort);
                    }}
                  >
                    <option value="" disabled>
                      Choose a last-observed model
                    </option>
                    {choices.models.map((choice) => (
                      <option key={choice.model} value={choice.model}>
                        {choice.model}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Planning effort
                  <select
                    disabled={Boolean(stageBlocked || settingsRetry || !planning.modelRequest)}
                    value={
                      choices.models
                        .find((choice) => choice.model === planning.modelRequest?.model)
                        ?.efforts.includes(planning.modelRequest?.effort ?? '')
                        ? planning.modelRequest?.effort
                        : ''
                    }
                    onChange={(event) => {
                      if (planning.modelRequest)
                        editPair(planning.modelRequest.model, event.target.value);
                    }}
                  >
                    <option value="" disabled>
                      Choose an advertised effort
                    </option>
                    {choices.models
                      .find((choice) => choice.model === planning.modelRequest?.model)
                      ?.efforts.map((effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ))}
                  </select>
                </label>
              </>
            )}
            <p style={{ overflowWrap: 'anywhere' }}>
              Draft request:{' '}
              {planning.modelRequest
                ? `${planning.modelRequest.model} · ${planning.modelRequest.effort}`
                : 'Profile default'}
              . Saving starts no work. The next turn checks availability again.
            </p>
            {materialChange && state?.contractStatus === 'confirmed' && (
              <p className="notice" role="status">
                {state.purpose === 'execution'
                  ? 'The execution run stays current. Material planning changes cannot be saved here.'
                  : 'Saving this change returns the task to planning. Execution preparation then needs a newly proposed and adopted plan.'}
              </p>
            )}
            <button
              className="button secondary"
              type="button"
              disabled={
                !planning.modelRequest ||
                workspace.pending ||
                workspace.retryAvailable ||
                settingsRetry
              }
              onClick={() =>
                setPlanning((value) => ({ ...value, modelRequest: undefined, consent: false }))
              }
            >
              Use profile default
            </button>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={planning.consent}
                onChange={(event) => setPlanning({ ...planning, consent: event.target.checked })}
              />
              Allow bounded planning with this profile and these limits
            </label>
            <p className="muted small">
              Planning remains read-only. The controller rechecks the configuration at a safe
              boundary. Saved execution limits and permissions keep their own review.
            </p>
            {settingsBlocked && (
              <p className="notice" role="status">
                {settingsBlocked}
              </p>
            )}
            <button
              className="button secondary"
              type="button"
              disabled={
                !current ||
                state?.contractStatus !== 'confirmed' ||
                !adoptedPlanCurrent(state) ||
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
                Boolean(settingsBlocked) ||
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
