import type { ChatCatalogRead, ChatFailure, ChatModelSelection } from '@crewkite/contracts';
import {
  Brain,
  Check,
  ChevronRight,
  CircleX,
  FileSearch,
  FileText,
  LoaderCircle,
  Pencil,
  Search,
  ShieldQuestion,
  Terminal,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { familyName } from '../components.tsx';
import { formatSpan } from '../usage-gauges.tsx';
import type { TryWithChoice } from './file-fit.ts';
import { ModelPicker } from './model-picker.tsx';
import {
  type PermissionBlock,
  runLabel,
  type ThinkingBlock,
  type ToolBlock,
  type ToolRun,
} from './turn-fold.ts';

const toolIcons = {
  read: FileText,
  search: Search,
  edit: Pencil,
  command: Terminal,
  other: Wrench,
} as const;

const lastLine = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? '';

// A finished block with no text never reaches this card; viewBlocks leaves it out. A live one with
// no text yet has nothing to open.
export function ThinkingCard({ block, ended }: { block: ThinkingBlock; ended: boolean }) {
  const [open, setOpen] = useState(false);
  const live = !block.done && !ended;
  const hasBody = block.text.trim() !== '';
  return (
    <div className={live ? 'th-card th-thinking is-live' : 'th-card th-thinking'}>
      <button
        type="button"
        aria-expanded={hasBody ? open : undefined}
        disabled={!hasBody}
        onClick={() => setOpen(!open)}
      >
        <Brain size={14} aria-hidden="true" />
        <span className="th-card-title">{live ? 'Thinking' : 'Thought'}</span>
        {!open && <span className="th-preview">{lastLine(block.text)}</span>}
        {hasBody && <ChevronRight size={14} className="th-chevron" aria-hidden="true" />}
      </button>
      {open && hasBody && <div className="th-thinking-body">{block.text}</div>}
    </div>
  );
}

const statusText = { ok: 'Done', error: 'Failed', denied: 'Denied', stopped: 'Stopped' } as const;

function StatusMark({ status }: { status: ToolBlock['status'] }): ReactNode {
  if (status === 'running')
    return <LoaderCircle size={14} className="th-spin" aria-label="Running" />;
  if (status === 'ok') return <Check size={14} aria-label={statusText.ok} />;
  return <CircleX size={14} aria-label={statusText[status]} />;
}

function MiniDiff({ patch }: { patch: string }) {
  const lines = patch.split('\n').filter((line) => !/^(diff |index |--- |\+\+\+ )/.test(line));
  const shown = lines.slice(0, 10);
  return (
    <pre className="th-diff">
      {shown.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity beyond their position
        <span key={index} className={lineClass(line)}>
          {line || ' '}
        </span>
      ))}
      {lines.length > shown.length && (
        <span className="th-diff-more">{lines.length - shown.length} more lines</span>
      )}
    </pre>
  );
}

export const lineClass = (line: string) =>
  line.startsWith('+')
    ? 'is-add'
    : line.startsWith('-')
      ? 'is-del'
      : line.startsWith('@@')
        ? 'is-hunk'
        : '';

export function ToolCard({
  block,
  onOpenChanges,
}: {
  block: ToolBlock;
  onOpenChanges: (path: string) => void;
}) {
  const Icon = toolIcons[block.toolKind];
  const [override, setOverride] = useState<boolean | null>(null);
  const hasBody = block.output !== '' || block.summary !== null;
  const open = override ?? (block.status === 'running' && block.output !== '');
  return (
    <div className={`th-card th-tool is-${block.status}`}>
      <button
        type="button"
        aria-expanded={hasBody ? open : undefined}
        disabled={!hasBody}
        onClick={() => setOverride(!open)}
      >
        <Icon size={14} aria-hidden="true" />
        <span className="th-card-title" title={block.title}>
          {block.title}
        </span>
        <span className="th-tool-status">
          <StatusMark status={block.status} />
        </span>
        {hasBody && <ChevronRight size={14} className="th-chevron" aria-hidden="true" />}
      </button>
      {block.diff?.patch && <MiniDiff patch={block.diff.patch} />}
      {block.diff && (
        <div className="th-tool-foot">
          <span>
            {block.diff.path} <span className="is-add">+{block.diff.additions}</span>{' '}
            <span className="is-del">-{block.diff.deletions}</span>
          </span>
          <button type="button" onClick={() => onOpenChanges(block.diff?.path ?? '')}>
            Open in Changes
          </button>
        </div>
      )}
      {open && (
        <div className="th-tool-body">
          {block.summary && <p>{block.summary}</p>}
          {block.output && <pre>{block.output}</pre>}
          {block.truncated && <p className="th-muted">Output was cut at the provider limit.</p>}
        </div>
      )}
    </div>
  );
}

export function ToolRunCard({
  run,
  onOpenChanges,
}: {
  run: ToolRun;
  onOpenChanges: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const kinds = new Set(run.tools.map((tool) => tool.toolKind));
  const Icon = kinds.size > 1 ? FileSearch : kinds.has('search') ? Search : FileText;
  return (
    <div className="th-run">
      <div className="th-card th-tool is-ok">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon size={14} aria-hidden="true" />
          <span className="th-card-title th-run-title">{runLabel(run)}</span>
          <span className="th-tool-status">
            <StatusMark status="ok" />
          </span>
          <ChevronRight size={14} className="th-chevron" aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div className="th-run-list">
          {run.tools.map((tool) => (
            <ToolCard key={tool.id} block={tool} onOpenChanges={onOpenChanges} />
          ))}
        </div>
      )}
    </div>
  );
}

export function PermissionCard({
  block,
  ended,
  onResolve,
}: {
  block: PermissionBlock;
  ended: boolean;
  onResolve: (requestId: string, choice: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosen = block.options.find((option) => option.id === block.choice);
  async function choose(choice: string) {
    setBusy(choice);
    setError(null);
    try {
      await onResolve(block.requestId, choice);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The answer was not accepted.');
    } finally {
      setBusy(null);
    }
  }
  return (
    <section
      className={`th-card th-permission${block.choice !== null || ended ? ' is-resolved' : ''}`}
      aria-label="Permission request"
    >
      <div className="th-permission-head">
        <ShieldQuestion size={15} aria-hidden="true" />
        <p>{block.question}</p>
      </div>
      {block.detail && <pre>{block.detail}</pre>}
      {block.choice !== null ? (
        <p className="th-resolved">
          <Check size={13} aria-hidden="true" />
          {chosen ? chosen.label : block.choice}
        </p>
      ) : ended ? (
        <p className="th-muted">This request ended with the turn.</p>
      ) : (
        <div className="th-permission-options">
          {block.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`th-option is-${option.kind}`}
              disabled={busy !== null}
              onClick={() => void choose(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="th-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function FailureLine({ failure }: { failure: ChatFailure }) {
  const resets = failure.resetsAt ? Date.parse(failure.resetsAt) - Date.now() : null;
  const facts = [
    failure.method && `Method ${failure.method}`,
    failure.code !== null && `Code ${failure.code}`,
    `Stage ${failure.stage}`,
  ].filter(Boolean);
  return (
    <div className="th-failure" role="alert">
      <TriangleAlert size={15} aria-hidden="true" />
      <div>
        <p className="th-failure-message">{failure.message}</p>
        {resets !== null && resets > 0 && (
          <p className="th-muted">Resets in {formatSpan(resets)}.</p>
        )}
        <p>{failure.nextAction}</p>
        <details>
          <summary>Provider details</summary>
          {failure.providerMessage && <pre>{failure.providerMessage}</pre>}
          <p className="th-muted">{facts.join(' · ')}</p>
          {failure.detail && <pre className="th-failure-detail">{failure.detail}</pre>}
        </details>
      </div>
    </div>
  );
}

const runFailure = (failure: unknown) =>
  failure instanceof Error ? failure.message : 'The message was not run again.';

/**
 * Retry on a failed or stopped turn, Regenerate on the last reply. The menu starts on the thread's
 * current model, and the run uses whatever it shows.
 */
export function RerunControl({
  label,
  catalog,
  current,
  onRun,
}: {
  label: 'Retry' | 'Regenerate';
  catalog: ChatCatalogRead | null;
  current: ChatModelSelection | null;
  onRun: (selection: ChatModelSelection | null) => Promise<void>;
}) {
  const [picked, setPicked] = useState<ChatModelSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selection = picked ?? current;
  async function run() {
    setBusy(true);
    setError(null);
    try {
      await onRun(selection);
    } catch (failure) {
      setError(runFailure(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="th-rerun">
      <button
        type="button"
        className="th-pill th-outline"
        disabled={busy}
        onClick={() => void run()}
      >
        {label}
      </button>
      <ModelPicker
        catalog={catalog}
        selection={selection}
        currentFamily={null}
        running={false}
        nowMs={Date.now()}
        onOpen={() => {}}
        onSelect={setPicked}
        label={`Model for ${label}`}
      />
      {error && (
        <p className="th-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The families a rejected message has not tried yet, in the order `tryWithChoices` gives. */
export function TryWith({
  choices,
  onRun,
}: {
  choices: readonly TryWithChoice[];
  onRun: (selection: ChatModelSelection) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(selection: ChatModelSelection) {
    setBusy(true);
    setError(null);
    try {
      await onRun(selection);
      setOpen(false);
    } catch (failure) {
      setError(runFailure(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="th-try-with">
      <button
        type="button"
        className="th-pill th-outline"
        aria-expanded={open}
        disabled={choices.length === 0}
        title={
          choices.length === 0 ? 'Every connected provider has tried this message.' : undefined
        }
        onClick={() => setOpen(!open)}
      >
        Try with
        <ChevronRight size={13} className="th-chevron" aria-hidden="true" />
      </button>
      {open && (
        <ul aria-label="Try with">
          {choices.map((choice) => (
            <li key={choice.family}>
              <button
                type="button"
                className="th-try-option"
                disabled={busy}
                onClick={() => void run(choice.selection)}
              >
                <span>{familyName(choice.family)}</span>
                <span className="th-muted">{choice.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="th-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
