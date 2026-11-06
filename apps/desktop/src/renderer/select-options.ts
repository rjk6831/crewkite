import { Children, Fragment, isValidElement, type ReactNode } from 'react';

// The pure part of the dropdown: reading native option markup and moving over it. Kept apart from
// the component so tests run without a DOM or style sheets.

export type SelectOption = {
  value: string;
  label: string;
  disabled: boolean;
  title?: string;
  group: string | null;
};

const text = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return '';
};

/** The options a native select would list, in order, with their group. */
export function selectOptions(children: ReactNode, group: string | null = null): SelectOption[] {
  return Children.toArray(children).flatMap((child): SelectOption[] => {
    if (!isValidElement<Record<string, unknown>>(child)) return [];
    const props = child.props;
    if (child.type === Fragment) return selectOptions(props.children as ReactNode, group);
    if (child.type === 'optgroup')
      return selectOptions(props.children as ReactNode, String(props.label ?? ''));
    if (child.type !== 'option') return [];
    const label = text(props.children as ReactNode);
    return [
      {
        value: props.value === undefined ? label : String(props.value),
        label,
        disabled: props.disabled === true,
        ...(typeof props.title === 'string' ? { title: props.title } : {}),
        group,
      },
    ];
  });
}

/** The next enabled option from `from` in `step` direction, or `from` when there is none. */
export function nextEnabled(options: readonly SelectOption[], from: number, step: 1 | -1): number {
  for (let index = from + step; index >= 0 && index < options.length; index += step)
    if (!options[index]?.disabled) return index;
  return from;
}

/** The first enabled option after `from` whose label starts with `typed`, wrapping once. */
export function typedMatch(options: readonly SelectOption[], from: number, typed: string): number {
  const wanted = typed.toLowerCase();
  for (let offset = 1; offset <= options.length; offset++) {
    const index = (from + offset) % options.length;
    const option = options[index];
    if (option && !option.disabled && option.label.toLowerCase().startsWith(wanted)) return index;
  }
  return from;
}
