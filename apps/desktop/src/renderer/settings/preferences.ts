import {
  type ChatCatalogRead,
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

/** The saved model for a new thread, or null when its family is no longer connected or lists it. */
export function preferredSelection(
  catalog: ChatCatalogRead | null,
  store: Store | null = browserStore(),
): ChatModelSelection | null {
  const saved = readThreadDefaults(store).selection;
  const entry = catalog?.families.find(({ family }) => family === saved?.family);
  const model = entry?.models.find(({ model }) => model === saved?.model);
  if (!saved || !entry?.connected || !model) return null;
  return {
    ...saved,
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
