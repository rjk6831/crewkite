import { Ellipsis } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

/**
 * The menu under a finished reply. Copy reply puts the Markdown the model wrote on the clipboard,
 * so a table or a code fence pastes as source.
 */
export function ReplyMenu({ source }: { source: string }) {
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    items.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const away = (event: MouseEvent) => {
      if (!items.current?.contains(event.target as Node) && event.target !== trigger.current)
        setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  useEffect(() => {
    if (!said) return;
    const timer = window.setTimeout(() => setSaid(null), 2500);
    return () => window.clearTimeout(timer);
  }, [said]);
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  async function copy() {
    close();
    try {
      await navigator.clipboard.writeText(source);
      setSaid('Reply copied');
    } catch {
      // The clipboard can be blocked. The reply stays selectable.
      setSaid('The reply was not copied. Select its text instead.');
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      close();
    }
  }
  return (
    <div className="th-reply-menu">
      <button
        ref={trigger}
        type="button"
        className="th-icon"
        aria-label="Reply actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
      >
        <Ellipsis size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={items}
          id={menuId}
          className="th-menu th-reply-items"
          role="menu"
          aria-label="Reply actions"
          onKeyDown={onKeyDown}
        >
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => void copy()}>
            Copy reply
          </button>
        </div>
      )}
      {said && <span className="th-muted th-reply-said">{said}</span>}
    </div>
  );
}
