import {
  type ChatCatalogRead,
  ChatCatalogReadSchema,
  type ChatEffort,
  ChatEffortSchema,
  type ChatFamily,
  type LocalSetup,
  type Observation,
} from '@crewkite/contracts';
import {
  anthropicChatEfforts,
  anthropicChatModels,
  anthropicDefaultChatModel,
} from '../providers/anthropic/chat.ts';
import type { NativeProfileResolution } from '../providers/openai/profile.ts';

type Entry = ChatCatalogRead['families'][number];
type Model = Entry['models'][number];
type ObservedModel = {
  model: string;
  efforts: readonly string[];
  defaultEffort: string;
  hidden?: boolean;
};

export type ChatCatalogInput = {
  profiles: readonly NativeProfileResolution['facts'][];
  /** The newest OpenAI model list observed with the client resolved now, or null. */
  openAiModels: readonly ObservedModel[] | null;
  /** The model the Anthropic client named in its last usage read, or null. */
  anthropicModel?: string | null;
  local: LocalSetup;
  /**
   * The route windows the readers wrote, plus the Anthropic reading's windows, which belong to
   * no route. Only the fields the gauge needs, so a reading without a route can join.
   */
  windows: readonly { family: ChatFamily | undefined; observation: CatalogObservation }[];
  nowMs: number;
};
export type CatalogObservation = Pick<
  Observation,
  'windowId' | 'remaining' | 'resetsAt' | 'observedAt' | 'semantics'
>;

// The same reading as deriveWindow, on the fields alone: a future observation and a missing
// remaining say nothing, a passed reset says nothing about now, and five minutes makes it stale.
function windowState(observation: CatalogObservation, nowMs: number) {
  const observedAt = Date.parse(observation.observedAt);
  if (!(observedAt <= nowMs)) return 'unknown';
  if (observation.resetsAt !== null && Date.parse(observation.resetsAt) <= nowMs)
    return 'reset-pending';
  if (observation.remaining === null) return 'unknown';
  return nowMs - observedAt > 300000 ? 'stale' : 'fresh';
}

/**
 * What the composer can offer, built from facts the controller already holds. A value
 * CrewKite has not observed stays null or empty. Nothing here starts a provider process.
 */
export function buildChatCatalog(input: ChatCatalogInput): ChatCatalogRead {
  return ChatCatalogReadSchema.parse({
    families: [openai(input), anthropic(input), google(input), local(input)],
  });
}

function openai(input: ChatCatalogInput): Entry {
  const profiles = input.profiles.filter((profile) => profile.family === 'openai');
  const ready = profiles.find((profile) => profile.available);
  const models = (input.openAiModels ?? []).map((value) =>
    chatModel(value.model, value.efforts, value.defaultEffort, value.model, value.hidden),
  );
  // The profile pins a model the client may no longer list. Default to one it does list, and to
  // one it shows in its own picker before a hidden one.
  const listed = !models.length || models.some((value) => value.model === ready?.model);
  return entry(
    input,
    'openai',
    !!ready,
    profiles[0]?.reason,
    models,
    listed ? ready?.model : (models.find((value) => !value.hidden) ?? models[0]).model,
  );
}

function anthropic(input: ChatCatalogInput): Entry {
  const profiles = input.profiles.filter((profile) => profile.family === 'anthropic');
  const ready = profiles.find((profile) => profile.available);
  // The pinned profiles say whether the client is here. A chat turn can use every model the
  // client offers, which is more than the profiles pin.
  const models = profiles.length
    ? anthropicChatModels.map((model) => chatModel(model, anthropicChatEfforts, 'default'))
    : [];
  const reported = anthropicChatModels.find((model) => model === input.anthropicModel);
  return entry(
    input,
    'anthropic',
    !!ready,
    profiles[0]?.reason,
    models,
    reported ?? anthropicDefaultChatModel,
  );
}

function google(input: ChatCatalogInput): Entry {
  const profile = input.profiles.find((value) => value.id === 'google-acp-v1');
  const configuration = profile && 'configOptions' in profile ? profile.configOptions : null;
  const thought = configuration?.thoughtLevel;
  const models = (configuration?.model.supported ?? []).map((model) =>
    chatModel(model, thought?.supported ?? [], thought?.currentValue ?? 'default'),
  );
  return entry(
    input,
    'google',
    profile?.available === true,
    profile?.reason,
    models,
    configuration?.model.currentValue,
  );
}

function local(input: ChatCatalogInput): Entry {
  const choices = input.local.observation?.models ?? [];
  const loaded = choices.filter((choice) => choice.state === 'loaded-eligible');
  const selected = loaded.find(
    (choice) => choice.selectionId === input.local.selection?.selectionId,
  );
  const connected = input.local.connected === true;
  return {
    family: 'local',
    connected,
    reason: connected ? null : (input.local.reason ?? 'connection-required'),
    models: loaded.map((choice) =>
      chatModel(choice.identity.modelKey, [], 'default', choice.identity.displayName),
    ),
    defaultModel: connected ? (selected?.identity.modelKey ?? null) : null,
    remaining: remaining(input, 'local'),
  };
}

function entry(
  input: ChatCatalogInput,
  family: ChatFamily,
  connected: boolean,
  reason: string | undefined,
  models: Model[],
  defaultModel: string | undefined,
): Entry {
  return {
    family,
    connected,
    reason: connected ? null : (reason ?? 'not-configured'),
    models: [...new Map(models.map((model) => [model.model, model])).values()].slice(0, 64),
    defaultModel: connected ? (defaultModel ?? null) : null,
    remaining: remaining(input, family),
  };
}

function chatModel(
  model: string,
  efforts: readonly string[],
  preferred: string,
  label = model,
  hidden = false,
): Model {
  const known = [
    ...new Set(
      efforts.flatMap((value) => {
        const parsed = ChatEffortSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  ].slice(0, 8);
  const list: ChatEffort[] = known.length ? known : ['default'];
  const wanted = ChatEffortSchema.safeParse(preferred);
  return {
    model,
    label,
    efforts: list,
    defaultEffort: wanted.success && list.includes(wanted.data) ? wanted.data : list[0],
    ...(hidden ? { hidden } : {}),
  };
}

function remaining(input: ChatCatalogInput, family: ChatFamily): Entry['remaining'] {
  return input.windows
    .filter((window) => window.family === family)
    .map((window) => window.observation)
    .sort((left, right) => left.windowId.localeCompare(right.windowId))
    .slice(0, 8)
    .map((observation) => {
      const state = windowState(observation, input.nowMs);
      // Past a reset the old percent says nothing about now.
      const current = state === 'fresh' || state === 'stale';
      return {
        windowId: observation.windowId,
        label: observation.windowId,
        percent:
          current && observation.remaining?.unit === 'percent' ? observation.remaining.value : null,
        resetsAt: observation.resetsAt,
        observedAt: observation.observedAt,
        // The scope tells a provider or pool window from one for a single model, which the id
        // alone cannot always do.
        ...(observation.semantics ? { scope: observation.semantics.scope } : {}),
      };
    });
}
