import type {
  ChatCatalogRead,
  ChatEffort,
  ChatFamily,
  ChatModelSelection,
} from '@crewkite/contracts';
import { effortLevels, modelGroups } from '../../../desktop/src/renderer/thread/model-groups.ts';

// The lists the interactive CLI opens from a slash command. Each is a pure function of what the
// controller read, so a test checks the rows and the app only holds the cursor and the filter.

/** One row of the model list. `effort` is the level the row will pick, which Left and Right move. */
export type ModelRow = {
  family: ChatFamily;
  model: string;
  label: string;
  efforts: ChatEffort[];
  effort: ChatEffort;
};
export type ModelGroup = { family: ChatFamily; rows: ModelRow[] };

/** The text a model row matches against: its ID, its label and its family. */
const haystack = (row: ModelRow) => `${row.model} ${row.label} ${row.family}`.toLowerCase();

/**
 * Every connected family's models, grouped by family in catalog order. Listed models come first,
 * then the hidden ones, the ones CrewKite knows and the ones an earlier turn used. Each row starts
 * on the current selection's effort when the row is the current model, else on the model's
 * default. Typing narrows the rows to those whose ID, label or family holds every typed word.
 */
export function modelList(
  catalog: ChatCatalogRead | null,
  current: ChatModelSelection | null,
  filter: string,
): ModelGroup[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const groups: ModelGroup[] = [];
  for (const entry of catalog?.families ?? []) {
    if (!entry.connected) continue;
    const parts = modelGroups(entry, current);
    const rows = [...parts.live, ...parts.hidden, ...parts.known, ...parts.used]
      .map((model): ModelRow => {
        const efforts = effortLevels(model.efforts);
        const picked =
          current?.family === entry.family &&
          current.model === model.model &&
          efforts.includes(current.effort)
            ? current.effort
            : model.defaultEffort;
        return {
          family: entry.family,
          model: model.model,
          label: model.label,
          efforts,
          effort: picked,
        };
      })
      .filter((row) => words.every((word) => haystack(row).includes(word)));
    if (rows.length > 0) groups.push({ family: entry.family, rows });
  }
  return groups;
}

/** The rows of the list in the order the cursor walks them. */
export const flatRows = <T>(groups: readonly { rows: readonly T[] }[]): T[] =>
  groups.flatMap((group) => group.rows);

/** The cursor kept inside a list of `count` rows. An empty list keeps it at 0. */
export const clampIndex = (index: number, count: number) =>
  count === 0 ? 0 : Math.min(Math.max(0, index), count - 1);

/** The next effort of a row, one step left or right, staying at the ends. */
export function stepEffort(row: ModelRow, step: 1 | -1): ChatEffort {
  if (row.efforts.length === 0) return row.effort;
  const at = row.efforts.indexOf(row.effort);
  const next = at === -1 ? 0 : Math.min(Math.max(0, at + step), row.efforts.length - 1);
  return row.efforts[next];
}

/**
 * `/model id` or `/model id:effort`: the listed model of that ID in any connected family, the
 * current family first, with the effort when the model offers it. Null when no family lists it.
 */
export function modelById(
  catalog: ChatCatalogRead | null,
  current: ChatModelSelection | null,
  argument: string,
): ChatModelSelection | null {
  const [model, effort] = argument.split(':');
  const families = [...(catalog?.families ?? [])]
    .filter((entry) => entry.connected)
    .sort((a, b) => Number(b.family === current?.family) - Number(a.family === current?.family));
  for (const entry of families) {
    const found = entry.models.find((value) => value.model === model);
    if (found)
      return {
        family: entry.family,
        model: found.model,
        effort: found.efforts.find((value) => value === effort) ?? found.defaultEffort,
      };
  }
  return null;
}
