/**
 * Moves the view and the focus to a heading or card on the settings page. The page may not be on
 * screen yet, so this looks again on each frame for a short while before it gives up.
 */
export function focusSection(id: string, frames = 60): void {
  if (typeof requestAnimationFrame !== 'function') return;
  const look = (left: number) => {
    const target = document.getElementById(id);
    if (target) {
      // A heading or card is not focusable until it is given a tab index that no key reaches.
      target.tabIndex = -1;
      target.scrollIntoView({ block: 'start' });
      target.focus({ preventScroll: true });
    } else if (left > 0) requestAnimationFrame(() => look(left - 1));
  };
  requestAnimationFrame(() => look(frames));
}
