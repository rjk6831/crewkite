// What each provider client last told CrewKite about itself, kept in memory for Settings. A client
// reports its capabilities in its own handshake, so the list comes from the client and never from
// a table here. A record belongs to one version: after an update the old list stops showing until
// the client reports again.

export type RecordFamily = 'openai' | 'anthropic' | 'google' | 'local';

export type ClientRecord = {
  /** The version the client reported, or null when the report named none. */
  version: string | null;
  /** The digest of the build the record came from, when the caller knows it. */
  build: string | null;
  capabilities: readonly string[];
  /** The result of the last self-test of this build, in one plain line. */
  probe: string | null;
  /** The handshake replies as received, bounded. Diagnostics read them; nothing branches on them. */
  kept: Readonly<Record<string, unknown>>;
};

const MAX_KEPT_BYTES = 256 * 1024;
const records = new Map<RecordFamily, ClientRecord>();

/** Keeps the record of a build. A report for another build replaces the whole record. */
export function recordClient(
  family: RecordFamily,
  patch: Partial<ClientRecord> & { kept?: Record<string, unknown> },
) {
  const before = records.get(family);
  const same =
    before !== undefined &&
    (patch.build === undefined || before.build === null || before.build === patch.build) &&
    (patch.version === undefined || before.version === null || before.version === patch.version);
  const base = same ? before : undefined;
  const kept = { ...(base?.kept ?? {}), ...(patch.kept ?? {}) };
  const next: ClientRecord = {
    version: patch.version ?? base?.version ?? null,
    build: patch.build ?? base?.build ?? null,
    capabilities: patch.capabilities ?? base?.capabilities ?? [],
    probe: patch.probe === undefined ? (base?.probe ?? null) : patch.probe,
    kept: JSON.stringify(kept).length <= MAX_KEPT_BYTES ? kept : (base?.kept ?? {}),
  };
  records.set(family, next);
  return next;
}

/** The record for the version found, or null when the client has not reported for that build. */
export function clientRecord(family: RecordFamily, version?: string | null): ClientRecord | null {
  const record = records.get(family);
  if (!record) return null;
  if (version && record.version && record.version !== version) return null;
  return record;
}

export function forgetClientRecord(family: RecordFamily) {
  records.delete(family);
}

/**
 * The names a handshake lists as true, with nested objects joined by dots: an object of
 * `{ loadSession: true, promptCapabilities: { image: true } }` lists loadSession and
 * promptCapabilities.image. An array of strings lists its entries. Anything else lists nothing.
 */
export function capabilityNames(value: unknown, prefix = '', depth = 0): string[] {
  if (Array.isArray(value))
    return value
      .filter((entry): entry is string => typeof entry === 'string' && entry.length <= 80)
      .slice(0, 64);
  if (!value || typeof value !== 'object' || depth > 3) return [];
  const names: string[] = [];
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key.length > 80) continue;
    if (inner === true) names.push(`${prefix}${key}`);
    else if (inner && typeof inner === 'object' && !Array.isArray(inner))
      names.push(...capabilityNames(inner, `${prefix}${key}.`, depth + 1));
  }
  return names.slice(0, 64);
}

/**
 * A writer descriptor names one model as its default. When the client's own list has a model of
 * the same family, that one wins, so a release that retires the default does not leave the
 * descriptor naming a model the account no longer gets. The family is a word the model id carries.
 */
export function liveModelDefault(
  fallback: string,
  family: string,
  live: readonly string[] | null | undefined,
) {
  if (!live?.length || live.includes(fallback)) return fallback;
  return live.find((id) => id.split('-').includes(family)) ?? fallback;
}
