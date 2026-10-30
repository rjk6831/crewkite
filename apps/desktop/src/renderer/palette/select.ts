export type Selectable = { key: string; explicit: boolean };

/**
 * The option Enter would run. A person who moved with the arrows or the pointer chose `active`,
 * and that one runs even when it is explicit. Otherwise the top match runs only when it is not
 * explicit, so typing "push" and pressing Enter does nothing. Nothing is skipped to reach a lower
 * match, because the person did not pick that one.
 */
export function selectedOption<T extends Selectable>(
  enabled: readonly T[],
  active: string | null,
): T | null {
  const chosen = active === null ? undefined : enabled.find((option) => option.key === active);
  if (chosen) return chosen;
  const top = enabled[0];
  return top && !top.explicit ? top : null;
}
