import type { ChatThread, DesignFinding, DesignFindings } from '@crewkite/contracts';
import { MoreHorizontal, RefreshCw } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import {
  type DesignRead,
  readDesignFindings,
  readDesignSystem,
  resolveDesignFinding,
  runDesignCheck,
  type ThreadSource,
} from '../thread/commands.ts';
import { useDesignSystems } from './context.ts';
import {
  capped,
  groupFindings,
  openByFile,
  RULE_LABELS,
  stateLine,
  suggestion,
  versionLabel,
} from './findings.ts';
import './design.css';

const DESIGN_CHECK = 'design-system';
const REASON_CHARACTERS = 200;
// Send to the fixer needs a decision still open; allow and update also take a row already sent.
const actionable = (finding: DesignFinding) => finding.state === 'open' || finding.state === 'sent';

/**
 * The project's design system record and the thread's findings, read again after the tab's own
 * commands, after a turn ends or a check runs, and after a save in the editor.
 */
export function useDesignFindings(
  source: ThreadSource,
  taskId: string,
  projectId: string | null,
  thread: ChatThread | null,
  changesKey: number,
) {
  const { saved } = useDesignSystems();
  // The record read for a project. It stays while the same project reads again, so the tab and the
  // control that gets focus back after the editor closes stay on screen.
  const [answer, setAnswer] = useState<{ projectId: string; read: DesignRead | null } | null>(null);
  const [findings, setFindings] = useState<DesignFindings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a save in the editor asks for a new read
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    readDesignSystem(source, projectId).then(
      (next) => live && setAnswer({ projectId, read: next }),
      () => live && setAnswer({ projectId, read: null }),
    );
    return () => {
      live = false;
    };
  }, [source, projectId, saved]);
  // Before the read answers, a missing design system may only be pending.
  const checked = answer !== null && answer.projectId === projectId;
  const system = checked ? answer.read : null;
  const hasSystem = Boolean(system?.record);
  const lastRun = thread?.checks?.runs.findLast((run) => run.checkId === DESIGN_CHECK)?.id ?? '';
  const trigger = `${thread?.activeTurnId ?? ''}:${lastRun}:${changesKey}:${saved}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the trigger names every event that can change the list
  useEffect(() => {
    if (!hasSystem) return;
    let live = true;
    readDesignFindings(source, taskId).then(
      (next) => {
        if (!live) return;
        setFindings(next);
        setError(null);
      },
      (failure: unknown) =>
        live && setError(failure instanceof Error ? failure.message : 'Findings are unavailable.'),
    );
    return () => {
      live = false;
    };
  }, [source, taskId, hasSystem, trigger]);
  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      setFindings(await runDesignCheck(source, taskId));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The design check did not run.');
    } finally {
      setRunning(false);
    }
  }, [source, taskId]);
  /** Each row answers with the whole list, and the last answer is the one shown. */
  const resolve = useCallback(
    async (
      rows: readonly DesignFinding[],
      action: 'send-to-fixer' | 'allow-once' | 'update-system',
      reason?: string,
    ) => {
      setError(null);
      try {
        let next: DesignFindings | null = null;
        for (const row of rows)
          next = await resolveDesignFinding(source, {
            findingId: row.id,
            action,
            ...(reason ? { reason } : {}),
          });
        if (next) setFindings(next);
        return true;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'The finding did not change.');
        // A refusal can leave earlier rows changed, so the list is read again.
        void readDesignFindings(source, taskId).then(setFindings, () => {});
        return false;
      }
    },
    [source, taskId],
  );
  const open = findings ? findings.findings.filter((row) => row.state === 'open').length : 0;
  return {
    record: system?.record ?? null,
    system: system?.system ?? null,
    hasSystem,
    checked,
    findings,
    error,
    running,
    run,
    resolve,
    open,
    byFile: findings ? openByFile(findings.findings) : new Map<string, number>(),
  };
}
export type DesignFindingsState = ReturnType<typeof useDesignFindings>;

const vars = (values: Record<string, string | undefined>) => values as CSSProperties;

function RowMenu({
  label,
  finding,
  onAct,
}: {
  label: string;
  finding: DesignFinding;
  onAct: (action: 'send-to-fixer' | 'allow-once' | 'update-system') => void;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const menu = useRef<HTMLDivElement>(null);
  const items = [
    { action: 'send-to-fixer' as const, label: 'Send to fixer', enabled: finding.state === 'open' },
    { action: 'allow-once' as const, label: 'Allow once', enabled: actionable(finding) },
    // A draft lives in the editor until it closes, so a row marked Draft open can start another.
    { action: 'update-system' as const, label: 'Update the system', enabled: actionable(finding) },
  ];
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[
        (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      ]?.focus();
    } else if (event.key === 'Escape') {
      // The menu closes and the inspector behind it stays open.
      event.preventDefault();
      menu.current?.hidePopover();
      menu.current?.parentElement?.querySelector<HTMLButtonElement>('.ds-row-menu')?.focus();
    }
    // The menu sits inside the grid, whose arrows, Space and Enter act on rows.
    event.stopPropagation();
  };
  return (
    <>
      <button
        type="button"
        className="icon-button ds-row-menu"
        tabIndex={-1}
        data-cell
        aria-label={`Actions for ${label}`}
        aria-haspopup="menu"
        popoverTarget={`ds-menu-${id}`}
        style={vars({ anchorName: `--ds-menu-${id}` })}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      <div
        ref={menu}
        id={`ds-menu-${id}`}
        popover="auto"
        role="menu"
        aria-label={`Actions for ${label}`}
        className="ds-menu"
        style={vars({ positionAnchor: `--ds-menu-${id}` })}
        onKeyDown={keys}
        onToggle={(event) => {
          if ((event.nativeEvent as ToggleEvent).newState === 'open')
            menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
        }}
      >
        {items.map((item) => (
          <button
            key={item.action}
            type="button"
            role="menuitem"
            disabled={!item.enabled}
            onClick={() => {
              menu.current?.hidePopover();
              onAct(item.action);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * The Design tab: the thread's findings against the project's design system, by file, with the
 * three ways to settle each. The list is a grid: Up and Down move between findings, Space selects,
 * Enter opens the line in Changes, Right reaches the row's controls.
 */
export function DesignTab({
  state,
  focusFile,
  onOpenChanges,
  onUpdateSystem,
}: {
  state: DesignFindingsState;
  /** A file whose count in Changes was pressed. Its group scrolls into view. */
  focusFile: string | null;
  onOpenChanges: (path: string, line: number) => void;
  onUpdateSystem: (finding: DesignFinding) => void;
}) {
  const ids = useId();
  const { findings, record, error, running } = state;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [allowing, setAllowing] = useState<readonly DesignFinding[] | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const grid = useRef<HTMLTableElement>(null);
  const reasonField = useRef<HTMLInputElement>(null);
  const rows = findings?.findings ?? [];
  const groups = groupFindings(rows);
  const ordered = groups.flatMap((group) => group.rows);
  const label = versionLabel(findings, record);
  const chosen = ordered.filter((row) => selected.has(row.id));
  const current = ordered.find((row) => row.id === active) ?? ordered[0];

  useEffect(() => {
    if (!focusFile) return;
    grid.current
      ?.querySelector(`[data-file="${CSS.escape(focusFile)}"]`)
      ?.scrollIntoView?.({ block: 'start' });
  }, [focusFile]);
  // The bar hides while the reason field is open. When the field closes, focus goes back to what
  // opened it, or to the first row it named.
  const allowOpener = useRef<{ element: HTMLElement | null; finding: string | null }>({
    element: null,
    finding: null,
  });
  useEffect(() => {
    if (allowing) {
      reasonField.current?.focus();
      return;
    }
    const { element, finding } = allowOpener.current;
    allowOpener.current = { element: null, finding: null };
    if (element?.isConnected && !element.closest('[popover]')) element.focus();
    else if (finding)
      grid.current?.querySelector<HTMLElement>(`[data-finding="${CSS.escape(finding)}"]`)?.focus();
  }, [allowing]);
  // A row that settled leaves the selection, so the actions only ever name rows they can change.
  useEffect(() => {
    setSelected((now) => {
      const kept = new Set(
        [...now].filter((id) => rows.some((row) => row.id === id && actionable(row))),
      );
      return kept.size === now.size ? now : kept;
    });
  }, [rows]);

  const toggle = (row: DesignFinding) => {
    if (!actionable(row)) return;
    setSelected((now) => {
      const next = new Set(now);
      if (!next.delete(row.id)) next.add(row.id);
      return next;
    });
  };
  async function act(
    targets: readonly DesignFinding[],
    action: 'send-to-fixer' | 'allow-once' | 'update-system',
  ) {
    if (action === 'allow-once') {
      allowOpener.current = {
        element: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        finding: targets[0]?.id ?? null,
      };
      setAllowing(targets);
      setReason('');
      return;
    }
    if (action === 'update-system') {
      const [row] = targets;
      if (!row) return;
      setBusy(true);
      const done = await state.resolve([row], 'update-system');
      setBusy(false);
      if (done) onUpdateSystem(row);
      return;
    }
    const open = targets.filter((row) => row.state === 'open');
    if (!open.length) return;
    setBusy(true);
    const done = await state.resolve(open, 'send-to-fixer');
    setBusy(false);
    if (done) {
      setSelected(new Set());
      setNote(
        `${open.length === 1 ? 'The finding rides' : `${open.length} findings ride`} on the fixer's next turn.`,
      );
    }
  }
  async function allow() {
    if (!allowing || !reason.trim()) return;
    setBusy(true);
    const done = await state.resolve(allowing, 'allow-once', reason.trim());
    setBusy(false);
    if (done) {
      setNote(
        `${allowing.length === 1 ? 'Allowed once.' : `Allowed ${allowing.length} findings once.`}`,
      );
      setAllowing(null);
      setSelected(new Set());
    }
  }

  const focusRowOf = (id: string) =>
    grid.current?.querySelector<HTMLElement>(`[data-finding="${CSS.escape(id)}"]`)?.focus();
  function gridKeys(event: KeyboardEvent<HTMLTableElement>) {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>('[data-finding]');
    if (!row) return;
    const id = row.dataset.finding as string;
    const at = ordered.findIndex((value) => value.id === id);
    const finding = ordered[at];
    const cells = [...row.querySelectorAll<HTMLElement>('[data-cell]')];
    const onRow = target === row;
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = Math.min(ordered.length - 1, at + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = ordered.length - 1;
    if (next !== null) {
      event.preventDefault();
      const to = ordered[next];
      if (to) {
        setActive(to.id);
        focusRowOf(to.id);
      }
    } else if (event.key === ' ' && finding) {
      event.preventDefault();
      toggle(finding);
    } else if (event.key === 'Enter' && onRow && finding) {
      event.preventDefault();
      onOpenChanges(finding.file, finding.line);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      const index = onRow ? -1 : cells.indexOf(target);
      cells[Math.min(cells.length - 1, index + 1)]?.focus();
    } else if (event.key === 'ArrowLeft' && !onRow) {
      event.preventDefault();
      const index = cells.indexOf(target);
      if (index <= 0) row.focus();
      else cells[index - 1]?.focus();
    }
  }

  const empty =
    label.ran && rows.length === 0
      ? label.current
        ? `No findings against version ${record?.version}.`
        : 'No findings. The check read an older version.'
      : null;
  const colorOf = (token: string | null) => {
    if (!token?.startsWith('color.')) return undefined;
    const value = state.system?.tokens.color[token.slice(6)];
    return value?.$value;
  };
  return (
    <div className="ds-findings">
      <div className="ds-findings-head">
        <p className={label.ran && !label.current ? 'is-older' : undefined}>{label.text}</p>
        <button
          type="button"
          className="th-button"
          disabled={running || busy}
          onClick={() => void state.run()}
        >
          <RefreshCw size={12} aria-hidden="true" className={running ? 'spin' : undefined} />
          {label.ran ? 'Run again' : 'Run check'}
        </button>
      </div>
      {running && (
        <p className="th-muted" role="status">
          Checking changed files.
        </p>
      )}
      {error && (
        <p className="th-error ds-findings-error" role="alert">
          {error}
        </p>
      )}
      {!findings && !error && !running && <p className="th-muted">Reading findings.</p>}
      {capped(rows) && (
        <p className="ds-cap" role="status">
          Showing the first 500 findings. Fix these and run the check again for the rest.
        </p>
      )}
      {empty && <p className="th-muted">{empty}</p>}
      {groups.length > 0 && (
        <table
          ref={grid}
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a grid on a table keeps the table structure for screen readers and adds the grid's keys
          role="grid"
          aria-label="Design findings"
          aria-multiselectable="true"
          className="ds-grid-list"
          onKeyDown={gridKeys}
        >
          {groups.map((group) => (
            <tbody key={group.file} className="ds-file-group" data-file={group.file}>
              <tr className="ds-file-row">
                <th scope="colgroup" colSpan={3}>
                  <span className="ds-file-head">
                    <span className="th-path is-tail" title={group.file}>
                      <bdi>{group.file}</bdi>
                    </span>
                    <span className="ds-file-count">{group.open} open</span>
                  </span>
                </th>
              </tr>
              {group.rows.map((finding) => {
                const location = `${finding.file}:${finding.line}`;
                const line = stateLine(finding);
                const isColorRule = finding.rule === 'raw-color';
                const nearest = colorOf(finding.nearestToken);
                return (
                  <tr
                    key={finding.id}
                    tabIndex={finding.id === current?.id ? 0 : -1}
                    data-finding={finding.id}
                    aria-selected={actionable(finding) ? selected.has(finding.id) : undefined}
                    aria-disabled={actionable(finding) ? undefined : true}
                    className={`ds-finding is-${finding.state}${selected.has(finding.id) ? ' is-selected' : ''}`}
                    onFocus={(event) => {
                      if (event.target === event.currentTarget) setActive(finding.id);
                    }}
                  >
                    <td className="ds-finding-check">
                      {/* The label gives the box a 24 px target. */}
                      <label className="ds-check-target">
                        <input
                          type="checkbox"
                          tabIndex={-1}
                          aria-label={`Select ${RULE_LABELS[finding.rule]} at ${location}`}
                          checked={selected.has(finding.id)}
                          disabled={!actionable(finding)}
                          onChange={() => toggle(finding)}
                        />
                      </label>
                    </td>
                    <td className="ds-finding-main">
                      <span className="ds-finding-rule">
                        {RULE_LABELS[finding.rule]}
                        <button
                          type="button"
                          className="ds-location"
                          tabIndex={-1}
                          data-cell
                          aria-label={`Open ${location} in Changes`}
                          onClick={() => onOpenChanges(finding.file, finding.line)}
                        >
                          {finding.file.split('/').at(-1)}:{finding.line}
                        </button>
                      </span>
                      <span className="ds-finding-values">
                        <span className="ds-finding-found">
                          {isColorRule && (
                            <span
                              className="ds-chip is-small"
                              style={vars({ '--ds-swatch': finding.found })}
                              aria-hidden="true"
                            />
                          )}
                          {finding.found}
                        </span>
                        <span
                          className={finding.nearestToken ? 'ds-suggest' : 'ds-suggest is-none'}
                        >
                          {isColorRule && nearest && (
                            <span
                              className="ds-chip is-small"
                              style={vars({ '--ds-swatch': nearest })}
                              aria-hidden="true"
                            />
                          )}
                          {suggestion(finding)}
                        </span>
                      </span>
                      {line && <span className="ds-finding-state">{line}</span>}
                    </td>
                    <td className="ds-finding-menu">
                      <RowMenu
                        label={`${RULE_LABELS[finding.rule]} at ${location}`}
                        finding={finding}
                        onAct={(action) => void act([finding], action)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      )}
      {rows.some(actionable) && !allowing && (
        <fieldset className="ds-findings-actions">
          <legend className="ds-sr">Selected findings</legend>
          <span className="th-muted ds-selection-count">
            {chosen.length ? `${chosen.length} selected` : 'Select findings to act on them.'}
          </span>
          <button
            type="button"
            className="th-button"
            disabled={busy || !chosen.some((row) => row.state === 'open')}
            onClick={() => void act(chosen, 'send-to-fixer')}
          >
            Send to fixer
          </button>
          <button
            type="button"
            className="th-button"
            disabled={busy || chosen.length === 0}
            onClick={() => void act(chosen, 'allow-once')}
          >
            Allow once
          </button>
          <button
            type="button"
            className="th-button"
            disabled={busy || chosen.length !== 1}
            title={
              chosen.length > 1
                ? 'Each new token needs its own name, so choose one finding.'
                : undefined
            }
            onClick={() => void act(chosen, 'update-system')}
          >
            Update the system
          </button>
        </fieldset>
      )}
      {allowing && (
        <form
          className="ds-allow"
          onSubmit={(event) => {
            event.preventDefault();
            void allow();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setAllowing(null);
          }}
        >
          <label htmlFor={`${ids}-reason`}>
            {allowing.length === 1
              ? `Why may ${allowing[0]?.found} stay?`
              : `Why may these ${allowing.length} values stay?`}
          </label>
          <input
            ref={reasonField}
            id={`${ids}-reason`}
            value={reason}
            maxLength={REASON_CHARACTERS}
            required
            aria-describedby={`${ids}-reason-count`}
            onChange={(event) => setReason(event.target.value)}
          />
          <small className="th-muted" id={`${ids}-reason-count`}>
            {reason.trim().length} of {REASON_CHARACTERS} characters. Required.
          </small>
          <div className="ds-allow-actions">
            <button type="submit" className="th-button" disabled={busy || !reason.trim()}>
              Record reason
            </button>
            <button type="button" className="th-button" onClick={() => setAllowing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {note && (
        <p className="th-muted" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
