import type { TokenGroup } from '@crewkite/contracts';
import { ArrowDown, ArrowUp, GripVertical, Play, Plus, Trash2 } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Select } from '../select.tsx';
import {
  type Category,
  type ColorCheck,
  contrastLabel,
  contrastRatio,
  cssValue,
  draftKey,
  type EditModel,
  type Field as FieldName,
  type ItemDraft,
  newLabel,
  over,
  type Problem,
  parseValue,
  type Rgba,
  type TokenDraft,
  type TokenType,
} from './model.ts';

/** The row being edited and how it looked when the edit began. A new row has no snapshot. */
export type Editing = { key: string; snapshot: TokenDraft | ItemDraft | null };

export type EditorProps = {
  model: EditModel;
  change: (update: (model: EditModel) => EditModel) => void;
  problems: ReadonlyMap<string, readonly Problem[]>;
  editing: Editing | null;
  setEditing: (editing: Editing | null) => void;
  filter: string;
  isColor: ColorCheck;
  /** Moves focus to a row once it is on screen. */
  focusRow: (key: string) => void;
};

const KINDS: Partial<Record<TokenGroup, readonly { type: TokenType; label: string }[]>> = {
  type: [
    { type: 'fontFamily', label: 'Family' },
    { type: 'fontWeight', label: 'Weight' },
    { type: 'dimension', label: 'Size' },
    { type: 'number', label: 'Line height' },
  ],
  motion: [
    { type: 'duration', label: 'Duration' },
    { type: 'cubicBezier', label: 'Easing' },
  ],
};
const GROUP_TYPE: Partial<Record<TokenGroup, TokenType>> = {
  color: 'color',
  spacing: 'dimension',
  radius: 'dimension',
  shadow: 'shadow',
};
const NOUN: Record<TokenGroup, string> = {
  color: 'color',
  type: 'type token',
  spacing: 'spacing step',
  radius: 'radius',
  shadow: 'shadow',
  motion: 'motion token',
};

// The canvas reads any color the browser draws as red, green, blue and alpha, so oklch() and
// named colors get a contrast ratio too. A value it cannot draw has none.
let painter: CanvasRenderingContext2D | null | undefined;
const resolved = new Map<string, Rgba | null>();
export function resolveColor(value: string, isColor: ColorCheck): Rgba | null {
  if (resolved.has(value)) return resolved.get(value) ?? null;
  let rgba: Rgba | null = null;
  if (isColor(value)) {
    if (painter === undefined) {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      painter = canvas.getContext('2d', { willReadFrequently: true });
    }
    if (painter) {
      painter.clearRect(0, 0, 1, 1);
      painter.fillStyle = value;
      painter.fillRect(0, 0, 1, 1);
      const [red = 0, green = 0, blue = 0, alpha = 0] = painter.getImageData(0, 0, 1, 1).data;
      rgba = [red, green, blue, alpha / 255];
    }
  }
  if (resolved.size > 500) resolved.clear();
  resolved.set(value, rgba);
  return rgba;
}

// Specimens draw with the person's own values through custom properties, which the stylesheet
// reads. React types know no custom property names.
const vars = (values: Record<string, string | null | undefined>) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value != null)) as CSSProperties;

const matches = (filter: string, ...texts: string[]) =>
  !filter || texts.some((text) => text.toLowerCase().includes(filter.toLowerCase()));

/** Whether a media query matches now, following its changes. */
export function useMedia(query: string) {
  const [matches, setMatches] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

// Contrast pairs are a per-window preference, like the theme. Storage can be blocked.
const PAIR_KEY = 'crewkite-design-contrast-v1';
function readPair(): { text: string; background: string } | null {
  try {
    const value = JSON.parse(localStorage.getItem(PAIR_KEY) ?? 'null');
    return typeof value?.text === 'string' && typeof value?.background === 'string' ? value : null;
  } catch {
    return null;
  }
}
function writePair(pair: { text: string; background: string }) {
  try {
    localStorage.setItem(PAIR_KEY, JSON.stringify(pair));
  } catch {}
}

// What a color is checked as: text on the background, a fill under the text, or both. Only a
// color used as text fails in red; a fill that misses AA is a fact, often a deliberate one.
type Role = 'text' | 'fill' | 'both';
const ROLE_KEY = 'crewkite-design-roles-v1';
function readRoles(): Record<string, Role> {
  try {
    const value = JSON.parse(localStorage.getItem(ROLE_KEY) ?? '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
function writeRole(name: string, role: Role) {
  try {
    localStorage.setItem(ROLE_KEY, JSON.stringify({ ...readRoles(), [name]: role }));
  } catch {}
}
/**
 * A color named for text is text, one named for a surface is a fill, the rest are both. A name such
 * as accent-ink is text on another color, which the pair cannot judge, so it counts as both.
 */
const guessedRole = (name: string): Role =>
  /^(text|ink|fg|foreground|link|label)(-|$)|-text$/.test(name)
    ? 'text'
    : /(^|-)(background|bg|surface|fill|page|canvas|border|divider|scrim|overlay|backdrop)(-|$)/.test(
          name,
        )
      ? 'fill'
      : 'both';

const pickColor = (names: readonly string[], ...patterns: RegExp[]) => {
  for (const pattern of patterns) {
    const found = names.find((name) => pattern.test(name));
    if (found) return found;
  }
  return undefined;
};
/**
 * The system's own page, surface, border and text colors, so specimens draw on the product's
 * background in either app theme. The contrast pair's background wins when it is set.
 */
function systemColors(model: EditModel, isColor: ColorCheck) {
  const valid = model.tokens.color.flatMap((draft) => {
    const css = cssValue('color', draft.value, isColor);
    return css && draft.name.trim() ? [[draft.name.trim(), css] as const] : [];
  });
  const names = valid.map(([name]) => name);
  const css = (name: string | undefined) => valid.find(([value]) => value === name)?.[1];
  const pair = readPair();
  const backdrop = names.includes(pair?.background ?? '')
    ? pair?.background
    : pickColor(names, /^(background|bg|page|canvas)$/, /background/, /^surface$/);
  const surface = pickColor(names, /^(surface|card|panel)$/, /surface/);
  return {
    '--ds-backdrop': css(backdrop),
    '--ds-surface': css(surface) ?? css(backdrop),
    '--ds-line': css(pickColor(names, /^(border|line|divider)$/, /border/)),
    '--ds-ink': css(
      names.includes(pair?.text ?? '')
        ? pair?.text
        : pickColor(names, /^(text|ink|foreground|fg)$/, /text/),
    ),
  };
}

function Field({
  label,
  value,
  problem,
  multiline = false,
  oneLine = false,
  autoFocus = false,
  placeholder,
  hint,
  onChange,
  code = false,
}: {
  label: string;
  value: string;
  problem?: string;
  multiline?: boolean;
  /** A wrapping field for one line of text. Enter finishes the row and a line break is a space. */
  oneLine?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  hint?: string;
  code?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const described = [problem ? `${id}-problem` : '', hint ? `${id}-hint` : '']
    .filter(Boolean)
    .join(' ');
  const props = {
    id,
    value,
    placeholder,
    autoFocus,
    spellCheck: false,
    'aria-invalid': problem ? true : undefined,
    'aria-describedby': described || undefined,
    className: code ? 'ds-code-field' : undefined,
  };
  return (
    <div className="ds-field">
      <label htmlFor={id}>{label}</label>
      {multiline || oneLine ? (
        <textarea
          {...props}
          rows={oneLine ? 2 : 3}
          data-one-line={oneLine || undefined}
          onChange={(event) =>
            onChange(oneLine ? event.target.value.replace(/\s*\n\s*/g, ' ') : event.target.value)
          }
        />
      ) : (
        <input {...props} autoComplete="off" onChange={(event) => onChange(event.target.value)} />
      )}
      {hint && (
        <small className="ds-hint" id={`${id}-hint`}>
          {hint}
        </small>
      )}
      {problem && (
        <small className="ds-field-error" id={`${id}-problem`}>
          {problem}
        </small>
      )}
    </div>
  );
}

/**
 * Escape puts the row back, Enter in a one-line field finishes it. Neither reaches the sheet. A key
 * that composes text, such as Enter choosing a word in an input method, belongs to the field.
 */
function editKeys(event: KeyboardEvent<HTMLElement>, done: () => void, cancel: () => void) {
  if (event.nativeEvent.isComposing) return;
  const target = event.target;
  const oneLine =
    (target instanceof HTMLInputElement && target.type !== 'color') ||
    (target instanceof HTMLTextAreaElement && target.dataset.oneLine !== undefined);
  if (event.key === 'Escape' && !event.defaultPrevented) {
    event.preventDefault();
    event.stopPropagation();
    cancel();
  } else if (event.key === 'Enter' && !event.shiftKey && oneLine) {
    event.preventDefault();
    done();
  }
}

/**
 * The fields a person has typed in since the row opened. A new row shows no problem under a field
 * before it is touched; the title bar still counts it, and Review stays shut.
 */
function useTouched(editing: boolean) {
  const [touched, setTouched] = useState<ReadonlySet<FieldName>>(new Set());
  useEffect(() => {
    if (!editing) setTouched(new Set());
  }, [editing]);
  const touch = (field: FieldName) =>
    setTouched((now) => (now.has(field) ? now : new Set(now).add(field)));
  return { touched, touch };
}

function useTokenActions(group: TokenGroup, props: EditorProps) {
  const { change, setEditing, editing, focusRow } = props;
  const update = (key: string, patch: Partial<TokenDraft>) =>
    change((model) => ({
      ...model,
      tokens: {
        ...model.tokens,
        [group]: model.tokens[group].map((draft) =>
          draft.key === key ? { ...draft, ...patch } : draft,
        ),
      },
    }));
  // Focus moves to the row that takes the removed one's place, so the keyboard keeps its spot.
  const remove = (key: string) => {
    const drafts = props.model.tokens[group];
    const at = drafts.findIndex((draft) => draft.key === key);
    const neighbour = drafts[at + 1] ?? drafts[at - 1];
    change((model) => ({
      ...model,
      tokens: {
        ...model.tokens,
        [group]: model.tokens[group].filter((draft) => draft.key !== key),
      },
    }));
    setEditing(null);
    focusRow(neighbour?.key ?? `add:${group}`);
  };
  const add = (type: TokenType) => {
    const key = draftKey();
    change((model) => ({
      ...model,
      tokens: {
        ...model.tokens,
        [group]: [...model.tokens[group], { key, name: '', type, value: '', description: '' }],
      },
    }));
    setEditing({ key, snapshot: null });
  };
  const done = (key: string) => {
    setEditing(null);
    focusRow(key);
  };
  const cancel = (key: string) => {
    const snapshot = editing?.key === key ? editing.snapshot : null;
    if (!snapshot) remove(key);
    else {
      change((model) => ({
        ...model,
        tokens: {
          ...model.tokens,
          [group]: model.tokens[group].map((draft) =>
            draft.key === key ? (snapshot as TokenDraft) : draft,
          ),
        },
      }));
      setEditing(null);
      focusRow(key);
    }
  };
  return { update, remove, add, done, cancel };
}

function TokenCard({
  group,
  draft,
  props,
  specimen,
  details,
  after,
  extra,
}: {
  group: TokenGroup;
  draft: TokenDraft;
  props: EditorProps;
  specimen: ReactNode;
  /** Lines under the value in the face, such as contrast results. */
  details?: ReactNode;
  /** Controls beside the face, such as a play button. A button cannot hold another button. */
  after?: ReactNode;
  /** More fields in the editor, such as what a color is checked as. */
  extra?: ReactNode;
}) {
  const actions = useTokenActions(group, props);
  const problems = props.problems.get(draft.key) ?? [];
  const editing = props.editing?.key === draft.key;
  const { touched, touch } = useTouched(editing);
  // A loaded token's problem shows at once; a new row's waits until its field is typed in.
  const problem = (field: FieldName) =>
    draft.original || touched.has(field)
      ? problems.find((value) => value.field === field)?.message
      : undefined;
  const label = draft.name.trim() ? `${group}.${draft.name.trim()}` : newLabel(group);
  const errorId = `${draft.key}-error`;
  const editorId = `${draft.key}-editor`;
  const kinds = KINDS[group];
  return (
    <>
      <li
        className={`ds-token ds-token-${group}${problems.length && !editing ? ' is-invalid' : ''}${editing ? ' is-active' : ''}`}
      >
        <button
          type="button"
          className="ds-token-face"
          data-row={draft.key}
          aria-label={`${label}, ${draft.value || 'no value'}. ${editing ? 'Done' : 'Edit'}`}
          aria-expanded={editing}
          aria-controls={editing ? editorId : undefined}
          aria-describedby={problems.length && !editing ? errorId : undefined}
          onClick={() =>
            editing
              ? actions.done(draft.key)
              : props.setEditing({ key: draft.key, snapshot: draft })
          }
        >
          {specimen}
          <span className="ds-token-text">
            <span className="ds-token-name">{label}</span>
            <span className="ds-token-value">{draft.value || 'No value'}</span>
            {draft.description && <span className="ds-token-description">{draft.description}</span>}
            {details}
          </span>
        </button>
        {after}
        {problems.length > 0 && !editing && (
          <small className="ds-field-error ds-token-error" id={errorId}>
            {problems[0]?.message}
          </small>
        )}
      </li>
      {editing && (
        <EditingCard
          id={editorId}
          className={`ds-token-editor ds-token-${group}`}
          label={`Editing ${label}`}
          onKeyDown={(event) =>
            editKeys(
              event,
              () => actions.done(draft.key),
              () => actions.cancel(draft.key),
            )
          }
        >
          <div className="ds-fields">
            <Field
              label="Name"
              value={draft.name}
              autoFocus
              problem={problem('name')}
              onChange={(name) => {
                touch('name');
                actions.update(draft.key, { name });
              }}
            />
            {kinds && (
              <div className="ds-field">
                <span className="ds-label" id={`${draft.key}-kind`}>
                  Kind
                </span>
                <Select
                  aria-labelledby={`${draft.key}-kind`}
                  value={draft.type}
                  onChange={(event) =>
                    actions.update(draft.key, { type: event.target.value as TokenType })
                  }
                >
                  {kinds.map((kind) => (
                    <option key={kind.type} value={kind.type}>
                      {kind.label}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="ds-value-row">
              <Field
                label="Value"
                value={draft.value}
                code
                problem={problem('value')}
                onChange={(value) => {
                  touch('value');
                  actions.update(draft.key, { value });
                }}
              />
              {group === 'color' && (
                <input
                  type="color"
                  className="ds-picker"
                  aria-label={`Pick ${label}`}
                  value={
                    /^#[0-9a-f]{6}$/i.test(draft.value.trim()) ? draft.value.trim() : '#000000'
                  }
                  onChange={(event) => {
                    touch('value');
                    actions.update(draft.key, { value: event.target.value });
                  }}
                />
              )}
            </div>
            <Field
              label="Description"
              value={draft.description}
              oneLine
              problem={problem('description')}
              placeholder="Where it is used"
              onChange={(description) => {
                touch('description');
                actions.update(draft.key, { description });
              }}
            />
            {extra}
          </div>
          <div className="ds-row-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => actions.done(draft.key)}
            >
              Done
            </button>
            <button type="button" className="button stop" onClick={() => actions.remove(draft.key)}>
              <Trash2 size={13} aria-hidden="true" />
              Remove {NOUN[group]}
            </button>
          </div>
        </EditingCard>
      )}
    </>
  );
}

/** A row in edit mode. It scrolls fully into view when it opens, so its fields and buttons show. */
function EditingCard({
  id,
  className,
  label,
  onKeyDown,
  children,
}: {
  id?: string;
  className: string;
  label: string;
  onKeyDown: (event: KeyboardEvent<HTMLLIElement>) => void;
  children: ReactNode;
}) {
  const card = useRef<HTMLLIElement>(null);
  useEffect(() => {
    card.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  return (
    <li ref={card} id={id} className={className} aria-label={label} onKeyDown={onKeyDown}>
      {children}
    </li>
  );
}

function EmptyLine({ filter, noun }: { filter: string; noun: string }) {
  return (
    <p className="ds-empty-line">
      {filter ? `No ${noun} matches "${filter}".` : `No ${noun} yet.`}
    </p>
  );
}

function AddButton({ label, row, onClick }: { label: string; row?: string; onClick: () => void }) {
  return (
    <button type="button" className="button secondary ds-add" data-row={row} onClick={onClick}>
      <Plus size={13} aria-hidden="true" />
      {label}
    </button>
  );
}

function ColorsEditor(props: EditorProps) {
  const ids = useId();
  const drafts = props.model.tokens.color;
  const actions = useTokenActions('color', props);
  const named = drafts.filter(
    (draft) => draft.name.trim() && cssValue('color', draft.value, props.isColor),
  );
  const names = named.map((draft) => draft.name.trim());
  const saved = readPair();
  const pick = (wanted: string | undefined, hints: RegExp, fallback: string | undefined) =>
    wanted && names.includes(wanted)
      ? wanted
      : (names.find((name) => hints.test(name)) ?? fallback ?? '');
  const [pair, setPair] = useState(() => ({
    text: pick(saved?.text, /^(text|ink|foreground|fg)$|text/i, names[0]),
    background: pick(saved?.background, /^(background|bg|page|surface)$|background/i, names.at(-1)),
  }));
  const text = pick(pair.text, /^(text|ink|foreground|fg)$|text/i, names[0]);
  const background = pick(
    pair.background,
    /^(background|bg|page|surface)$|background/i,
    names.at(-1),
  );
  const choose = (next: { text: string; background: string }) => {
    setPair(next);
    writePair(next);
  };
  const [roles, setRoles] = useState(readRoles);
  const roleOf = (name: string) => roles[name] ?? guessedRole(name);
  const assign = (name: string, role: Role) => {
    setRoles((now) => ({ ...now, [name]: role }));
    writeRole(name, role);
  };
  const valueNamed = (name: string) =>
    named.find((draft) => draft.name.trim() === name)?.value.trim();
  const textColor = valueNamed(text);
  const backgroundColor = valueNamed(background);
  const textRgba = textColor ? resolveColor(textColor, props.isColor) : null;
  const backgroundRgba = backgroundColor ? resolveColor(backgroundColor, props.isColor) : null;
  const shown = drafts.filter((draft) =>
    matches(props.filter, draft.name, draft.value, draft.description),
  );
  return (
    <>
      {names.length > 1 && (
        <fieldset className="ds-pair">
          <legend>Contrast pair</legend>
          <div className="ds-field">
            <span className="ds-label" id={`${ids}-text`}>
              Text
            </span>
            <Select
              aria-labelledby={`${ids}-text`}
              value={text}
              onChange={(event) => choose({ text: event.target.value, background })}
            >
              {names.map((name) => (
                <option key={name} value={name}>
                  color.{name}
                </option>
              ))}
            </Select>
          </div>
          <div className="ds-field">
            <span className="ds-label" id={`${ids}-background`}>
              Background
            </span>
            <Select
              aria-labelledby={`${ids}-background`}
              value={background}
              onChange={(event) => choose({ text, background: event.target.value })}
            >
              {names.map((name) => (
                <option key={name} value={name}>
                  color.{name}
                </option>
              ))}
            </Select>
          </div>
          <p className="ds-hint">
            As text is the swatch on the background; as fill is the text on the swatch. AA for body
            text is 4.5:1. Only a color used as text shows a miss in red.
          </p>
        </fieldset>
      )}
      <ul className="ds-grid ds-swatches" style={vars(systemColors(props.model, props.isColor))}>
        {shown.map((draft) => {
          const css = cssValue('color', draft.value, props.isColor);
          const rgba = css ? resolveColor(css, props.isColor) : null;
          const name = draft.name.trim();
          const role = roleOf(name);
          const lines =
            rgba && backgroundRgba && textRgba
              ? [
                  name !== background && role !== 'fill'
                    ? {
                        text: `As text ${contrastLabel(contrastRatio(rgba, backgroundRgba))}`,
                        loud: role === 'text',
                      }
                    : null,
                  name !== text && role !== 'text'
                    ? {
                        text: `As fill ${contrastLabel(
                          contrastRatio(textRgba, over(rgba, backgroundRgba)),
                        )}`,
                        loud: false,
                      }
                    : null,
                ].filter((line) => line !== null)
              : [];
          return (
            <TokenCard
              key={draft.key}
              group="color"
              draft={draft}
              props={props}
              specimen={
                <span
                  className={css ? 'ds-chip' : 'ds-chip is-unknown'}
                  style={vars({ '--ds-swatch': css })}
                  aria-hidden="true"
                />
              }
              details={
                <span className="ds-contrast">
                  {lines.map((line) => (
                    <span
                      key={line.text}
                      className={
                        line.text.endsWith('fails AA')
                          ? line.loud
                            ? 'is-fail'
                            : 'is-quiet-fail'
                          : undefined
                      }
                    >
                      {line.text}
                    </span>
                  ))}
                </span>
              }
              extra={
                name && (
                  <fieldset className="ds-role">
                    <legend className="ds-label">Check contrast as</legend>
                    {(['text', 'fill', 'both'] as const).map((value) => (
                      <label key={value} className={role === value ? 'is-on' : undefined}>
                        <input
                          type="radio"
                          name={`${draft.key}-role`}
                          checked={role === value}
                          onChange={() => assign(name, value)}
                        />
                        {value === 'text' ? 'Text' : value === 'fill' ? 'Fill' : 'Both'}
                      </label>
                    ))}
                  </fieldset>
                )
              }
            />
          );
        })}
      </ul>
      {shown.length === 0 && <EmptyLine filter={props.filter} noun="color" />}
      <div className="ds-adds">
        <AddButton label="Add color" row="add:color" onClick={() => actions.add('color')} />
      </div>
    </>
  );
}

function TypeEditor(props: EditorProps) {
  const ids = useId();
  const drafts = props.model.tokens.type;
  const actions = useTokenActions('type', props);
  const families = drafts.filter((draft) => draft.type === 'fontFamily' && draft.name.trim());
  const weights = drafts.filter((draft) => draft.type === 'fontWeight' && draft.name.trim());
  const [family, setFamily] = useState('');
  const [weight, setWeight] = useState('');
  const [sample, setSample] = useState('The quick brown fox jumps over the lazy dog');
  const chosenFamily = families.find((draft) => draft.key === family) ?? families[0];
  const chosenWeight = weights.find((draft) => draft.key === weight) ?? weights[0];
  const familyCss = chosenFamily ? cssValue('fontFamily', chosenFamily.value, props.isColor) : null;
  const weightParsed = chosenWeight
    ? parseValue('fontWeight', chosenWeight.value, props.isColor)
    : null;
  const weightCss =
    weightParsed && 'value' in weightParsed && typeof weightParsed.value === 'number'
      ? String(weightParsed.value)
      : undefined;
  const shown = drafts.filter((draft) =>
    matches(props.filter, draft.name, draft.value, draft.description),
  );
  const specimen = (draft: TokenDraft) => {
    const css = cssValue(draft.type, draft.value, props.isColor);
    if (!css)
      return (
        <span className="ds-type-sample is-unknown" aria-hidden="true">
          Aa
        </span>
      );
    const style = vars(
      draft.type === 'fontFamily'
        ? { '--ds-family': css }
        : draft.type === 'fontWeight'
          ? { '--ds-family': familyCss, '--ds-weight': css }
          : draft.type === 'dimension'
            ? { '--ds-family': familyCss, '--ds-weight': weightCss, '--ds-size': css }
            : { '--ds-family': familyCss, '--ds-leading': css },
    );
    return (
      <span className={`ds-type-sample is-${draft.type}`} style={style} aria-hidden="true">
        {draft.type === 'dimension' || draft.type === 'number' ? sample || 'Aa' : 'Aa Bb Gg 0123'}
      </span>
    );
  };
  return (
    <>
      <fieldset className="ds-pair ds-type-controls">
        <legend>Specimen</legend>
        <div className="ds-field">
          <span className="ds-label" id={`${ids}-family`}>
            Family
          </span>
          <Select
            aria-labelledby={`${ids}-family`}
            value={chosenFamily?.key ?? ''}
            disabled={!families.length}
            onChange={(event) => setFamily(event.target.value)}
          >
            {families.length ? (
              families.map((draft) => (
                <option key={draft.key} value={draft.key}>
                  type.{draft.name.trim()}
                </option>
              ))
            ) : (
              <option value="">No family tokens</option>
            )}
          </Select>
        </div>
        <div className="ds-field">
          <span className="ds-label" id={`${ids}-weight`}>
            Weight
          </span>
          <Select
            aria-labelledby={`${ids}-weight`}
            value={chosenWeight?.key ?? ''}
            disabled={!weights.length}
            onChange={(event) => setWeight(event.target.value)}
          >
            {weights.length ? (
              weights.map((draft) => (
                <option key={draft.key} value={draft.key}>
                  type.{draft.name.trim()}
                </option>
              ))
            ) : (
              <option value="">No weight tokens</option>
            )}
          </Select>
        </div>
        <div className="ds-field ds-sample-field">
          <label htmlFor={`${ids}-sample`}>Sample</label>
          <input
            id={`${ids}-sample`}
            value={sample}
            onChange={(event) => setSample(event.target.value)}
          />
        </div>
      </fieldset>
      <ul className="ds-list ds-type">
        {shown.map((draft) => (
          <TokenCard
            key={draft.key}
            group="type"
            draft={draft}
            props={props}
            specimen={specimen(draft)}
          />
        ))}
      </ul>
      {shown.length === 0 && <EmptyLine filter={props.filter} noun="type token" />}
      <div className="ds-adds">
        <AddButton label="Add family" row="add:type" onClick={() => actions.add('fontFamily')} />
        <AddButton label="Add weight" onClick={() => actions.add('fontWeight')} />
        <AddButton label="Add size" onClick={() => actions.add('dimension')} />
        <AddButton label="Add line height" onClick={() => actions.add('number')} />
      </div>
    </>
  );
}

/** Pixels for a px or rem size, at the 16 px root every browser starts with. */
const pixels = (text: string, isColor: ColorCheck) => {
  const parsed = parseValue('dimension', text, isColor);
  if ('problem' in parsed) return null;
  const size = parsed.value as { value: number; unit: string };
  return size.unit === 'rem' ? size.value * 16 : size.value;
};

function SpacingEditor(props: EditorProps) {
  const actions = useTokenActions('spacing', props);
  const shown = props.model.tokens.spacing.filter((draft) =>
    matches(props.filter, draft.name, draft.value, draft.description),
  );
  // Small steps are hard to tell apart at their true size, so the ruler zooms until the largest
  // step fills about half the track. The grid zooms with it.
  const largest = Math.max(
    0,
    ...props.model.tokens.spacing.map((draft) => pixels(draft.value, props.isColor) ?? 0),
  );
  const zoom = largest <= 40 ? 6 : largest <= 64 ? 4 : largest <= 128 ? 2 : 1;
  return (
    <>
      <p className="ds-hint">
        {zoom > 1 ? `Shown at ${zoom} times their size on a 4 px grid.` : 'Shown on a 4 px grid.'} A
        value off the 2 px step is marked.
      </p>
      <ul
        className="ds-list ds-ruler"
        style={vars({ '--ds-zoom': String(zoom), '--ds-grid': `${4 * zoom}px` })}
      >
        {shown.map((draft) => {
          const css = cssValue('dimension', draft.value, props.isColor);
          const size = pixels(draft.value, props.isColor);
          return (
            <TokenCard
              key={draft.key}
              group="spacing"
              draft={draft}
              props={props}
              specimen={
                <span className="ds-bar-track" aria-hidden="true">
                  <span className="ds-bar" style={vars({ '--ds-size': css })} />
                </span>
              }
              details={
                size !== null && size % 2 !== 0 && <span className="ds-badge">Off grid</span>
              }
            />
          );
        })}
      </ul>
      {shown.length === 0 && <EmptyLine filter={props.filter} noun="spacing step" />}
      <div className="ds-adds">
        <AddButton
          label="Add spacing step"
          row="add:spacing"
          onClick={() => actions.add('dimension')}
        />
      </div>
    </>
  );
}

function SampleEditor({ group, props }: { group: 'radius' | 'shadow'; props: EditorProps }) {
  const actions = useTokenActions(group, props);
  const shown = props.model.tokens[group].filter((draft) =>
    matches(props.filter, draft.name, draft.value, draft.description),
  );
  return (
    <>
      <ul className="ds-grid ds-samples" style={vars(systemColors(props.model, props.isColor))}>
        {shown.map((draft) => {
          const css = cssValue(
            group === 'radius' ? 'dimension' : 'shadow',
            draft.value,
            props.isColor,
          );
          return (
            <TokenCard
              key={draft.key}
              group={group}
              draft={draft}
              props={props}
              specimen={
                // The stage is the system's own background, so a dark shadow shows in either
                // app theme.
                <span className="ds-stage" aria-hidden="true">
                  <span
                    className={`ds-sample ds-sample-${group}${css ? '' : ' is-unknown'}`}
                    style={vars({ [group === 'radius' ? '--ds-radius' : '--ds-shadow']: css })}
                  />
                </span>
              }
            />
          );
        })}
      </ul>
      {shown.length === 0 && <EmptyLine filter={props.filter} noun={NOUN[group]} />}
      <div className="ds-adds">
        <AddButton
          label={`Add ${NOUN[group]}`}
          row={`add:${group}`}
          onClick={() => actions.add(GROUP_TYPE[group] ?? 'dimension')}
        />
      </div>
    </>
  );
}

function MotionEditor(props: EditorProps) {
  const actions = useTokenActions('motion', props);
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const drafts = props.model.tokens.motion;
  const dots = useRef(new Map<string, HTMLSpanElement>());
  const firstOf = (type: TokenType) =>
    drafts
      .filter((draft) => draft.type === type)
      .map((draft) => cssValue(type, draft.value, props.isColor))
      .find((css): css is string => css !== null);
  // A duration plays with the first easing, and an easing with the first duration, so each token
  // is seen in the company it keeps.
  const play = (draft: TokenDraft) => {
    const dot = dots.current.get(draft.key);
    const css = cssValue(draft.type, draft.value, props.isColor);
    if (!dot || !css) return;
    const parsed = parseValue(
      'duration',
      draft.type === 'duration' ? draft.value : (firstOf('duration') ?? '400ms'),
      props.isColor,
    );
    const duration =
      'value' in parsed
        ? (parsed.value as { value: number; unit: string })
        : { value: 400, unit: 'ms' };
    const travel = (dot.parentElement?.clientWidth ?? 0) - dot.offsetWidth;
    dot.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${travel}px)` }], {
      duration: duration.unit === 's' ? duration.value * 1000 : duration.value,
      easing: draft.type === 'cubicBezier' ? css : (firstOf('cubicBezier') ?? 'ease'),
      fill: 'none',
    });
  };
  const shown = drafts.filter((draft) =>
    matches(props.filter, draft.name, draft.value, draft.description),
  );
  return (
    <>
      {reduced && (
        <p className="ds-hint">
          This machine asks for reduced motion, so the values show without playing.
        </p>
      )}
      <ul className="ds-list ds-motion">
        {shown.map((draft) => (
          <TokenCard
            key={draft.key}
            group="motion"
            draft={draft}
            props={props}
            specimen={
              <span className="ds-track" aria-hidden="true">
                <span
                  className="ds-dot"
                  ref={(node) => {
                    if (node) dots.current.set(draft.key, node);
                    else dots.current.delete(draft.key);
                  }}
                />
              </span>
            }
            after={
              !reduced && (
                <button
                  type="button"
                  className="icon-button ds-play"
                  aria-label={`Play motion.${draft.name.trim() || '(unnamed)'}`}
                  disabled={!cssValue(draft.type, draft.value, props.isColor)}
                  onClick={() => play(draft)}
                >
                  <Play size={14} aria-hidden="true" />
                </button>
              )
            }
          />
        ))}
      </ul>
      {shown.length === 0 && <EmptyLine filter={props.filter} noun="motion token" />}
      <div className="ds-adds">
        <AddButton label="Add duration" row="add:motion" onClick={() => actions.add('duration')} />
        <AddButton label="Add easing" onClick={() => actions.add('cubicBezier')} />
      </div>
    </>
  );
}

function ItemsEditor({
  category,
  props,
}: {
  category: 'components' | 'rules';
  props: EditorProps;
}) {
  const { change, setEditing, editing, focusRow } = props;
  const noun = category === 'components' ? 'component' : 'rule';
  const drafts = props.model[category];
  const [dragging, setDragging] = useState<string | null>(null);
  const set = (next: (items: ItemDraft[]) => ItemDraft[]) =>
    change((model) => ({ ...model, [category]: next(model[category]) }));
  const update = (key: string, patch: Partial<ItemDraft>) =>
    set((items) => items.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  // Focus stays on what moved the row: its handle or its card.
  const move = (key: string, step: number, focus = key) => {
    set((items) => {
      const from = items.findIndex((item) => item.key === key);
      const to = from + step;
      if (from < 0 || to < 0 || to >= items.length) return items;
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved as ItemDraft);
      return next;
    });
    focusRow(focus);
  };
  const remove = (key: string) => {
    const at = drafts.findIndex((item) => item.key === key);
    const neighbour = drafts[at + 1] ?? drafts[at - 1];
    set((items) => items.filter((item) => item.key !== key));
    setEditing(null);
    focusRow(neighbour?.key ?? `add:${category}`);
  };
  const cancel = (key: string) => {
    const snapshot = editing?.key === key ? editing.snapshot : null;
    if (!snapshot) remove(key);
    else {
      set((items) => items.map((item) => (item.key === key ? (snapshot as ItemDraft) : item)));
      setEditing(null);
      focusRow(key);
    }
  };
  const done = (key: string) => {
    setEditing(null);
    focusRow(key);
  };
  const drop = (target: string) => {
    if (!dragging || dragging === target) return;
    const moving = dragging;
    set((items) => {
      const from = items.findIndex((item) => item.key === moving);
      const to = items.findIndex((item) => item.key === target);
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved as ItemDraft);
      return next;
    });
    setDragging(null);
  };
  const shown = drafts.filter((draft) =>
    matches(props.filter, draft.title, draft.do, draft.dont, draft.example),
  );
  return (
    <>
      <p className="ds-hint">
        Drag a {noun} by its handle, or focus the handle and press Up or Down. Alt+Up and Alt+Down
        move a focused {noun} too.
      </p>
      <ul className="ds-list ds-items">
        {shown.map((draft) => (
          <ItemRow
            key={draft.key}
            category={category}
            draft={draft}
            problems={props.problems.get(draft.key) ?? []}
            editing={editing?.key === draft.key}
            index={drafts.indexOf(draft)}
            count={drafts.length}
            dragging={dragging}
            onEdit={() => setEditing({ key: draft.key, snapshot: draft })}
            onUpdate={(patch) => update(draft.key, patch)}
            onMove={(step, handle) =>
              move(draft.key, step, handle ? `move:${draft.key}` : draft.key)
            }
            onRemove={() => remove(draft.key)}
            onDone={() => done(draft.key)}
            onCancel={() => cancel(draft.key)}
            onDrag={(key) => setDragging(key)}
            onDrop={() => drop(draft.key)}
          />
        ))}
      </ul>
      {shown.length === 0 && <EmptyLine filter={props.filter} noun={noun} />}
      <div className="ds-adds">
        <AddButton
          label={`Add ${noun}`}
          row={`add:${category}`}
          onClick={() => {
            const key = draftKey();
            set((items) => [...items, { key, id: null, title: '', do: '', dont: '', example: '' }]);
            setEditing({ key, snapshot: null });
          }}
        />
      </div>
    </>
  );
}

function ItemRow({
  category,
  draft,
  problems,
  editing,
  index,
  count,
  dragging,
  onEdit,
  onUpdate,
  onMove,
  onRemove,
  onDone,
  onCancel,
  onDrag,
  onDrop,
}: {
  category: 'components' | 'rules';
  draft: ItemDraft;
  problems: readonly Problem[];
  editing: boolean;
  index: number;
  count: number;
  dragging: string | null;
  onEdit: () => void;
  onUpdate: (patch: Partial<ItemDraft>) => void;
  onMove: (step: number, handle?: boolean) => void;
  onRemove: () => void;
  onDone: () => void;
  onCancel: () => void;
  onDrag: (key: string | null) => void;
  onDrop: () => void;
}) {
  const noun = category === 'components' ? 'component' : 'rule';
  const { touched, touch } = useTouched(editing);
  const card = useRef<HTMLLIElement>(null);
  const problem = (field: FieldName) =>
    draft.original || touched.has(field)
      ? problems.find((value) => value.field === field)?.message
      : undefined;
  const title = draft.title.trim() || newLabel(category);
  const name = title.replace(/\.$/, '');
  if (!editing)
    return (
      <li
        ref={card}
        className={`ds-item${problems.length ? ' is-invalid' : ''}${dragging === draft.key ? ' is-dragging' : ''}`}
        onDragOver={(event) => {
          if (dragging && dragging !== draft.key) event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          onDrop();
        }}
      >
        <button
          type="button"
          className="icon-button ds-handle"
          draggable
          aria-label={`Move ${name}, ${index + 1} of ${count}`}
          aria-keyshortcuts="ArrowUp ArrowDown"
          data-row={`move:${draft.key}`}
          onDragStart={(event) => {
            onDrag(draft.key);
            event.dataTransfer.effectAllowed = 'move';
            if (card.current) event.dataTransfer.setDragImage(card.current, 16, 16);
          }}
          onDragEnd={() => onDrag(null)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            onMove(event.key === 'ArrowUp' ? -1 : 1, true);
          }}
        >
          <GripVertical size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ds-item-face"
          data-row={draft.key}
          aria-label={`${name}. Edit`}
          aria-describedby={problems.length ? `${draft.key}-error` : undefined}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          onClick={onEdit}
          onKeyDown={(event) => {
            if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
            event.preventDefault();
            onMove(event.key === 'ArrowUp' ? -1 : 1);
          }}
        >
          <span className="ds-item-title">{title}</span>
          {draft.do.trim() && (
            <span className="ds-item-lines is-do">
              <span className="ds-item-label">Do</span>
              {draft.do
                .split('\n')
                .filter((line) => line.trim())
                .map((line) => (
                  <span key={line}>{line.trim()}</span>
                ))}
            </span>
          )}
          {draft.dont.trim() && (
            <span className="ds-item-lines is-dont">
              <span className="ds-item-label">Do not</span>
              {draft.dont
                .split('\n')
                .filter((line) => line.trim())
                .map((line) => (
                  <span key={line}>{line.trim()}</span>
                ))}
            </span>
          )}
          {draft.example.trim() && <code className="ds-example">{draft.example}</code>}
        </button>
        <button
          type="button"
          className="icon-button ds-item-remove"
          aria-label={`Remove ${name}`}
          title={`Remove ${noun}`}
          onClick={onRemove}
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
        {problems.length > 0 && (
          <small className="ds-field-error ds-item-error" id={`${draft.key}-error`}>
            {problems[0]?.message}
          </small>
        )}
      </li>
    );
  return (
    <EditingCard
      className="ds-item is-editing"
      label={`Editing ${name}`}
      onKeyDown={(event) => editKeys(event, onDone, onCancel)}
    >
      <div className="ds-fields">
        <Field
          label={category === 'components' ? 'Name' : 'Rule'}
          value={draft.title}
          autoFocus
          problem={problem('title')}
          onChange={(value) => {
            touch('title');
            onUpdate({ title: value });
          }}
        />
        <Field
          label="Do"
          value={draft.do}
          multiline
          hint="One line each."
          problem={problem('do')}
          onChange={(value) => {
            touch('do');
            onUpdate({ do: value });
          }}
        />
        <Field
          label="Do not"
          value={draft.dont}
          multiline
          hint="One line each."
          problem={problem('dont')}
          onChange={(value) => {
            touch('dont');
            onUpdate({ dont: value });
          }}
        />
        <Field
          label="Example"
          value={draft.example}
          multiline
          code
          hint="Code or text that shows the rule. Required."
          problem={problem('example')}
          onChange={(value) => {
            touch('example');
            onUpdate({ example: value });
          }}
        />
      </div>
      <div className="ds-row-actions">
        <button type="button" className="button secondary" onClick={onDone}>
          Done
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={index <= 0}
          onClick={() => onMove(-1)}
        >
          <ArrowUp size={13} aria-hidden="true" />
          Move up
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={index >= count - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown size={13} aria-hidden="true" />
          Move down
        </button>
        <button type="button" className="button stop" onClick={onRemove}>
          <Trash2 size={13} aria-hidden="true" />
          Remove {noun}
        </button>
      </div>
    </EditingCard>
  );
}

export function CategoryEditor({ category, ...props }: EditorProps & { category: Category }) {
  switch (category) {
    case 'color':
      return <ColorsEditor {...props} />;
    case 'type':
      return <TypeEditor {...props} />;
    case 'spacing':
      return <SpacingEditor {...props} />;
    case 'radius':
    case 'shadow':
      return <SampleEditor group={category} props={props} />;
    case 'motion':
      return <MotionEditor {...props} />;
    case 'components':
    case 'rules':
      return <ItemsEditor category={category} props={props} />;
  }
}
