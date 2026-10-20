import {
  AudioLines,
  Check,
  ChevronDown,
  CircleAlert,
  CircleQuestionMark,
  Clock3,
  FileText,
  Folder,
  LoaderCircle,
  LockKeyhole,
  Mic,
  MicOff,
  Plus,
  ScrollText,
  ShieldHalf,
  Unplug,
  X,
} from 'lucide-react';
import {
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import './composer-controls.css';

export type ComposerContextKind = 'file' | 'folder' | 'log';

export type ComposerContextAction = {
  id: string;
  kind: ComposerContextKind;
  label: string;
  detail?: string;
  disabledReason?: string;
};

export type ComposerContextItem = {
  id: string;
  kind: ComposerContextKind;
  name: string;
  size?: string;
  status: 'ready' | 'pending' | 'failed' | 'uncertain';
  // Shown for failed and uncertain items. Ready and pending items need no explanation.
  detail?: string;
  removable?: boolean;
};

export type ComposerChoice = {
  id: string;
  label: string;
  detail?: string;
  disabledReason?: string;
};

export type ComposerModelChoice = ComposerChoice & {
  route?: string;
  // The effort menu offers exactly these levels while this model is current or requested.
  efforts: readonly ComposerChoice[];
};

export type ComposerPrimaryControl = {
  // The one role these menus change, for example "Lead". Other roles are never touched here.
  roleLabel: string;
  models: readonly ComposerModelChoice[];
  currentModelId: string | null;
  requestedModelId?: string | null;
  currentEffortId: string | null;
  requestedEffortId?: string | null;
  // A requested change was sent and the controller has not confirmed it yet.
  pending?: boolean;
  scopeLabel: string;
  // The current run is frozen. Both menus stay closed and this text says why.
  frozenReason?: string;
  onSelectModel?: (modelId: string) => void;
  onSelectEffort?: (effortId: string) => void;
};

export type ComposerPolicyControl = {
  label: string;
  options: readonly ComposerChoice[];
  currentId: string;
  requestedId?: string | null;
  pending?: boolean;
  scopeLabel: string;
  disabledReason?: string;
  onSelect?: (optionId: string) => void;
};

export type ComposerMicrophone = {
  state: 'idle' | 'listening' | 'processing';
  onToggle: () => void;
  disabledReason?: string;
};

export type ComposerControlsProps = {
  contextActions?: readonly ComposerContextAction[];
  onContextAction?: (actionId: string) => void;
  contextItems?: readonly ComposerContextItem[];
  onRemoveContext?: (itemId: string) => void;
  primary?: ComposerPrimaryControl | null;
  policy?: ComposerPolicyControl | null;
  // The kite context meter is a separate component. It renders beside the model identity.
  contextMeter?: ReactNode;
  // Supplied only when voice input exists, so the button never promises a missing feature.
  microphone?: ComposerMicrophone | null;
  // The controller is unavailable. Every action is disabled and this text says why.
  disconnectedReason?: string;
};

// A blocked control stays focusable. A disconnected toolbar points at its visible notice. Any other
// block gets a tip, so the reason never depends on a mouse.
type Blocked = { reason: string; describedBy?: string };

type MenuEntry = {
  id: string;
  label: string;
  icon?: ReactNode;
  secondary?: string;
  disabledReason?: string;
  tag?: { text: string; requested?: boolean };
};

const kindIcon = { file: FileText, folder: Folder, log: ScrollText };
const kindName = { file: 'File', folder: 'Folder', log: 'Log' };
const statusIcon = { pending: Clock3, failed: CircleAlert, uncertain: CircleQuestionMark };
const statusText = { pending: 'Pending', failed: 'Failed', uncertain: 'Uncertain' };
const POLICY_NOTE = 'Saved permissions, budgets and required checks still apply.';
const UNLISTED = 'Current option not listed';
const REQUESTED_UNLISTED = 'an unlisted option';

// Anchor names must be dashed identifiers, so only the letters and digits of useId survive.
function useAnchor() {
  const id = `composer-controls-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return { id, anchor: `--${id}` };
}

// Reasons must reach keyboard and touch users too, so the tip opens on focus and tap.
function useTip(text: string | undefined, anchor: string, id: string) {
  const tip = useRef<HTMLSpanElement>(null);
  const focused = useRef(false);
  if (!text) return { tipId: undefined, handlers: {}, tip: null };
  const show = () => {
    if (tip.current && !tip.current.matches(':popover-open')) tip.current.showPopover();
  };
  const hide = () => {
    if (tip.current?.matches(':popover-open')) tip.current.hidePopover();
  };
  const leave = (event: PointerEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (event.pointerType !== 'mouse' || focused.current) return;
    if (next instanceof Node && (tip.current?.contains(next) || next === event.currentTarget))
      return;
    hide();
  };
  return {
    tipId: `${id}-tip`,
    handlers: {
      onClick: show,
      onFocus: (event: FocusEvent<HTMLElement>) => {
        focused.current = true;
        if (event.currentTarget.matches(':focus-visible')) show();
      },
      onBlur: () => {
        focused.current = false;
        hide();
      },
      onPointerEnter: (event: PointerEvent<HTMLElement>) => {
        if (event.pointerType === 'mouse') show();
      },
      onPointerLeave: leave,
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key === 'Escape') hide();
      },
    },
    tip: (
      <span
        ref={tip}
        id={`${id}-tip`}
        role="tooltip"
        popover="hint"
        className="cc-tip"
        style={{ positionAnchor: anchor }}
        onPointerLeave={leave}
      >
        {text}
      </span>
    ),
  };
}

function Pending() {
  return (
    <span className="cc-pending" aria-hidden="true">
      <Clock3 size={12} />
      <span className="cc-pending-text">Pending</span>
    </span>
  );
}

function Caret({ blocked }: { blocked?: Blocked }) {
  if (blocked?.describedBy) return null;
  return blocked ? (
    <LockKeyhole className="cc-caret" size={12} aria-hidden="true" />
  ) : (
    <ChevronDown className="cc-caret" size={13} aria-hidden="true" />
  );
}

function Menu({
  className,
  name,
  title,
  subtitle,
  scope,
  notice,
  note,
  empty,
  entries,
  radio,
  checkedId,
  blocked,
  onChoose,
  children,
}: {
  className: string;
  name: string;
  title: string;
  subtitle?: string;
  scope?: string;
  notice?: string;
  note?: string;
  empty: string;
  entries: readonly MenuEntry[];
  radio?: boolean;
  checkedId?: string | null;
  blocked?: Blocked;
  // Without a handler the menu still shows the choices, but none of them can be picked.
  onChoose?: (id: string) => void;
  children: ReactNode;
}) {
  const { id, anchor } = useAnchor();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const start = useRef<'first' | 'last' | 'checked'>('checked');
  const [open, setOpen] = useState(false);
  const readOnly = !onChoose;
  const isBlocked = Boolean(blocked);
  const tip = useTip(blocked && !blocked.describedBy ? blocked.reason : undefined, anchor, id);
  const items = () => [...(popup.current?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])];
  const enter = (from: 'first' | 'last' | 'checked') => {
    const list = items();
    const target =
      from === 'last'
        ? list.at(-1)
        : from === 'first'
          ? list[0]
          : (list.find((item) => item.getAttribute('aria-checked') === 'true') ?? list[0]);
    // An empty menu takes focus itself, so Tab and Escape still work.
    (target ?? popup.current?.querySelector<HTMLElement>('[role="menu"]'))?.focus();
  };
  // Focus moves before the popover hides. Hiding with focus inside makes the browser restore focus
  // to whatever held it before the menu opened, and that element may try to open its tip mid-hide.
  const close = () => {
    trigger.current?.focus();
    if (popup.current?.matches(':popover-open')) popup.current.hidePopover();
  };
  // A block can arrive while the menu is open. Close it so a stale choice is never reachable.
  useEffect(() => {
    const element = popup.current;
    if (!isBlocked || !element?.matches(':popover-open')) return;
    const active = document.activeElement;
    if (!active || active === document.body || element.contains(active)) trigger.current?.focus();
    element.hidePopover();
  }, [isBlocked]);
  // The host can drop the whole menu while it is open. Hand focus on before its nodes leave.
  useLayoutEffect(
    () => () => {
      if (!popup.current?.contains(document.activeElement)) return;
      const toolbar = trigger.current?.closest('.composer-controls');
      const next = [...(toolbar?.querySelectorAll<HTMLElement>('.cc-button') ?? [])].find(
        (button) => button !== trigger.current,
      );
      next?.focus();
    },
    [],
  );
  // When the host replaces the entries under the focused item, focus falls to the page. Catch it.
  useEffect(() => {
    if (popup.current?.matches(':popover-open') && document.activeElement === document.body)
      enter('checked');
  });
  const describedBy = [
    subtitle && `${id}-subtitle`,
    scope && `${id}-scope`,
    readOnly && `${id}-readonly`,
    notice && `${id}-notice`,
    entries.length === 0 && `${id}-empty`,
    note && `${id}-note`,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`cc-button ${className}`}
        style={{ anchorName: anchor }}
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        aria-disabled={blocked ? true : undefined}
        aria-describedby={blocked?.describedBy ?? tip.tipId}
        popoverTarget={blocked ? undefined : `${id}-popup`}
        {...tip.handlers}
        onKeyDown={(event) => {
          if (blocked) return tip.handlers.onKeyDown?.(event);
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          const from = event.key === 'ArrowDown' ? 'first' : 'last';
          if (popup.current?.matches(':popover-open')) return enter(from);
          start.current = from;
          popup.current?.showPopover();
        }}
      >
        {children}
      </button>
      {tip.tip}
      <div
        ref={popup}
        id={`${id}-popup`}
        popover="auto"
        className="cc-menu"
        style={{ positionAnchor: anchor }}
        onToggle={(event) => {
          setOpen(event.newState === 'open');
          const from = start.current;
          start.current = 'checked';
          // The toggle event arrives a task later. Keep focus if the user already moved in.
          if (event.newState === 'open' && !popup.current?.contains(document.activeElement))
            enter(from);
        }}
      >
        <div className="cc-menu-head">
          <strong id={`${id}-title`}>{title}</strong>
          {subtitle && <span id={`${id}-subtitle`}>{subtitle}</span>}
          {scope && <span id={`${id}-scope`}>{scope}</span>}
          {readOnly && <span id={`${id}-readonly`}>Read only in this view.</span>}
        </div>
        {notice && (
          <p className="cc-menu-notice" id={`${id}-notice`}>
            <Clock3 size={12} aria-hidden="true" />
            {notice}
          </p>
        )}
        <div
          role="menu"
          id={`${id}-menu`}
          className="cc-menu-list"
          tabIndex={-1}
          aria-labelledby={`${id}-title`}
          aria-describedby={describedBy || undefined}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            // Tab leaves the menu. Closing first lets the browser move on from the trigger.
            if (event.key === 'Tab') {
              close();
              return;
            }
            const list = items();
            const active = document.activeElement;
            const index = active instanceof HTMLElement ? list.indexOf(active) : -1;
            const next =
              event.key === 'ArrowDown'
                ? list[(index + 1) % list.length]
                : event.key === 'ArrowUp'
                  ? list.at(index <= 0 ? -1 : index - 1)
                  : event.key === 'Home'
                    ? list[0]
                    : event.key === 'End'
                      ? list.at(-1)
                      : undefined;
            if (!next) return;
            event.preventDefault();
            next.focus();
          }}
          // A click on the heading or a note would drop focus to the page. Bring it back.
          onBlur={(event) => {
            const left = event.target;
            if (event.relatedTarget) return;
            requestAnimationFrame(() => {
              if (!popup.current?.matches(':popover-open')) return;
              if (document.activeElement !== document.body) return;
              if (left.isConnected) left.focus();
              else enter('checked');
            });
          }}
        >
          {entries.map((entry, index) => {
            const key = `${id}-${index}`;
            const checked = radio && entry.id === checkedId;
            const role = radio
              ? { role: 'menuitemradio', 'aria-checked': checked }
              : { role: 'menuitem' };
            return (
              <button
                key={entry.id}
                type="button"
                {...role}
                className="cc-item"
                tabIndex={-1}
                data-menu-item
                aria-disabled={entry.disabledReason || readOnly ? true : undefined}
                aria-labelledby={`${key}-label`}
                aria-describedby={
                  [
                    entry.secondary && `${key}-secondary`,
                    entry.disabledReason && `${key}-reason`,
                    entry.tag && `${key}-tag`,
                  ]
                    .filter(Boolean)
                    .join(' ') || undefined
                }
                onClick={() => {
                  if (entry.disabledReason || blocked || !onChoose) return;
                  if (!checked) onChoose(entry.id);
                  close();
                }}
              >
                <span className="cc-item-mark" aria-hidden="true">
                  {radio ? checked && <Check size={14} /> : entry.icon}
                </span>
                <span className="cc-item-text">
                  <span className="cc-item-label" id={`${key}-label`}>
                    {entry.label}
                  </span>
                  {entry.secondary && (
                    <span className="cc-item-detail" id={`${key}-secondary`}>
                      {entry.secondary}
                    </span>
                  )}
                  {entry.disabledReason && (
                    <span className="cc-item-reason" id={`${key}-reason`}>
                      <LockKeyhole size={11} aria-hidden="true" />
                      {entry.disabledReason}
                    </span>
                  )}
                </span>
                {entry.tag && (
                  <span
                    className="cc-item-tag"
                    id={`${key}-tag`}
                    data-requested={entry.tag.requested || undefined}
                  >
                    {entry.tag.requested && <Clock3 size={11} aria-hidden="true" />}
                    {entry.tag.text}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {entries.length === 0 && (
          <p className="cc-menu-empty" id={`${id}-empty`}>
            {empty}
          </p>
        )}
        {note && (
          <p className="cc-menu-note" id={`${id}-note`}>
            {note}
          </p>
        )}
      </div>
    </>
  );
}

function ContextChip({
  item,
  onRemove,
  blocked,
}: {
  item: ComposerContextItem;
  onRemove?: (itemId: string, button: HTMLButtonElement) => void;
  blocked?: Blocked;
}) {
  const { id, anchor } = useAnchor();
  const explained =
    item.status === 'failed' || item.status === 'uncertain' ? item.detail : undefined;
  const tip = useTip(explained, anchor, id);
  const Kind = kindIcon[item.kind];
  const status = item.status === 'ready' ? null : item.status;
  const StatusIcon = status && statusIcon[status];
  const statusContent = status && StatusIcon && (
    <>
      <StatusIcon size={12} aria-hidden="true" />
      {statusText[status]}
    </>
  );
  return (
    <li className="cc-chip" data-status={item.status}>
      <Kind className="cc-chip-kind" size={13} aria-hidden="true" />
      <span className="cc-sr-only">{kindName[item.kind]}</span>
      <span className="cc-chip-name" title={item.name}>
        {item.name}
      </span>
      {item.size && <span className="cc-chip-size">{item.size}</span>}
      {status &&
        (explained ? (
          <button
            type="button"
            className="cc-status"
            style={{ anchorName: anchor }}
            aria-label={`${statusText[status]}: ${item.name}`}
            aria-describedby={tip.tipId}
            {...tip.handlers}
          >
            {statusContent}
          </button>
        ) : (
          <span className="cc-status">{statusContent}</span>
        ))}
      {tip.tip}
      {item.removable && onRemove && (
        <button
          type="button"
          className="cc-remove"
          aria-label={`Remove ${item.name}`}
          aria-disabled={blocked ? true : undefined}
          aria-describedby={blocked?.describedBy}
          onClick={(event) => {
            if (!blocked) onRemove(item.id, event.currentTarget);
          }}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

function Microphone({
  microphone,
  blocked,
}: {
  microphone: ComposerMicrophone;
  blocked?: Blocked;
}) {
  const { id, anchor } = useAnchor();
  const reason = blocked?.reason ?? microphone.disabledReason;
  const tip = useTip(blocked ? undefined : microphone.disabledReason, anchor, id);
  const { state } = microphone;
  const Icon = reason
    ? MicOff
    : state === 'listening'
      ? AudioLines
      : state === 'processing'
        ? LoaderCircle
        : Mic;
  return (
    <>
      <button
        type="button"
        className="cc-button cc-icon cc-mic"
        style={{ anchorName: anchor }}
        data-state={state}
        aria-label={state === 'idle' ? 'Voice input' : `Voice input, ${state}`}
        aria-pressed={state === 'listening'}
        aria-busy={state === 'processing' || undefined}
        aria-disabled={reason ? true : undefined}
        aria-describedby={blocked?.describedBy ?? tip.tipId}
        {...tip.handlers}
        onClick={reason ? tip.handlers.onClick : microphone.onToggle}
      >
        <Icon
          className={state === 'processing' && !reason ? 'cc-spin' : undefined}
          size={15}
          aria-hidden="true"
        />
      </button>
      {tip.tip}
    </>
  );
}

function find<T extends { id: string }>(list: readonly T[], id: string | null | undefined) {
  return id == null ? undefined : list.find((entry) => entry.id === id);
}

// A null id means nothing is selected. An id missing from the list is named as such, never shown
// as empty, so the toolbar does not hide what is actually running.
function labelOf(list: readonly ComposerChoice[], id: string | null | undefined, unlisted: string) {
  return id == null ? undefined : (find(list, id)?.label ?? unlisted);
}

// Current and requested choices both stay visible. A pending change never hides what runs now.
function selection<T extends ComposerChoice>(
  list: readonly T[],
  currentId: string | null,
  requestedId: string | null | undefined,
  secondary: (choice: T) => string | undefined = (choice) => choice.detail,
) {
  const change = requestedId != null && requestedId !== currentId;
  const entries: MenuEntry[] = list.map((choice) => ({
    id: choice.id,
    label: choice.label,
    secondary: secondary(choice),
    disabledReason: choice.disabledReason,
    tag: !change
      ? undefined
      : choice.id === currentId
        ? { text: 'Current' }
        : choice.id === requestedId
          ? { text: 'Requested', requested: true }
          : undefined,
  }));
  return { change, checkedId: change ? requestedId : currentId, entries };
}

function describe(
  subject: string,
  current: string | undefined,
  requested: string | undefined,
  awaiting: boolean,
) {
  return [
    `${subject}: ${current ?? 'none selected'}`,
    requested && `requested ${requested}`,
    awaiting && 'awaiting confirmation',
  ]
    .filter(Boolean)
    .join(', ');
}

export function ComposerControls({
  contextActions = [],
  onContextAction,
  contextItems = [],
  onRemoveContext,
  primary,
  policy,
  contextMeter,
  microphone,
  disconnectedReason,
}: ComposerControlsProps) {
  const noticeId = `${useAnchor().id}-notice`;
  const root = useRef<HTMLFieldSetElement>(null);
  const removal = useRef<{ id: string; index: number } | null>(null);
  // Removing the focused chip takes its button with it and focus drops to the page. Once the host
  // has removed the item, focus the remove button now in that place, the one before it, or "+".
  useEffect(() => {
    const pending = removal.current;
    if (!pending || contextItems.some((item) => item.id === pending.id)) return;
    removal.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const buttons = [...(root.current?.querySelectorAll<HTMLElement>('.cc-remove') ?? [])];
    const fallback = root.current?.querySelector<HTMLElement>('.cc-add, .cc-button');
    (buttons[pending.index] ?? buttons[pending.index - 1] ?? fallback)?.focus();
  }, [contextItems]);
  const offline = disconnectedReason
    ? { reason: disconnectedReason, describedBy: noticeId }
    : undefined;
  const meter = contextMeter ? <div className="cc-meter">{contextMeter}</div> : null;

  let primaryControls: ReactNode = null;
  let primaryAwaiting = false;
  if (primary) {
    const { roleLabel, models, currentModelId, requestedModelId, currentEffortId } = primary;
    const blocked =
      offline ?? (primary.frozenReason ? { reason: primary.frozenReason } : undefined);
    const current = find(models, currentModelId);
    const currentLabel = labelOf(models, currentModelId, UNLISTED);
    const model = selection(
      models,
      currentModelId,
      requestedModelId,
      (choice) => [choice.route, choice.detail].filter(Boolean).join(' · ') || undefined,
    );
    const effective = find(models, model.checkedId);
    const efforts = effective?.efforts ?? [];
    // The current effort runs on the current model. A requested model's matching id is not current.
    const effort = selection(
      efforts,
      effective && effective.id === currentModelId ? currentEffortId : null,
      primary.requestedEffortId,
    );
    const currentEffort = labelOf(current?.efforts ?? [], currentEffortId, UNLISTED);
    const modelAwaiting = model.change || Boolean(primary.pending && !effort.change);
    primaryAwaiting = modelAwaiting || effort.change;
    const awaitingNotice = primaryAwaiting ? 'Requested change awaits confirmation.' : undefined;
    primaryControls = (
      <div className="cc-primary">
        <Menu
          className="cc-model"
          name={describe(
            `${roleLabel} model`,
            currentLabel,
            model.change ? labelOf(models, requestedModelId, REQUESTED_UNLISTED) : undefined,
            modelAwaiting,
          )}
          title={`${roleLabel} model`}
          scope={primary.scopeLabel}
          notice={awaitingNotice}
          empty="No models are available for this role."
          radio
          checkedId={model.checkedId}
          entries={model.entries}
          blocked={blocked}
          onChoose={primary.onSelectModel}
        >
          <span className="cc-role">{roleLabel}</span>
          <span className="cc-value">{currentLabel ?? 'No model'}</span>
          {modelAwaiting && <Pending />}
          <Caret blocked={blocked} />
        </Menu>
        {(efforts.length > 0 || currentEffortId != null) && (
          <Menu
            className="cc-effort"
            name={describe(
              `${roleLabel} effort`,
              currentEffort,
              effort.change
                ? labelOf(efforts, primary.requestedEffortId, REQUESTED_UNLISTED)
                : undefined,
              effort.change,
            )}
            title={`${roleLabel} effort`}
            subtitle={effective && `For ${effective.label}`}
            scope={primary.scopeLabel}
            notice={awaitingNotice}
            empty="No effort levels are listed."
            radio
            checkedId={effort.checkedId}
            entries={effort.entries}
            blocked={blocked}
            onChoose={primary.onSelectEffort}
          >
            <span className="cc-value">{currentEffort ?? 'No effort'}</span>
            {effort.change && <Pending />}
            <Caret blocked={blocked} />
          </Menu>
        )}
        {meter}
      </div>
    );
  }

  let policyControl: ReactNode = null;
  let policyAwaiting = false;
  if (policy) {
    const blocked =
      offline ?? (policy.disabledReason ? { reason: policy.disabledReason } : undefined);
    const choice = selection(policy.options, policy.currentId, policy.requestedId);
    const current = labelOf(policy.options, policy.currentId, UNLISTED);
    policyAwaiting = choice.change || Boolean(policy.pending);
    policyControl = (
      <>
        <span className="cc-divider" aria-hidden="true" />
        <Menu
          className="cc-policy"
          name={describe(
            policy.label,
            current,
            choice.change
              ? labelOf(policy.options, policy.requestedId, REQUESTED_UNLISTED)
              : undefined,
            policyAwaiting,
          )}
          title={policy.label}
          scope={policy.scopeLabel}
          notice={policyAwaiting ? 'Requested change awaits confirmation.' : undefined}
          note={POLICY_NOTE}
          empty="No policy options are available."
          radio
          checkedId={choice.checkedId}
          entries={choice.entries}
          blocked={blocked}
          onChoose={policy.onSelect}
        >
          <ShieldHalf size={14} aria-hidden="true" />
          <span className="cc-value">{current ?? policy.label}</span>
          {policyAwaiting && <Pending />}
          <Caret blocked={blocked} />
        </Menu>
      </>
    );
  }

  const announcements = [
    disconnectedReason,
    primary && primaryAwaiting && `${primary.roleLabel} change awaits confirmation.`,
    policy && policyAwaiting && `${policy.label} change awaits confirmation.`,
  ].filter((message): message is string => Boolean(message));

  return (
    <fieldset ref={root} className="composer-controls" aria-label="Composer controls">
      {/* One node per sentence, so a screen reader announces only the sentence that is new. */}
      <span className="cc-sr-only" role="status" aria-atomic="false">
        {announcements.map((message) => (
          <span key={message}>{`${message} `}</span>
        ))}
      </span>
      {disconnectedReason && (
        // The status line above announces this text. The visible copy stays out of reading order.
        <p className="cc-notice" id={noticeId} aria-hidden="true">
          <Unplug size={13} />
          {disconnectedReason}
        </p>
      )}
      {contextItems.length > 0 && (
        <ul className="cc-chips" aria-label="Selected context">
          {contextItems.map((item) => (
            <ContextChip
              key={item.id}
              item={item}
              blocked={offline}
              onRemove={
                onRemoveContext &&
                ((itemId, button) => {
                  const buttons = [...(root.current?.querySelectorAll('.cc-remove') ?? [])];
                  removal.current = { id: itemId, index: buttons.indexOf(button) };
                  onRemoveContext(itemId);
                })
              }
            />
          ))}
        </ul>
      )}
      <div className="cc-row">
        {contextActions.length > 0 && onContextAction && (
          <Menu
            className="cc-icon cc-add"
            name="Add context"
            title="Add context"
            empty="No context sources are available."
            entries={contextActions.map((action) => {
              const Icon = kindIcon[action.kind];
              return {
                id: action.id,
                label: action.label,
                icon: <Icon size={14} />,
                secondary: action.detail,
                disabledReason: action.disabledReason,
              };
            })}
            blocked={offline}
            onChoose={onContextAction}
          >
            <Plus size={16} aria-hidden="true" />
          </Menu>
        )}
        {primaryControls ?? meter}
        {policyControl}
        {microphone && <Microphone microphone={microphone} blocked={offline} />}
      </div>
    </fieldset>
  );
}
