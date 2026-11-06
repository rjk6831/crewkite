import { Check, ChevronDown } from 'lucide-react';
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { nextEnabled, selectOptions, typedMatch } from './select-options.ts';
import './select.css';

/**
 * CrewKite's dropdown. It takes the same markup as a native select, `<option>` and `<optgroup>`
 * children with a value and an onChange that reads `event.target.value`, so a form moves to it
 * by changing the tag. The closed control keeps the native select's size; the open list is drawn
 * with the app's tokens, the same way the model picker's menu is, and never by the system.
 */
type SelectProps = {
  id?: string;
  className?: string;
  value: string | number;
  disabled?: boolean;
  title?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  onChange?: (event: { target: { value: string } }) => void;
  children?: ReactNode;
};

const GAP = 4;
const MARGIN = 8;
const MAX_HEIGHT = 320;

export function Select({
  id,
  className,
  value,
  disabled,
  title,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledby,
  'aria-describedby': ariaDescribedby,
  onChange,
  children,
}: SelectProps) {
  const options = selectOptions(children);
  const current = String(value);
  const selected = options.findIndex((option) => option.value === current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const listId = useId();
  const optionId = (index: number) => `${listId}-${index}`;

  // The list opens under the control and turns above it when there is more room there. It is at
  // least as wide as the control, and scrolls within the window's height.
  const measure = useCallback(() => {
    const box = trigger.current?.getBoundingClientRect();
    if (!box) return;
    const below = window.innerHeight - box.bottom - GAP - MARGIN;
    const above = box.top - GAP - MARGIN;
    const up = below < Math.min(MAX_HEIGHT, 180) && above > below;
    const width = Math.max(box.width, 120);
    const left = Math.min(box.left, window.innerWidth - width - MARGIN);
    setPlace({
      left: Math.max(MARGIN, left),
      minWidth: width,
      maxWidth: Math.max(width, Math.min(420, window.innerWidth - 2 * MARGIN)),
      maxHeight: Math.min(MAX_HEIGHT, up ? above : below),
      ...(up ? { bottom: window.innerHeight - box.top + GAP } : { top: box.bottom + GAP }),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const update = () => measure();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (trigger.current?.contains(target) || list.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [open, measure]);

  // The active option stays in view as the keys move it.
  useEffect(() => {
    if (!open || active < 0) return;
    list.current?.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({
      block: 'nearest',
    });
  });

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const show = () => {
    if (disabled) return;
    setActive(
      selected >= 0 && !options[selected]?.disabled ? selected : nextEnabled(options, -1, 1),
    );
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    close();
    if (option.value !== current) onChange?.({ target: { value: option.value } });
  };

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const key = event.key;
    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        event.preventDefault();
        show();
      }
      return;
    }
    if (key === 'Escape') {
      // The list closes and nothing behind it, such as Settings or a dialog, sees the key.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (key === 'Tab') {
      setOpen(false);
    } else if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => nextEnabled(options, index, key === 'ArrowDown' ? 1 : -1));
    } else if (key === 'Home' || key === 'End') {
      event.preventDefault();
      setActive(
        key === 'Home' ? nextEnabled(options, -1, 1) : nextEnabled(options, options.length, -1),
      );
    } else if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      choose(active);
    } else if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      typed.current = {
        text: now - typed.current.at < 600 ? typed.current.text + key : key,
        at: now,
      };
      const from = typed.current.text.length > 1 ? active - 1 : active;
      setActive(typedMatch(options, from, typed.current.text));
    }
  }

  let lastGroup: string | null = null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        id={id}
        className={className ? `ck-select ${className}` : 'ck-select'}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        aria-describedby={ariaDescribedby}
        disabled={disabled}
        title={title}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKeyDown}
      >
        <span className="ck-select-value">{selected >= 0 ? options[selected]?.label : ''}</span>
        <ChevronDown size={14} aria-hidden="true" className="ck-select-chevron" />
      </button>
      {open &&
        createPortal(
          <div
            ref={list}
            id={listId}
            role="listbox"
            className="ck-select-list"
            style={place}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabel ? undefined : (ariaLabelledby ?? id)}
          >
            {options.map((option, index) => {
              const heading = option.group !== lastGroup ? option.group : null;
              lastGroup = option.group;
              return (
                <Fragment key={`${option.group ?? ''}/${option.value}`}>
                  {heading && (
                    <div className="ck-select-group" role="presentation">
                      {heading}
                    </div>
                  )}
                  {/* Focus stays on the combobox and aria-activedescendant names the option, as
                      the WAI-ARIA combobox pattern has it, so an option takes the pointer only. */}
                  {/* biome-ignore lint/a11y/useFocusableInteractive: focus stays on the combobox */}
                  {/* biome-ignore lint/a11y/useKeyWithClickEvents: the combobox handles the keys */}
                  <div
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === selected}
                    aria-disabled={option.disabled || undefined}
                    title={option.title}
                    className={[
                      'ck-select-option',
                      index === active ? 'is-active' : '',
                      option.group ? 'in-group' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onPointerMove={() => !option.disabled && setActive(index)}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => choose(index)}
                  >
                    <span>{option.label}</span>
                    {index === selected && <Check size={13} aria-hidden="true" />}
                  </div>
                </Fragment>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
