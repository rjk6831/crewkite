import {
  type ChatCatalogEntry,
  type ChatCatalogRead,
  type ChatCrew,
  type ChatCrewRole,
  type ChatFamily,
  ChatFamilySchema,
  type ChatFlightMode,
  type ChatHandoffMode,
  type ChatModelSelection,
  ChatModelSelectionSchema,
  type ChatPermissionPolicy,
  ChatPermissionPolicySchema,
  ChatSavedHandoffModeSchema,
  rankFamilies,
  TaskSchema,
} from '@crewkite/contracts';
import { configureThread, type ThreadSource } from '../thread/commands.ts';

// One key holds the defaults for new threads. Storage can be full, blocked or edited by hand, so
// every read and write tolerates failure and a bad value falls back to the built-in default.
const key = 'crewkite-thread-defaults-v1';

export type ThreadDefaults = {
  /** Null lets the composer pick the connected family with the most allowance left. */
  selection: ChatModelSelection | null;
  permissionPolicy: ChatPermissionPolicy;
  handoffMode: ChatHandoffMode;
};
type Store = Pick<Storage, 'getItem' | 'setItem'>;

export const permissionPolicies: { id: ChatPermissionPolicy; label: string }[] = [
  { id: 'ask', label: 'Ask each time' },
  { id: 'allow-edits', label: 'Allow edits' },
  { id: 'allow-all', label: 'Allow all' },
];

export const handoffModes: { id: ChatHandoffMode; label: string; title: string }[] = [
  {
    id: 'most-left',
    label: 'Most allowance left',
    title: 'The family with the highest percent remaining on its tightest window.',
  },
  {
    id: 'resets-first',
    label: 'Resets soonest',
    title:
      'The family whose allowance resets first, while it has any left; allowance that expires unused is lost.',
  },
  {
    id: 'even-spend',
    label: 'Even spend',
    title:
      'Percent remaining divided by hours until reset, highest first. Each window is spent at the rate it can afford.',
  },
  {
    id: 'local-first',
    label: 'Local first',
    title: 'Local when it is connected, otherwise Even spend.',
  },
];

export const flightModes: { id: ChatFlightMode; label: string; title: string }[] = [
  { id: 'manual', label: 'Manual', title: 'Each step is yours. The crew runs nothing on its own.' },
  {
    id: 'balanced',
    label: 'Balanced',
    title:
      'After each reply the crew reviews, fixes and challenges, and asks before commands outside the read-only set, network access, work outside the scratch copy and deletes.',
  },
  {
    id: 'glide',
    label: 'Glide',
    title:
      "The crew runs the chain to the end and stops only on a failure or a permission the thread's policy does not cover. Automatic handoff turns on.",
  },
];

const builtIn: ThreadDefaults = {
  selection: null,
  permissionPolicy: 'ask',
  handoffMode: 'most-left',
};

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
    const mode = ChatSavedHandoffModeSchema.safeParse(saved?.handoffMode);
    return {
      selection: selection.success ? selection.data : null,
      permissionPolicy: policy.success ? policy.data : builtIn.permissionPolicy,
      handoffMode: mode.success ? mode.data : builtIn.handoffMode,
    };
  } catch {
    return builtIn;
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
 * Applies the saved permission policy and handoff mode to a thread right after its task is
 * created, in the thread's first configure. If the call fails the thread stays on Ask each time,
 * the strictest policy, and the Thread tab shows it.
 */
export function withThreadDefaults<Input, Result extends { outcome: string; entity?: unknown }>(
  source: ThreadSource,
  createTask: (input: Input) => Promise<Result>,
): (input: Input) => Promise<Result> {
  return async (input) => {
    const result = await createTask(input);
    const { permissionPolicy, handoffMode } = readThreadDefaults();
    const patch = {
      ...(permissionPolicy !== builtIn.permissionPolicy ? { permissionPolicy } : {}),
      ...(handoffMode !== builtIn.handoffMode ? { handoffMode } : {}),
    };
    const created = TaskSchema.safeParse(result.entity);
    if (
      Object.keys(patch).length > 0 &&
      created.success &&
      (result.outcome === 'applied' || result.outcome === 'already-applied')
    )
      await configureThread(source, { taskId: created.data.id, ...patch }).catch(() => {});
    return result;
  };
}

// Crew presets keep only the roles the person pinned to a model and effort. Every other role is
// picked when a thread starts from the preset, so a preset still works after a family disconnects.
const presetKey = 'crewkite-crew-presets-v1';

export const crewRoleNames: Record<ChatCrewRole, string> = {
  builder: 'Builder',
  reviewer: 'Reviewer',
  challenger: 'Challenger',
  fixer: 'Fixer',
  orchestrator: 'Orchestrator',
};
const presetRoles = {
  Solo: ['builder'],
  Pair: ['builder', 'reviewer'],
  'Full crew': ['builder', 'reviewer', 'challenger', 'fixer', 'orchestrator'],
} as const satisfies Record<string, readonly ChatCrewRole[]>;
export type CrewPresetName = keyof typeof presetRoles;
export const crewPresetNames = Object.keys(presetRoles) as CrewPresetName[];
export type CrewPreset = {
  name: CrewPresetName;
  /** Null picks the role's model and effort when a thread starts from the preset. */
  members: { role: ChatCrewRole; selection: ChatModelSelection | null }[];
};

export function readCrewPresets(store: Store | null = browserStore()): CrewPreset[] {
  let saved: Record<string, Record<string, unknown> | undefined> | null = null;
  try {
    const raw = store?.getItem(presetKey);
    saved = raw ? JSON.parse(raw) : null;
  } catch {}
  return crewPresetNames.map((name) => ({
    name,
    members: presetRoles[name].map((role) => {
      const pinned = ChatModelSelectionSchema.safeParse(saved?.[name]?.[role]);
      return { role, selection: pinned.success ? pinned.data : null };
    }),
  }));
}

export function writeCrewPresets(presets: CrewPreset[], store: Store | null = browserStore()) {
  const pins = Object.fromEntries(
    presets.map((preset) => [
      preset.name,
      Object.fromEntries(
        preset.members.flatMap(({ role, selection }) => (selection ? [[role, selection]] : [])),
      ),
    ]),
  );
  try {
    store?.setItem(presetKey, JSON.stringify(pins));
  } catch {}
}

// A selection the catalog still offers, with its effort. An effort the model stopped offering
// falls back to the model's default, so a stale pin cannot send an effort the client rejects.
const listed = (
  catalog: ChatCatalogRead,
  selection: ChatModelSelection | null,
): ChatModelSelection | null => {
  const entry = catalog.families.find(({ family }) => family === selection?.family);
  const model = entry?.connected && entry.models.find(({ model }) => model === selection?.model);
  if (!selection || !model) return null;
  return model.efforts.includes(selection.effort)
    ? selection
    : { ...selection, effort: model.defaultEffort };
};
const onDefault = (entry: ChatCatalogEntry, store: Store | null): ChatModelSelection | null => {
  const chosen = familyModel(entry, store);
  const model = entry.models.find(({ model }) => model === chosen) ?? entry.models[0];
  return model ? { family: entry.family, model: model.model, effort: model.defaultEffort } : null;
};

/**
 * The crew a thread gets from a preset. A pinned model applies while its family is connected and
 * lists it, with the pinned effort while the model offers it. The builder is otherwise the thread's
 * own selection, else the first connected family. The reviewer and the challenger go to the best
 * ranked other families under the thread's mode, so a second look comes from another model. With
 * one family connected they share it. The fixer is the builder again, and so is the orchestrator
 * unless a model is pinned for it. Null when no family is connected.
 */
export function crewFromPreset(
  preset: CrewPreset,
  catalog: ChatCatalogRead,
  threadSelection: ChatModelSelection | null,
  mode: ChatHandoffMode = 'most-left',
  now: number = Date.now(),
  store: Store | null = browserStore(),
): ChatCrew | null {
  const usable = catalog.families.filter((entry) => entry.connected && entry.models.length > 0);
  const pinned = (role: ChatCrewRole) => {
    const selection = preset.members.find((member) => member.role === role)?.selection ?? null;
    return listed(catalog, selection);
  };
  const first = usable[0];
  const builder =
    pinned('builder') ??
    listed(catalog, threadSelection) ??
    (first ? onDefault(first, store) : null);
  if (!builder) return null;
  const best = (exclude: ChatFamily[]) => {
    const [entry] = rankFamilies(usable, exclude, (value) => familyModel(value, store), mode, now);
    return entry ? onDefault(entry, store) : null;
  };
  // The challenger takes a family the reviewer left free when there is one.
  const taken: ChatFamily[] = [builder.family];
  const members: ChatCrew['members'] = [];
  for (const { role } of preset.members) {
    const selection =
      role === 'builder'
        ? builder
        : (pinned(role) ??
          (role === 'fixer' || role === 'orchestrator'
            ? builder
            : (best(taken) ?? best([builder.family]) ?? builder)));
    if (role !== 'fixer' && role !== 'orchestrator') taken.push(selection.family);
    members.push({ role, selection });
  }
  return { name: preset.name, members };
}
