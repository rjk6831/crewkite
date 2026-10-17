import type { Approval } from '@crewkite/contracts';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Circle,
  Clock,
  MessageSquare,
  Settings2,
  ShieldCheck,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import './conversation.css';

export type ConversationStage = {
  id: string;
  label: string;
  state: 'pending' | 'running' | 'waiting' | 'completed' | 'stopped' | 'unknown' | 'failed';
  detail?: string;
};

export type ConversationChoice = {
  id: string;
  label: string;
  tone?: 'primary' | 'secondary' | 'danger';
  disabledReason?: string;
};

type DecisionBase = {
  id: string;
  title: string;
  text: string;
  facts?: { label: string; value: string }[];
  pending?: boolean;
  resolution?: string;
};

export type ConversationDecision = DecisionBase &
  (
    | {
        kind: 'question';
        answerLabel: string;
        placeholder?: string;
        choices?: ConversationChoice[];
      }
    | {
        kind: 'plan';
        criteria: string[];
        slices?: { id: string; title: string; role: string; dependsOn: string[] }[];
        choices: ConversationChoice[];
      }
    | { kind: 'approval'; approval: Approval }
  );

export type ConversationMessage = {
  id: string;
  kind: 'user' | 'primary' | 'role' | 'system';
  author: string;
  role?: string;
  route?: string;
  model?: string;
  effort?: string;
  at?: string;
  text: string;
  delivery?: 'pending' | 'queued' | 'included' | 'unknown' | 'failed';
  stages?: ConversationStage[];
  decision?: ConversationDecision;
};

export type ConversationProps = {
  conversationId: string;
  messages: ConversationMessage[];
  primary: { name: string; role: string; route?: string; model?: string; effort?: string } | null;
  status: string;
  next?: string;
  activeWorkers?: number;
  maximumWorkers?: number;
  loading?: boolean;
  error?: string;
  composer: {
    value: string;
    onChange: (value: string) => void;
    onSend: (text: string) => void;
    sending?: boolean;
    disabledReason?: string;
    placeholder?: string;
    hint?: string;
  };
  onChoice?: (decisionId: string, choiceId: string) => void;
  onAnswer?: (questionId: string, text: string) => void;
  onApproval?: (approval: Approval, decision: 'approved' | 'denied') => void;
  onOpenSettings?: () => void;
};

const deliveryLabel = {
  pending: 'Saving',
  queued: 'Queued for the next safe boundary',
  included: 'Included in input',
  unknown: 'Delivery unknown',
  failed: 'Message was not saved',
};

function conversationTextError(text: string): string | null {
  if (!text.isWellFormed()) return 'Use valid Unicode text before sending.';
  if (text.includes('\0')) return 'Remove null characters before sending.';
  if (new TextEncoder().encode(text).length > 4096)
    return 'Keep the text within 4,096 UTF-8 bytes.';
  return null;
}

function StageIcon({ state }: { state: ConversationStage['state'] }) {
  const Icon =
    state === 'completed'
      ? Check
      : state === 'unknown' || state === 'failed'
        ? TriangleAlert
        : state === 'pending' || state === 'waiting'
          ? Clock
          : Circle;
  return <Icon size={13} aria-hidden="true" />;
}

function DecisionCard({
  decision,
  onChoice,
  onAnswer,
  onApproval,
  disabled,
}: {
  decision: ConversationDecision;
  onChoice: ConversationProps['onChoice'];
  onAnswer: ConversationProps['onAnswer'];
  onApproval: ConversationProps['onApproval'];
  disabled: boolean;
}) {
  const [answer, setAnswer] = useState('');
  const titleId = useId();
  const answerErrorId = useId();
  const answerError = conversationTextError(answer);
  const busy = Boolean(disabled || decision.pending || decision.resolution);
  const choices = decision.kind === 'approval' ? [] : (decision.choices ?? []);
  return (
    <section
      className={`conversation-decision decision-${decision.kind}`}
      aria-labelledby={titleId}
    >
      <div className="conversation-decision-kind">
        {decision.kind === 'approval' ? <ShieldCheck size={14} /> : <MessageSquare size={14} />}
        {decision.kind === 'question'
          ? 'Question'
          : decision.kind === 'plan'
            ? 'Proposed plan'
            : 'Permission request'}
      </div>
      <h3 id={titleId}>{decision.title}</h3>
      <p>{decision.text}</p>
      {decision.kind === 'plan' && decision.criteria.length > 0 && (
        <ul className="conversation-criteria">
          {[...new Set(decision.criteria)].map((criterion) => (
            <li key={criterion}>{criterion}</li>
          ))}
        </ul>
      )}
      {decision.kind === 'plan' && Boolean(decision.slices?.length) && (
        <details className="conversation-plan-slices">
          <summary>Work slices ({decision.slices?.length})</summary>
          <ol>
            {decision.slices?.map((slice) => (
              <li key={slice.id}>
                <span>{slice.title}</span>
                <small>
                  {slice.role}
                  {slice.dependsOn.length > 0 && ` · After ${slice.dependsOn.join(', ')}`}
                </small>
              </li>
            ))}
          </ol>
        </details>
      )}
      {decision.kind === 'approval' && (
        <dl className="conversation-decision-facts">
          <div>
            <dt>Requester</dt>
            <dd>{decision.approval.requester}</dd>
          </div>
          <div>
            <dt>Action</dt>
            <dd>{decision.approval.action}</dd>
          </div>
          <div>
            <dt>Target</dt>
            <dd>
              <code>{decision.approval.target}</code>
            </dd>
          </div>
          <div>
            <dt>Consequence</dt>
            <dd>{decision.approval.consequence}</dd>
          </div>
          {decision.approval.acpTarget && (
            <>
              <div>
                <dt>Session</dt>
                <dd>
                  <code>{decision.approval.acpTarget.sessionId}</code>
                </dd>
              </div>
              <div>
                <dt>Tool call</dt>
                <dd>
                  <code>{decision.approval.acpTarget.toolCallId}</code>
                </dd>
              </div>
              <div>
                <dt>Permission</dt>
                <dd>
                  Allow once · <code>{decision.approval.acpTarget.optionId}</code>
                </dd>
              </div>
            </>
          )}
          <div>
            <dt>Attempt</dt>
            <dd>
              <code>{decision.approval.attemptId}</code> · Generation {decision.approval.generation}
            </dd>
          </div>
        </dl>
      )}
      {Boolean(decision.facts?.length) && (
        <dl className="conversation-decision-facts">
          {decision.facts?.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {decision.resolution ? (
        <p className="conversation-decision-resolution" role="status">
          <Check size={14} />
          {decision.resolution}
        </p>
      ) : decision.kind === 'approval' ? (
        decision.approval.status === 'pending' ? (
          <div className="conversation-decision-actions">
            <button
              className="button secondary"
              type="button"
              disabled={busy || !onApproval}
              onClick={() => onApproval?.(decision.approval, 'denied')}
            >
              Deny
            </button>
            <button
              className="button primary"
              type="button"
              disabled={busy || !onApproval}
              onClick={() => onApproval?.(decision.approval, 'approved')}
            >
              <ShieldCheck size={14} />
              Approve this request
            </button>
          </div>
        ) : (
          <p className="conversation-decision-resolution">
            {decision.approval.status === 'approved' ? 'Approved' : 'Denied'}
          </p>
        )
      ) : (
        <>
          {decision.kind === 'question' && (
            <form
              className="conversation-answer"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy && !answerError && answer.trim()) onAnswer?.(decision.id, answer.trim());
              }}
            >
              <label>
                {decision.answerLabel}
                <textarea
                  rows={2}
                  value={answer}
                  disabled={busy || !onAnswer}
                  placeholder={decision.placeholder}
                  aria-invalid={Boolean(answerError)}
                  aria-describedby={answerError ? answerErrorId : undefined}
                  onChange={(event) => setAnswer(event.target.value)}
                />
              </label>
              {answerError && (
                <p className="conversation-error" role="alert" id={answerErrorId}>
                  <TriangleAlert size={14} />
                  {answerError}
                </p>
              )}
              <button
                className="button primary"
                type="submit"
                disabled={busy || !onAnswer || !answer.trim() || Boolean(answerError)}
              >
                Send answer
                <ArrowUp size={14} />
              </button>
            </form>
          )}
          {choices.length > 0 && (
            <div className="conversation-decision-actions">
              {choices.map((choice) => (
                <span className="conversation-choice" key={choice.id}>
                  <button
                    className={`button ${choice.tone ?? 'secondary'}`}
                    type="button"
                    disabled={busy || !onChoice || Boolean(choice.disabledReason)}
                    onClick={() => onChoice?.(decision.id, choice.id)}
                  >
                    {choice.label}
                  </button>
                  {choice.disabledReason && <small>{choice.disabledReason}</small>}
                </span>
              ))}
            </div>
          )}
        </>
      )}
      {decision.pending && (
        <p className="conversation-decision-pending" role="status">
          Saving the decision. Waiting for confirmation.
        </p>
      )}
    </section>
  );
}

export function Conversation({
  conversationId,
  messages,
  primary,
  status,
  next,
  activeWorkers,
  maximumWorkers,
  loading = false,
  error,
  composer,
  onChoice,
  onAnswer,
  onApproval,
  onOpenSettings,
}: ConversationProps) {
  const transcript = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const previousConversation = useRef(conversationId);
  const [newMessages, setNewMessages] = useState(false);
  const composerId = useId();
  useEffect(() => {
    const element = transcript.current;
    if (!element) return;
    if (previousConversation.current !== conversationId) {
      previousConversation.current = conversationId;
      follow.current = true;
    }
    if (messages.length === 0) {
      setNewMessages(false);
      return;
    }
    if (follow.current) {
      element.scrollTop = element.scrollHeight;
      setNewMessages(false);
    } else {
      setNewMessages(true);
    }
  }, [conversationId, messages]);
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    if (composer.value) element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [composer.value]);
  const composerError = conversationTextError(composer.value);
  const disabled = Boolean(composer.disabledReason || composer.sending || loading || composerError);
  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!disabled && composer.value.trim()) composer.onSend(composer.value.trim());
  }
  return (
    <section className="conversation" aria-label="Task conversation">
      <div className="conversation-context">
        <div className="conversation-primary-avatar" aria-hidden="true">
          <MessageSquare size={17} />
        </div>
        <div className="conversation-primary">
          <strong>{primary?.name ?? 'Primary role unassigned'}</strong>
          <span>
            {primary
              ? [primary.role, primary.route, primary.model, primary.effort]
                  .filter(Boolean)
                  .join(' · ')
              : 'Choose the primary role in session settings.'}
          </span>
        </div>
        {activeWorkers !== undefined && maximumWorkers !== undefined && (
          <span className="conversation-workers">
            <Users size={13} aria-hidden="true" />
            {activeWorkers}/{maximumWorkers}
            <span className="conversation-sr-only"> active model agents</span>
          </span>
        )}
        {onOpenSettings && (
          <button
            className="conversation-settings"
            type="button"
            onClick={onOpenSettings}
            aria-label="Open session settings"
          >
            <Settings2 size={15} aria-hidden="true" />
            <span>Session settings</span>
          </button>
        )}
      </div>
      <div className="conversation-history-wrap">
        <div
          ref={transcript}
          className="conversation-history"
          role="log"
          aria-label="Conversation history"
          aria-live="polite"
          aria-relevant="additions"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The transcript needs a keyboard scroll target beside its inline controls.
          tabIndex={0}
          onScroll={() => {
            const element = transcript.current;
            if (!element) return;
            follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
            if (follow.current) setNewMessages(false);
          }}
        >
          <div className="conversation-thread">
            {loading && (
              <div className="conversation-empty" role="status">
                <Clock size={25} />
                <h2>Loading the conversation</h2>
                <p>Restoring saved messages and pending decisions.</p>
              </div>
            )}
            {!loading && messages.length === 0 && (
              <div className="conversation-empty">
                <span className="conversation-empty-mark">
                  <MessageSquare size={27} />
                </span>
                <h2>Describe the work</h2>
                <p>Start with the outcome and anything that must stay within scope.</p>
                <span>Questions, proposed plans and decisions appear here.</span>
              </div>
            )}
            {messages.map((message) => (
              <article className={`conversation-message message-${message.kind}`} key={message.id}>
                <div className="conversation-message-avatar" aria-hidden="true">
                  {message.kind === 'user' ? (
                    'Y'
                  ) : message.kind === 'primary' ? (
                    <MessageSquare size={16} />
                  ) : message.kind === 'role' ? (
                    <Users size={15} />
                  ) : (
                    <Circle size={11} />
                  )}
                </div>
                <div className="conversation-message-content">
                  <header>
                    <strong>{message.author}</strong>
                    {message.role && <span className="conversation-role">{message.role}</span>}
                    {message.at && (
                      <time dateTime={message.at}>
                        {new Date(message.at).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    )}
                  </header>
                  {(message.route || message.model || message.effort) && (
                    <div className="conversation-message-route">
                      {[message.route, message.model, message.effort].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  {message.text && <div className="conversation-message-text">{message.text}</div>}
                  {message.delivery && (
                    <p className={`conversation-delivery delivery-${message.delivery}`}>
                      <StageIcon
                        state={
                          message.delivery === 'unknown' || message.delivery === 'failed'
                            ? message.delivery
                            : message.delivery === 'included'
                              ? 'completed'
                              : 'pending'
                        }
                      />
                      {deliveryLabel[message.delivery]}
                    </p>
                  )}
                  {Boolean(message.stages?.length) && (
                    <details className="conversation-stages">
                      <summary>
                        <ChevronRight size={13} aria-hidden="true" />
                        Worker activity<span>{message.stages?.length} stages</span>
                      </summary>
                      <ol>
                        {message.stages?.map((stage) => (
                          <li className={`stage-${stage.state}`} key={stage.id}>
                            <StageIcon state={stage.state} />
                            <div>
                              <strong>{stage.label}</strong>
                              <span>{stage.state.replaceAll('_', ' ')}</span>
                              {stage.detail && <p>{stage.detail}</p>}
                            </div>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                  {message.decision && (
                    <DecisionCard
                      key={message.decision.id}
                      decision={message.decision}
                      onChoice={onChoice}
                      onAnswer={onAnswer}
                      onApproval={onApproval}
                      disabled={loading}
                    />
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
        {newMessages && (
          <button
            type="button"
            className="conversation-new-messages"
            onClick={() => {
              if (transcript.current)
                transcript.current.scrollTop = transcript.current.scrollHeight;
              follow.current = true;
              setNewMessages(false);
            }}
          >
            <ArrowDown size={13} />
            Latest messages
          </button>
        )}
      </div>
      <div className="conversation-bottom">
        <div className="conversation-state" role="status">
          <span className="conversation-state-dot" />
          <strong>{status}</strong>
          {next && <span>{next}</span>}
        </div>
        {error && (
          <p className="conversation-error" role="alert">
            <TriangleAlert size={14} />
            {error}
          </p>
        )}
        {composerError && (
          <p className="conversation-error" role="alert" id={`${composerId}-error`}>
            <TriangleAlert size={14} />
            {composerError}
          </p>
        )}
        <form className="conversation-composer" onSubmit={send}>
          <label className="conversation-sr-only" htmlFor={composerId}>
            Message the primary role
          </label>
          <textarea
            ref={textarea}
            id={composerId}
            rows={3}
            value={composer.value}
            disabled={Boolean(composer.disabledReason) || loading}
            aria-invalid={Boolean(composerError)}
            aria-describedby={`${composerId}-hint${composerError ? ` ${composerId}-error` : ''}`}
            placeholder={
              composer.placeholder ?? 'Describe the work, ask a question, or add guidance…'
            }
            onChange={(event) => composer.onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="conversation-composer-footer">
            <span id={`${composerId}-hint`}>
              {composer.disabledReason ??
                composer.hint ??
                'Messages stay within the approved task scope.'}
            </span>
            <button
              type="submit"
              disabled={disabled || !composer.value.trim()}
              aria-label={composer.sending ? 'Saving message' : 'Send message'}
            >
              <ArrowUp size={17} aria-hidden="true" />
            </button>
          </div>
        </form>
        <div className="conversation-composer-note">
          <span>
            {composer.sending
              ? 'Saving message. Waiting for confirmation.'
              : 'Plans and permissions require a separate decision.'}
          </span>
          <span>Enter to send · Shift+Enter for a new line</span>
        </div>
      </div>
    </section>
  );
}
