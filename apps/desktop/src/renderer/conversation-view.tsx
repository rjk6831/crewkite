import {
  type ConversationEntry,
  type ConversationPlanningSelection,
  ConversationPlanningSelectionSchema,
  type Snapshot,
  type Task,
  type TaskConversationState,
} from '@crewkite/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, familyName, titleCase } from './components.tsx';
import { Conversation, type ConversationMessage } from './conversation.tsx';
import type { DesktopCommand, Workspace } from './source.ts';
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
  const blocked =
    workspace.connection !== 'connected'
      ? 'Reconnect to send the goal.'
      : workspace.retryAvailable
        ? 'Resolve the uncertain command with exact retry.'
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
    try {
      const result = await workspace.command({
        command: 'CreateTaskDiscussion',
        expectedRevision: 0,
        payload: { projectId, text: goal, planning: selection.data },
      });
      if (applied(result.outcome) && result.entity && 'state' in result.entity)
        onCreated(result.entity.id, text);
    } catch {}
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
          status="Goal not sent"
          next="Planning route unqualified. Describe the outcome; the lead can propose criteria."
          composer={{
            value: text,
            onChange: onTextChange,
            onSend: (goal) => void create(goal),
            sending: workspace.pending,
            disabledReason: blocked,
          }}
          error={workspace.error ?? undefined}
        />
      </div>
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
  const blocked =
    workspace.connection !== 'connected'
      ? 'Reconnect to send a message.'
      : workspace.retryAvailable
        ? 'Resolve the uncertain command with exact retry.'
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
    const submitted = draft;
    const result = await mutate({
      command: state.send.disposition === 'queue' ? 'QueueTaskGuidance' : 'SendTaskMessage',
      expectedRevision: task.revision,
      payload: { taskId: task.id, text },
    });
    if (result && applied(result.outcome)) onDraftSaved(submitted);
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
          detailsStatus={history.historyNotice ? 'History refreshed' : undefined}
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
          error={history.error}
          onLoadEarlier={history.before ? history.loadEarlier : undefined}
          loadingEarlier={history.earlier}
          historyBlocked={history.reading || workspace.pending}
          composer={{
            value: draft,
            onChange: onDraftChange,
            onSend: (text) => void send(text),
            sending: workspace.pending,
            disabledReason: blocked,
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
