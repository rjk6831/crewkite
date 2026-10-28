import './composer-menu.css';

export type MenuItem = { key: string; label: string; detail: string | null };

/**
 * The list under an at sign or a slash. The text box keeps focus and owns the keys, so this only
 * draws the choices and takes a click. `aria-activedescendant` on the box points at the chosen row.
 */
export function CompleteMenu({
  id,
  label,
  items,
  active,
  onPick,
}: {
  id: string;
  label: string;
  items: readonly MenuItem[];
  active: number;
  onPick: (index: number) => void;
}) {
  return (
    <div className="th-complete">
      <div className="th-complete-list" id={id} role="listbox" aria-label={label}>
        {items.map((item, index) => (
          <div
            key={item.key}
            id={`${id}-${index}`}
            role="option"
            tabIndex={-1}
            aria-selected={index === active}
            className="th-complete-item"
            onMouseDown={(event) => {
              // The box keeps its caret.
              event.preventDefault();
              onPick(index);
            }}
          >
            <span className="th-complete-label">{item.label}</span>
            {item.detail && <small>{item.detail}</small>}
          </div>
        ))}
      </div>
    </div>
  );
}
