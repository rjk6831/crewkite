// Which computers run which provider families (ADR 0013, amendment of 2026-10-31). macOS on Apple
// silicon is the reference platform. Linux x64 and arm64 run the OpenAI, Anthropic and Local
// families from source in the preview. Google is held on Linux. Windows is not supported.
// Every refusal is one sentence the person can act on.

export type PlatformFamily = 'openai' | 'anthropic' | 'google' | 'local';
export type Host = { platform: string; arch: string };
export type PlatformGate = { allowed: true } | { allowed: false; line: string };

const NAMES: Record<PlatformFamily, string> = {
  openai: 'Codex',
  anthropic: 'Claude Code',
  google: 'Antigravity CLI',
  local: 'Local',
};

const LINUX_FAMILIES: ReadonlySet<PlatformFamily> = new Set(['openai', 'anthropic', 'local']);

export function platformGate(family: PlatformFamily, host: Host = process): PlatformGate {
  if (host.platform === 'darwin' && host.arch === 'arm64') return { allowed: true };
  if (host.platform === 'linux' && (host.arch === 'x64' || host.arch === 'arm64'))
    return LINUX_FAMILIES.has(family)
      ? { allowed: true }
      : { allowed: false, line: 'Google is not available on Linux in this preview.' };
  if (host.platform === 'win32')
    return { allowed: false, line: 'CrewKite does not run on Windows.' };
  return {
    allowed: false,
    line:
      family === 'google'
        ? `${NAMES[family]} runs from CrewKite on macOS with Apple silicon only.`
        : `${NAMES[family]} runs from CrewKite on macOS with Apple silicon, or on Linux x64 or arm64 in this preview.`,
  };
}

export const LOCAL_TOKEN_NEEDS_MACOS =
  'Token entry needs the macOS keychain in this preview, so choose no authentication for a runtime on this device.';

/** The refusal for Local token mode, or null where the macOS input helper can run. */
export function localTokenRefusal(platform: string = process.platform): string | null {
  return platform === 'darwin' ? null : LOCAL_TOKEN_NEEDS_MACOS;
}
