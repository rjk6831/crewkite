import { clientVersionStatus } from '../providers/client-versions.ts';
import type { ChatClientResolution, NativeProfileResolution } from '../providers/openai/profile.ts';

export type ChatClientFamily = 'openai' | 'anthropic';

/** A launch refused because the installed client is not one chat accepts. The message says why. */
export class ChatClientRefused extends Error {}
export type ChatClientResolvers = Partial<Record<ChatClientFamily, () => ChatClientResolution>>;

// The writer profiles a chat turn could launch with before the chat path had its own resolution,
// in the order the adapters preferred them.
const PROFILE_IDS: Record<ChatClientFamily, readonly string[]> = {
  openai: ['openai-repository-v1', 'openai-file-v1'],
  anthropic: ['anthropic-file-v1', 'anthropic-file-compact-v1'],
};

/**
 * The client a chat turn, a model read, a quota read or a sign-in check launches. The controller
 * passes its own resolver for each family; a controller built with fixed profiles and no resolver
 * keeps using those profiles, so scripted setups need nothing new.
 */
export function chatClient(
  family: ChatClientFamily,
  resolvers: ChatClientResolvers | undefined,
  profiles: () => readonly NativeProfileResolution[],
): ChatClientResolution {
  const resolve = resolvers?.[family];
  if (resolve) {
    try {
      return resolve();
    } catch {
      return { status: clientVersionStatus(family, { state: 'missing' }) };
    }
  }
  const listed = profiles().filter((value) => PROFILE_IDS[family].includes(value.facts.id));
  const ready = PROFILE_IDS[family]
    .map((id) => listed.find((value) => value.facts.id === id))
    .find((value) => value?.facts.available && value.client);
  if (ready?.client)
    return {
      status: clientVersionStatus(family, { state: 'pinned', version: ready.client.version }),
      profile: ready,
    };
  const reason = listed[0]?.facts.reason;
  return {
    status: clientVersionStatus(
      family,
      reason === 'client-unavailable' || reason === undefined
        ? { state: 'missing' }
        : { state: 'unavailable', detail: profileReason(reason) },
    ),
    ...(reason ? { reason } : {}),
  };
}

function profileReason(reason: string) {
  return `${reason[0].toUpperCase()}${reason.slice(1).replaceAll('-', ' ')}.`;
}

/** The catalog reason code for a client the chat path does not launch. */
export function chatClientReason(resolution: ChatClientResolution): string | null {
  if (resolution.profile?.facts.available) return null;
  switch (resolution.status.state) {
    case 'missing':
      return 'client-unavailable';
    case 'untrusted':
      return 'client-untrusted';
    case 'unreadable':
      return 'client-version-unreadable';
    case 'older':
    case 'new-major':
      return 'client-version-unsupported';
    default:
      return resolution.reason ?? resolution.profile?.facts.reason ?? 'unsupported-platform';
  }
}
