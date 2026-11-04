// Releases come from the public repository. releases/latest skips drafts and prereleases.
export const LATEST = 'https://api.github.com/repos/rjk6831/crewkite/releases/latest';
const RELEASES = 'https://github.com/rjk6831/crewkite/releases/';
const DAY_MS = 86_400_000;
// The launch check waits until the window and the controller have settled.
export const LAUNCH_CHECK_DELAY_MS = 60_000;

export type Release = { version: string; url: string };

/** The release a GitHub reply names, or null when the reply is not one we trust to open. */
export function parseRelease(value: unknown): Release | null {
  if (!value || typeof value !== 'object') return null;
  const { tag_name: tag, html_url: url, draft, prerelease } = value as Record<string, unknown>;
  if (draft === true || prerelease === true) return null;
  if (typeof tag !== 'string' || typeof url !== 'string') return null;
  const version = /^v?(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
  if (!version || !url.startsWith(RELEASES)) return null;
  return { version, url };
}

/** True when `latest` is a higher x.y.z than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const parts = (value: string) => value.split(/[.-]/).slice(0, 3).map(Number);
  const [a, b] = [parts(latest), parts(current)];
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export type Memory = { checkedAt: number; skipped: string | null };

/** The launch check runs at most once a day, and never offers a version the person put off. */
export function launchCheckDue(memory: Memory, nowMs: number): boolean {
  return nowMs - memory.checkedAt >= DAY_MS;
}

export function offerOnLaunch(memory: Memory, release: Release, current: string): boolean {
  return isNewer(release.version, current) && memory.skipped !== release.version;
}
