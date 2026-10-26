import {
  type ChatCatalogEntry,
  type ChatCatalogRead,
  type ChatFamily,
  type ChatHandoffMode,
  type ChatModelSelection,
  rankFamilies,
} from '@crewkite/contracts';
import { familyModel } from '../settings/preferences.ts';

// Which family can take which file. Every answer comes from the patterns a family's client
// reported in the catalog. CrewKite keeps no list of types of its own.

const essence = (value: string) => value.split(';')[0].trim().toLowerCase();

/**
 * Whether a MIME type matches one of the reported patterns: the exact type, its `type/*` group or
 * the pattern for any type. Null when the client reported nothing, which says nothing about the
 * file.
 */
export function acceptsType(accepts: readonly string[] | null, mimeType: string): boolean | null {
  if (accepts === null) return null;
  const [kind] = essence(mimeType).split('/');
  return accepts.some((pattern) => {
    const want = essence(pattern);
    return want === '*/*' || want === essence(mimeType) || want === `${kind}/*`;
  });
}

export type Delivery = NonNullable<ChatCatalogEntry['unlisted']> | 'native';

/**
 * How the selected family receives a file: `native` when its client lists the type, otherwise the
 * `unlisted` state the catalog reports (a path line, or nothing at all). Null when the client
 * reported nothing, which says nothing about the file.
 */
export function deliveryOf(
  entry: Pick<ChatCatalogEntry, 'accepts' | 'unlisted'>,
  mimeType: string,
): Delivery | null {
  const listed = acceptsType(entry.accepts, mimeType);
  return listed === null ? null : listed ? 'native' : (entry.unlisted ?? null);
}

// What the family does with a file of this kind, in words the hover can finish.
const takenAs = (mimeType: string) => {
  const [kind] = essence(mimeType).split('/');
  if (kind === 'image') return 'as an image';
  if (kind === 'audio') return 'as audio';
  if (essence(mimeType) === 'application/pdf') return 'as a document';
  return kind === 'text' ? 'as text' : 'as it is';
};

/**
 * The hover line for a chip. Family and kind come from the catalog entry and the file. Only a file
 * the family cannot receive at all also gets `warn`, the line under the chip.
 */
export function deliveryNote(
  family: string,
  delivery: Delivery,
  mimeType: string,
): { title: string; warn: boolean } {
  if (delivery === 'native')
    return { title: `${family} takes this file ${takenAs(mimeType)}.`, warn: false };
  if (delivery === 'path')
    return {
      title: `Sent as a file path. ${family} can open it with its tools.`,
      warn: false,
    };
  return {
    title: `${family} cannot take this file. The turn will stop and offer another provider.`,
    warn: true,
  };
}

/** True only when the client reported patterns and every file matches one of them. */
export const takesEvery = (
  entry: Pick<ChatCatalogEntry, 'accepts'>,
  mimeTypes: readonly string[],
) => mimeTypes.every((mimeType) => acceptsType(entry.accepts, mimeType) === true);

export type TryWithChoice = { family: ChatFamily; selection: ChatModelSelection; label: string };

/**
 * The families a rejected message can go to next: connected and not tried for that message. Those
 * whose client reported it takes every file type come first. The rest follow in the thread's
 * handoff mode order. Each runs its default model.
 */
export function tryWithChoices(
  catalog: ChatCatalogRead,
  tried: readonly ChatFamily[],
  mimeTypes: readonly string[],
  mode: ChatHandoffMode = 'most-left',
  modelFor: (entry: ChatCatalogEntry) => string | null = (entry) => familyModel(entry),
  now: number = Date.now(),
): TryWithChoice[] {
  const ranked = rankFamilies(catalog.families, tried, modelFor, mode, now);
  const ordered = [
    ...ranked.filter((entry) => takesEvery(entry, mimeTypes)),
    ...ranked.filter((entry) => !takesEvery(entry, mimeTypes)),
  ];
  return ordered.flatMap((entry) => {
    const chosen = modelFor(entry);
    const model = entry.models.find((value) => value.model === chosen) ?? entry.models[0];
    if (!model) return [];
    return [
      {
        family: entry.family,
        selection: { family: entry.family, model: model.model, effort: model.defaultEffort },
        label: model.label,
      },
    ];
  });
}
