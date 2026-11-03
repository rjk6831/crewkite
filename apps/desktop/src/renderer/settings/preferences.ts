import {
  BUILT_IN_DEFAULT_CREW,
  type ChatCatalogEntry,
  type ChatCatalogRead,
  type ChatCrew,
  type ChatCrewRole,
  ChatCrewRoleSchema,
  type ChatFamily,
  ChatFamilySchema,
  type ChatFlightMode,
  ChatFlightModeSchema,
  type ChatHandoffMode,
  type ChatModelSelection,
  ChatModelSelectionSchema,
  type ChatPermissionPolicy,
  ChatPermissionPolicySchema,
  ChatSavedHandoffModeSchema,
  type ChatThread,
  type SavedCrew as ContractSavedCrew,
  type CrewChoiceId,
  CrewChoiceIdSchema,
  crewNameTaken,
  currentCrewChoice,
  currentPresetName,
  orderedCrew,
  rankFamilies,
  SAVED_CREWS_MAX,
  SavedCrewSchema,
  type SavedCrewsRead,
} from '@crewkite/contracts';
import type { ThreadSettings } from '../thread/thread-state.ts';

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

export const permissionPolicies: { id: ChatPermissionPolicy; label: string; title: string }[] = [
  {
    id: 'ask',
    label: 'Ask each time',
    title: 'Every edit and every command asks first. Allow for this thread covers that kind later.',
  },
  {
    id: 'allow-edits',
    label: 'Allow edits',
    title: 'Edits inside the scratch copy run without asking. Commands still ask.',
  },
  {
    id: 'allow-all',
    label: 'Allow all',
    title: 'Commands and edits inside the scratch copy run without asking. Edits outside it ask.',
  },
];

export type InfoText = { name: string; text: string };

/** The fuller text behind the info mark beside each flight mode control. */
export const flightModeInfo: Record<ChatFlightMode, InfoText> = {
  manual: {
    name: 'Manual',
    text: 'Nothing runs after your message except the builder. A plan waits for you to run each slice. The Permissions policy decides what asks.',
  },
  balanced: {
    name: 'Balanced',
    text: 'The reviewer, up to two fixes and the challenger run after each builder turn. A plan waits for Run plan. Read-only commands and edits inside the scratch copy run without asking. Everything else asks, whatever the policy says.',
  },
  glide: {
    name: 'Glide',
    text: 'The chain runs to the end and a plan starts at once. Only what the Permissions policy does not cover asks. Automatic handoff turns on.',
  },
};

/** The fuller text behind the info mark beside each Permissions control. */
export const permissionInfo: Record<ChatPermissionPolicy, InfoText> = {
  ask: {
    name: 'Ask each time',
    text: 'The client asks before every edit and every command, and you answer each one. Allow for this thread covers that kind of action in later turns. Choosing this again clears those grants.',
  },
  'allow-edits': {
    name: 'Allow edits',
    text: 'An edit whose files all lie inside the scratch copy runs without asking. Commands, network access and edits outside the copy ask.',
  },
  'allow-all': {
    name: 'Allow all',
    text: 'Every command and every edit inside the scratch copy runs without asking. An edit outside the copy asks. Network access asks under OpenAI. Reviewer, advisor and challenger turns ignore this setting.',
  },
};

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

function localStore(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}
const browserStore = (): Store | null => localStore();

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

/** What a new thread holds before its first send creates it. The side panel edits these. */
export type DraftSettings = Pick<
  ChatThread,
  'selection' | 'permissionPolicy' | 'autoHandoff' | 'handoffMode' | 'crew' | 'flightMode'
>;

/** The settings the controller gives a thread it has just created. */
const created: DraftSettings = {
  selection: null,
  permissionPolicy: 'ask',
  autoHandoff: false,
  handoffMode: 'most-left',
  crew: null,
  flightMode: 'manual',
};

/** A new thread starts on the saved defaults for new threads. */
export function draftSettings(store: Store | null = browserStore()): DraftSettings {
  const { permissionPolicy, handoffMode } = readThreadDefaults(store);
  return { ...created, permissionPolicy, handoffMode };
}

/**
 * One side panel change on a new thread, by the rules the controller applies to a saved one: a
 * thread with no crew is manual, and entering Glide turns automatic handoff on.
 */
export function applyDraft(draft: DraftSettings, patch: ThreadSettings): DraftSettings {
  const crew = patch.crew === undefined ? draft.crew : patch.crew;
  const flightMode = crew ? (patch.flightMode ?? draft.flightMode) : 'manual';
  const entersGlide = flightMode === 'glide' && draft.flightMode !== 'glide';
  return {
    selection: patch.selection ?? draft.selection,
    permissionPolicy: patch.permissionPolicy ?? draft.permissionPolicy,
    autoHandoff: entersGlide ? true : (patch.autoHandoff ?? draft.autoHandoff),
    handoffMode: patch.handoffMode ?? draft.handoffMode,
    crew,
    flightMode,
  };
}

/**
 * The configure calls that give a just created thread its draft settings, in order. The first
 * message carries the model, so the selection is left out. Entering Glide turns automatic handoff
 * on, so a second call turns it off when the person did. Empty when nothing differs.
 */
export function draftConfigure(draft: DraftSettings): ThreadSettings[] {
  const first: ThreadSettings = {
    ...(draft.permissionPolicy !== created.permissionPolicy
      ? { permissionPolicy: draft.permissionPolicy }
      : {}),
    ...(draft.handoffMode !== created.handoffMode ? { handoffMode: draft.handoffMode } : {}),
    ...(draft.autoHandoff !== created.autoHandoff && draft.flightMode !== 'glide'
      ? { autoHandoff: draft.autoHandoff }
      : {}),
    ...(draft.crew ? { crew: draft.crew } : {}),
    ...(draft.crew && draft.flightMode !== created.flightMode
      ? { flightMode: draft.flightMode }
      : {}),
  };
  const calls = Object.keys(first).length > 0 ? [first] : [];
  if (draft.crew && draft.flightMode === 'glide' && !draft.autoHandoff)
    calls.push({ autoHandoff: false });
  return calls;
}

/**
 * The role and model that answer a new thread's first message, for the starting chip. With an
 * orchestrator in the crew, Balanced and Glide send the message to it, as the controller routes
 * it. Otherwise the builder answers on the model the message went to.
 */
export function firstAnswer(
  draft: Pick<DraftSettings, 'crew' | 'flightMode'>,
  selection: ChatModelSelection | null,
): (ChatModelSelection & { role: 'assistant' | 'orchestrator' }) | null {
  const orchestrator = draft.crew?.members.find((member) => member.role === 'orchestrator');
  if (orchestrator && draft.flightMode !== 'manual')
    return { ...orchestrator.selection, role: 'orchestrator' };
  return selection ? { ...selection, role: 'assistant' } : null;
}

// Crew presets keep only the roles the person pinned to a model and effort. Every other role is
// picked when a thread starts from the preset, so a preset still works after a family disconnects.
const presetKey = 'crewkite-crew-presets-v1';
// The subagent switch of each role the person set, saved apart so the pin file keeps its shape
// for the CLI. A role left out takes its family's default.
const subagentsKey = 'crewkite-crew-subagents-v1';

export const crewRoleNames: Record<ChatCrewRole, string> = {
  builder: 'Builder',
  reviewer: 'Reviewer',
  challenger: 'Challenger',
  fixer: 'Fixer',
  orchestrator: 'Orchestrator',
};
const presetRoles = {
  Solo: ['builder'],
  Tandem: ['builder', 'reviewer'],
  'Full crew': ['builder', 'reviewer', 'challenger', 'fixer', 'orchestrator'],
} as const satisfies Record<string, readonly ChatCrewRole[]>;
export type CrewPresetName = keyof typeof presetRoles;
export const crewPresetNames = Object.keys(presetRoles) as CrewPresetName[];
/**
 * The preset a flight mode starts. The controller runs Balanced and Glide only with a crew, so
 * picking one on a thread with none starts Solo, the builder alone, with that mode. Null keeps the
 * crew the thread has.
 */
export function flightPreset(hasCrew: boolean, mode: ChatFlightMode): CrewPresetName | null {
  return hasCrew || mode === 'manual' ? null : 'Solo';
}
/** What each preset holds, in the words Settings and the Crew tab show. */
export const crewPresetHints: Record<CrewPresetName, string> = {
  Solo: 'The builder only. Nothing runs after a reply.',
  Tandem: 'A builder and a reviewer on another family.',
  'Full crew': 'Builder, reviewer, challenger and fixer, with an orchestrator that plans the work.',
};
/**
 * One role of a crew a thread can start from. Null picks the role's model and effort when a
 * thread starts. allowSubagents is what the person set for the role; missing takes the family
 * default.
 */
export type CrewMemberPin = {
  role: ChatCrewRole;
  selection: ChatModelSelection | null;
  allowSubagents?: boolean;
};
/** What crewFromPreset builds a thread's crew from: a built-in preset or a saved crew. */
export type CrewTemplate = { name: string; members: CrewMemberPin[] };
export type CrewPreset = CrewTemplate & { name: CrewPresetName };

export function readCrewPresets(store: Store | null = browserStore()): CrewPreset[] {
  const read = (key: string): Record<string, Record<string, unknown> | undefined> | null => {
    try {
      const raw = store?.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  // Pins saved under a preset's earlier name count for the preset it is now.
  const pinsOf = (saved: ReturnType<typeof read>, name: CrewPresetName) =>
    saved?.[name] ??
    Object.entries(saved ?? {}).find(([key]) => currentPresetName(key) === name)?.[1];
  const saved = read(presetKey);
  const switches = read(subagentsKey);
  return crewPresetNames.map((name) => ({
    name,
    members: presetRoles[name].map((role) => {
      const pinned = ChatModelSelectionSchema.safeParse(pinsOf(saved, name)?.[role]);
      const allow = pinsOf(switches, name)?.[role];
      return {
        role,
        selection: pinned.success ? pinned.data : null,
        ...(typeof allow === 'boolean' ? { allowSubagents: allow } : {}),
      };
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
  const switches = Object.fromEntries(
    presets.map((preset) => [
      preset.name,
      Object.fromEntries(
        preset.members.flatMap(({ role, allowSubagents }) =>
          typeof allowSubagents === 'boolean' ? [[role, allowSubagents]] : [],
        ),
      ),
    ]),
  );
  try {
    store?.setItem(presetKey, JSON.stringify(pins));
    store?.setItem(subagentsKey, JSON.stringify(switches));
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
  preset: CrewTemplate,
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
  for (const { role, allowSubagents } of preset.members) {
    const selection =
      role === 'builder'
        ? builder
        : (pinned(role) ??
          (role === 'fixer' || role === 'orchestrator'
            ? builder
            : (best(taken) ?? best([builder.family]) ?? builder)));
    if (role !== 'fixer' && role !== 'orchestrator') taken.push(selection.family);
    members.push({
      role,
      selection,
      ...(typeof allowSubagents === 'boolean' ? { allowSubagents } : {}),
    });
  }
  return { name: preset.name, members };
}

// Crews the person builds in Settings > Crews, and the crew new threads start with. The controller
// keeps them, so the command line lists the same crews. This window holds the last list the
// controller sent, and crew-store.ts sends every change. Before the controller held them they
// lived under these two keys, which the first launch reads once and moves to the controller.
const legacySavedCrewsKey = 'crewkite-saved-crews-v1';
const legacyDefaultCrewKey = 'crewkite-default-crew-v1';
// The projects that start with another crew stay in this window. Only the desktop uses them.
const projectCrewsKey = 'crewkite-project-crews-v1';

export type SavedCrew = ContractSavedCrew;

/** A crew a thread can start from, as the Crew tab, Settings and the welcome list them. */
export type CrewChoice = {
  /** preset:<name> or saved:<id>. */
  id: string;
  name: string;
  hint: string;
  template: CrewTemplate;
  /** The flight mode the crew sets. Null keeps the thread's own. */
  flightMode: ChatFlightMode | null;
};

export { BUILT_IN_DEFAULT_CREW };

const parse = (store: Store | null, key: string): unknown => {
  try {
    const raw = store?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

let savedCrews: SavedCrewsRead | null = null;

/** Takes the list the controller sent. Null forgets it, as when the controller goes away. */
export function setSavedCrews(read: SavedCrewsRead | null) {
  savedCrews = read;
  for (const listener of crewListeners) listener();
}

/** Whether the controller's list has arrived. Until it does only the presets are listed. */
export const savedCrewsLoaded = () => savedCrews !== null;

/** The saved crews in the order they were first saved. */
export const readSavedCrews = (): SavedCrew[] => savedCrews?.crews ?? [];

/**
 * The crews and the default this window kept before the controller held them. An entry edited
 * into a bad shape is left out, and the rest still move.
 */
export function readLegacyCrews(store: Store | null = browserStore()): {
  crews: SavedCrew[];
  defaultCrew: CrewChoiceId | null;
} {
  const saved = parse(store, legacySavedCrewsKey);
  const crews: SavedCrew[] = [];
  for (const value of Array.isArray(saved) ? saved.slice(0, SAVED_CREWS_MAX) : []) {
    const entry = value as Record<string, unknown> | null;
    const members: CrewMemberPin[] = [];
    for (const item of Array.isArray(entry?.members) ? entry.members : []) {
      const role = ChatCrewRoleSchema.safeParse(item?.role);
      if (!role.success || members.some((member) => member.role === role.data)) continue;
      const selection = ChatModelSelectionSchema.safeParse(item?.selection);
      members.push({
        role: role.data,
        selection: selection.success ? selection.data : null,
        ...(typeof item?.allowSubagents === 'boolean'
          ? { allowSubagents: item.allowSubagents }
          : {}),
      });
    }
    const crew = SavedCrewSchema.safeParse({
      id: entry?.id,
      name: typeof entry?.name === 'string' ? entry.name.trim() : entry?.name,
      members,
      flightMode: ChatFlightModeSchema.safeParse(entry?.flightMode).data ?? 'manual',
    });
    if (crew.success && !crews.some((other) => other.id === crew.data.id))
      crews.push(orderedCrew(crew.data));
  }
  const defaultCrew = CrewChoiceIdSchema.safeParse(parse(store, legacyDefaultCrewKey));
  return { crews, defaultCrew: defaultCrew.success ? defaultCrew.data : null };
}

/** Removes the two keys once the controller holds what they held. */
export function clearLegacyCrews(store: Pick<Storage, 'removeItem'> | null = localStore()) {
  try {
    store?.removeItem(legacySavedCrewsKey);
    store?.removeItem(legacyDefaultCrewKey);
  } catch {}
}

/** Why a name cannot be saved, or null. Names are unique across presets and saved crews. */
export function crewNameProblem(
  name: string,
  saved: readonly SavedCrew[],
  editing: string | null,
): string | null {
  const wanted = name.trim();
  if (!wanted) return 'Name the crew.';
  if (wanted.length > 60) return 'Use 60 characters or fewer.';
  return crewNameTaken(wanted, saved, editing) ? 'Another crew has this name.' : null;
}

/** A new id for a saved crew. */
export const savedCrewId = () =>
  `crew-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const summary = (crew: SavedCrew) =>
  `${crew.members.map(({ role }) => crewRoleNames[role]).join(', ')}. ${
    flightModes.find(({ id }) => id === crew.flightMode)?.label ?? 'Manual'
  }.`;

/** Built-in presets first, then saved crews in the order they were made. */
export function crewChoices(
  store: Store | null = browserStore(),
  saved: readonly SavedCrew[] = readSavedCrews(),
): CrewChoice[] {
  return [
    ...readCrewPresets(store).map((preset) => ({
      id: `preset:${preset.name}`,
      name: preset.name,
      hint: crewPresetHints[preset.name],
      template: preset,
      flightMode: null,
    })),
    ...saved.map((crew) => ({
      id: `saved:${crew.id}`,
      name: crew.name,
      hint: summary(crew),
      template: crew,
      flightMode: crew.flightMode,
    })),
  ];
}

/**
 * The choice whose name a thread's crew carries, if it is still listed. A thread that started from
 * a preset before it was renamed carries the earlier name.
 */
export const choiceNamed = (choices: readonly CrewChoice[], name: string | undefined) =>
  name === undefined
    ? undefined
    : (choices.find((choice) => choice.name === name) ??
      choices.find((choice) => choice.name === currentPresetName(name)));

/** The default among `choices`: the one `wanted` names while it is listed, else Solo. */
export const defaultChoiceId = (choices: readonly CrewChoice[], wanted: string | undefined) =>
  wanted && choices.some((choice) => choice.id === wanted) ? wanted : BUILT_IN_DEFAULT_CREW;

/** The crew new threads start with. A saved crew that was deleted falls back to Solo. */
export const readDefaultCrew = (store: Store | null = browserStore()): string =>
  defaultChoiceId(crewChoices(store), savedCrews?.defaultCrew);

/** Projects that start new threads with their own crew, keyed by project id. */
export function readProjectCrews(store: Store | null = browserStore()): Record<string, string> {
  const saved = parse(store, projectCrewsKey);
  const ids = new Set(crewChoices(store).map((choice) => choice.id));
  const crews: Record<string, string> = {};
  if (saved && typeof saved === 'object' && !Array.isArray(saved))
    for (const [project, id] of Object.entries(saved))
      if (typeof id === 'string' && ids.has(currentCrewChoice(id)) && project.length <= 64)
        crews[project] = currentCrewChoice(id);
  return crews;
}

/** Null makes the project follow the default crew again. */
export function writeProjectCrew(
  projectId: string,
  id: string | null,
  store: Store | null = browserStore(),
) {
  const next = readProjectCrews(store);
  if (id) next[projectId] = id;
  else delete next[projectId];
  try {
    store?.setItem(projectCrewsKey, JSON.stringify(next));
  } catch {}
  for (const listener of crewListeners) listener();
}

/** The crew a new thread in the project starts with: the project's own, else the default. */
export function crewForProject(
  projectId: string | null,
  store: Store | null = browserStore(),
): CrewChoice {
  const choices = crewChoices(store);
  const id = (projectId && readProjectCrews(store)[projectId]) || readDefaultCrew(store);
  return (
    choices.find((choice) => choice.id === id) ??
    choices.find((choice) => choice.id === BUILT_IN_DEFAULT_CREW) ??
    choices[0]
  );
}

const crewListeners = new Set<() => void>();

/** Calls `listener` after saved crews or a default crew change. Returns the call that stops it. */
export function onCrewChoices(listener: () => void): () => void {
  crewListeners.add(listener);
  return () => void crewListeners.delete(listener);
}

/**
 * What picking a crew changes on a thread, as the Crew tab applies it: the crew built from the
 * choice, the thread's model when the crew's builder moves it, and the flight mode a saved crew
 * brings. Null when no family is connected.
 */
export function crewChoicePatch(
  choice: CrewChoice,
  catalog: ChatCatalogRead,
  thread: Pick<ChatThread, 'selection' | 'handoffMode'>,
  now: number = Date.now(),
  store: Store | null = browserStore(),
): { crew: ChatCrew; selection?: ChatModelSelection; flightMode?: ChatFlightMode } | null {
  const crew = crewFromPreset(
    choice.template,
    catalog,
    thread.selection,
    thread.handoffMode,
    now,
    store,
  );
  if (!crew) return null;
  const builder = crew.members.find((member) => member.role === 'builder')?.selection;
  const moved =
    builder &&
    (builder.family !== thread.selection?.family ||
      builder.model !== thread.selection?.model ||
      builder.effort !== thread.selection?.effort);
  return {
    crew,
    ...(moved ? { selection: builder } : {}),
    ...(choice.flightMode ? { flightMode: choice.flightMode } : {}),
  };
}
