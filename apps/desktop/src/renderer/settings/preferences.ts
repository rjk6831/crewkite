import {
  type ChatCatalogEntry,
  type ChatCatalogRead,
  type ChatFamily,
  ChatFamilySchema,
  type ChatModelSelection,
  ChatModelSelectionSchema,
  type ChatPermissionPolicy,
  ChatPermissionPolicySchema,
  TaskSchema,
} from '@crewkite/contracts';
import { configureThread, type ThreadSource } from '../thread/commands.ts';

// One key holds both defaults for new threads. Storage can be full, blocked or edited by hand, so
// every read and write tolerates failure and a bad value falls back to the built-in default.
const key = 'crewkite-thread-defaults-v1';

export type ThreadDefaults = {
  /** Null lets the composer pick the connected family with the most allowance left. */
  selection: ChatModelSelection | null;
  permissionPolicy: ChatPermissionPolicy;
};
type Store = Pick<Storage, 'getItem' | 'setItem'>;

export const permissionPolicies: { id: ChatPermissionPolicy; label: string }[] = [
  { id: 'ask', label: 'Ask each time' },
  { id: 'allow-edits', label: 'Allow edits' },
  { id: 'allow-all', label: 'Allow all' },
];

function browserStore(): Store | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function readThreadDefaults(store: Store | null = browserStore()): ThreadDefaults {
  try {
    const raw = store?.getItem(key);
    const saved = raw ? (JSON.parse(raw) as Record<string, unknown> | null) : null;
    const selection = ChatModelSelectionSchema.safeParse(saved?.selection);
    const policy = ChatPermissionPolicySchema.safeParse(saved?.permissionPolicy);
    return {
      selection: selection.success ? selection.data : null,
      permissionPolicy: policy.success ? policy.data : 'ask',
    };
  } catch {
    return { selection: null, permissionPolicy: 'ask' };
  }
}

export function writeThreadDefaults(next: ThreadDefaults, store: Store | null = browserStore()) {
  try {
    store?.setItem(key, JSON.stringify(next));
  } catch {}
}

// Family default models live under their own key. The General card keeps a copy of the thread
// defaults while it is open, and one shared key would let that copy overwrite a model picked on a
// provider card.
const familyKey = 'crewkite-family-models-v1';

export type FamilyDefaults = Partial<Record<ChatFamily, string>>;

const listeners = new Set<() => void>();

/** Calls `listener` after a family default changes. Returns the call that stops it. */
export function onFamilyDefaults(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function readFamilyDefaults(store: Store | null = browserStore()): FamilyDefaults {
  try {
    const raw = store?.getItem(familyKey);
    const saved = raw ? (JSON.parse(raw) as Record<string, unknown> | null) : null;
    const defaults: FamilyDefaults = {};
    for (const family of ChatFamilySchema.options) {
      const model = saved?.[family];
      if (typeof model === 'string' && model.length > 0 && model.length <= 200)
        defaults[family] = model;
    }
    return defaults;
  } catch {
    return {};
  }
}

/** Saves the default model for one family. Null goes back to the catalog's default. */
export function writeFamilyDefault(
  family: ChatFamily,
  model: string | null,
  store: Store | null = browserStore(),
) {
  const next = readFamilyDefaults(store);
  if (model) next[family] = model;
  else delete next[family];
  try {
    store?.setItem(familyKey, JSON.stringify(next));
  } catch {}
  for (const listener of listeners) listener();
}

/**
 * The model a family's allowance and default pick follow: the person's choice while the family
 * still lists it, else the catalog's default. A choice the catalog dropped stays saved, so it
 * applies again if the model comes back.
 */
export function familyModel(
  entry: Pick<ChatCatalogEntry, 'family' | 'models' | 'defaultModel'>,
  store: Store | null = browserStore(),
): string | null {
  const chosen = readFamilyDefaults(store)[entry.family];
  return chosen && entry.models.some(({ model }) => model === chosen) ? chosen : entry.defaultModel;
}

/**
 * The saved model for a new thread. When its family no longer lists it, the family's default model
 * takes its place. Null when the family is not connected or lists neither.
 */
export function preferredSelection(
  catalog: ChatCatalogRead | null,
  store: Store | null = browserStore(),
): ChatModelSelection | null {
  const saved = readThreadDefaults(store).selection;
  const entry = catalog?.families.find(({ family }) => family === saved?.family);
  if (!saved || !entry?.connected) return null;
  const fallback = familyModel(entry, store);
  const model =
    entry.models.find(({ model }) => model === saved.model) ??
    entry.models.find(({ model }) => model === fallback);
  if (!model) return null;
  return {
    family: entry.family,
    model: model.model,
    effort: model.efforts.includes(saved.effort) ? saved.effort : model.defaultEffort,
  };
}

/**
 * Applies the saved permission policy to a thread right after its task is created. If the call
 * fails the thread stays on Ask each time, the strictest policy, and the Thread tab shows it.
 */
export function withThreadDefaults<Input, Result extends { outcome: string; entity?: unknown }>(
  source: ThreadSource,
  createTask: (input: Input) => Promise<Result>,
): (input: Input) => Promise<Result> {
  return async (input) => {
    const result = await createTask(input);
    const { permissionPolicy } = readThreadDefaults();
    const created = TaskSchema.safeParse(result.entity);
    if (
      permissionPolicy !== 'ask' &&
      created.success &&
      (result.outcome === 'applied' || result.outcome === 'already-applied')
    )
      await configureThread(source, { taskId: created.data.id, permissionPolicy }).catch(() => {});
    return result;
  };
}
