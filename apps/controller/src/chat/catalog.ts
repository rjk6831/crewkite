import type { DatabaseSync } from 'node:sqlite';
import {
  type ChatCatalogRead,
  ChatCatalogReadSchema,
  type ChatEffort,
  ChatEffortSchema,
  type ChatFamily,
  type ChatTurnStats,
  ChatTurnStatsSchema,
  type LocalSetup,
  type Observation,
} from '@crewkite/contracts';
import {
  anthropicChatAccepts,
  anthropicChatEfforts,
  anthropicChatModels,
  anthropicDefaultChatModel,
} from '../providers/anthropic/chat.ts';
import type { NativeProfileResolution } from '../providers/openai/profile.ts';
import { windowState } from '../usage/index.ts';

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
  /** The database that holds the chat turns, for each family's last turn stats. Null stats without it. */
  turns?: Pick<DatabaseSync, 'prepare'>;
  nowMs: number;
};
export type CatalogObservation = Pick<
  Observation,
  'windowId' | 'remaining' | 'resetsAt' | 'observedAt' | 'semantics'
>;

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
  const listed =
    !models.length || models.some((value) => value.model === ready?.model && !value.hidden);
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
  return {
    ...entry(
      input,
      'anthropic',
      !!ready,
      profiles[0]?.reason,
      models,
      reported ?? anthropicDefaultChatModel,
    ),
    // The client's input protocol fixes these types for every model, so they hold wherever the
    // client is installed.
    accepts: profiles.length ? [...anthropicChatAccepts] : null,
  };
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
    readAt: null,
    // The Local credential lives in memory only (ADR 0025), so every launch starts unconnected.
    // A runtime set up before keeps its rail row with Connect, so Local never drops off the rail
    // between launches. A machine that never set one up shows nothing.
    needsConnect: !connected && input.local.endpoint !== null,
    lastTurnStats: lastTurnStats(input, 'local'),
    accepts: null,
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
  const windows = remaining(input, family);
  return {
    family,
    connected,
    reason: connected ? null : (reason ?? 'not-configured'),
    models: [...new Map(models.map((model) => [model.model, model])).values()].slice(0, 64),
    defaultModel: connected ? (defaultModel ?? null) : null,
    remaining: windows,
    readAt: readAt(input, family),
    // The quota reader runs without Connect, as the Google reader does, so the rail can show
    // allowance for a family the composer cannot use yet. A percent from before a reset says
    // nothing about the account now, so it does not count.
    needsConnect: !connected && windows.some((window) => window.percent !== null),
    lastTurnStats: lastTurnStats(input, family),
    accepts: null,
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
      const state = windowState(observation, { nowMs: input.nowMs, maxAgeMs: 300000 });
      // Past a reset the old percent says nothing about now.
      const current = state === 'fresh' || state === 'stale';
      return {
        windowId: observation.windowId,
        label: windowLabel(observation),
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

/**
 * The period a window covers, as `five-hour` or `weekly`, so the rail can draw one bar for each.
 * The reported period decides when there is one. Otherwise the id does: the Anthropic readers write
 * five-hour, weekly and weekly-<model>, and the OpenAI client calls its five-hour window primary
 * and its weekly one secondary. Any other window keeps its id.
 */
function windowLabel(observation: CatalogObservation): string {
  const id = observation.windowId;
  const period = observation.semantics?.periodSeconds;
  if (period === 18_000) return 'five-hour';
  if (period === 604_800) return 'weekly';
  if (period !== undefined) return id;
  if (id === 'five-hour' || id.endsWith(':primary')) return 'five-hour';
  if (id === 'weekly' || id.startsWith('weekly-') || id.endsWith(':secondary')) return 'weekly';
  return id;
}

/**
 * When the family's reader last brought in a reading: the newest window it wrote. An Anthropic
 * window carries the receivedAt of its reading, and the other readers stamp every window of a
 * read with the time the read landed.
 */
function readAt(input: ChatCatalogInput, family: ChatFamily): string | null {
  let newest: string | null = null;
  for (const window of input.windows)
    if (
      window.family === family &&
      (newest === null || Date.parse(window.observation.observedAt) > Date.parse(newest))
    )
      newest = window.observation.observedAt;
  return newest;
}

/** The stats of the newest turn on the family that has them. A row it cannot read counts as none. */
function lastTurnStats(input: ChatCatalogInput, family: ChatFamily): ChatTurnStats | null {
  if (!input.turns) return null;
  try {
    const row = input.turns
      .prepare(
        "SELECT json_extract(body,'$.stats') AS stats FROM chat_turns WHERE json_extract(body,'$.selection.family')=? AND json_type(body,'$.stats')='object' ORDER BY json_extract(body,'$.startedAt') DESC LIMIT 1",
      )
      .get(family) as { stats?: unknown } | undefined;
    if (typeof row?.stats !== 'string') return null;
    const parsed = ChatTurnStatsSchema.safeParse(JSON.parse(row.stats));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
