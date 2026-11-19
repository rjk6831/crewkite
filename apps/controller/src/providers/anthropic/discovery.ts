import { z } from 'zod';

const command = z.enum(['version', 'help', 'auth-status', 'auth-logout']);
const authMethod = z.enum([
  'none',
  'claude.ai',
  'oauth_token',
  'api_key',
  'api_key_helper',
  'third_party',
]);
const status = z.object({
  authMethod,
  // Builds that publish this say whether the stored sign-in still works. A signed-out client can
  // keep its method, so the method alone cannot prove a subscription session. The client also
  // publishes loginExpiresAt. It is not compared with the clock: its units, its meaning when absent
  // and the client's refresh behavior are not captured yet, and a renewable sign-in must never read
  // as signed out.
  loggedIn: z.boolean().optional().catch(undefined),
  type: z.never().optional(),
  method: z.never().optional(),
  request_id: z.never().optional(),
  response: z.never().optional(),
});
const MAX_STDOUT_BYTES = 65_536;
const MAX_STDERR_BYTES = 16_384;
type Failure =
  | 'invalid-command'
  | 'invalid-message'
  | 'inconsistent-status'
  | 'incomplete'
  | 'limit';

export class DiscoveryError extends Error {
  readonly reason: Failure;
  constructor(reason: Failure) {
    super(`Provider discovery stopped: ${reason}.`);
    this.name = 'DiscoveryError';
    this.reason = reason;
  }
}

/** The caller must separately pin the executable and prove child ownership. */
export function metadataCommand(kind: z.input<typeof command>) {
  const parsed = command.safeParse(kind);
  if (!parsed.success) throw new DiscoveryError('invalid-command');
  return {
    argv:
      parsed.data === 'auth-status'
        ? ['auth', 'status']
        : parsed.data === 'auth-logout'
          ? ['auth', 'logout']
          : [parsed.data === 'help' ? '--help' : '--version'],
    timeoutMs: parsed.data === 'auth-status' || parsed.data === 'auth-logout' ? 30_000 : 5_000,
    maxStdoutBytes: MAX_STDOUT_BYTES,
    maxStderrBytes: MAX_STDERR_BYTES,
  };
}

export type AuthMetadata = {
  authMethod: z.output<typeof authMethod>;
  status: 'signed-out' | 'subscription-candidate' | 'unsupported';
  /** The client still names a subscription sign-in that no longer works. */
  expired: boolean;
  billing: 'unknown';
  qualified: false;
};

/**
 * The billing mode a projected sign-in bills in, for proving an API connection outside a turn.
 * Null when signed out. Undefined for a method CrewKite cannot place, which proves nothing.
 */
export function authStatusMode(
  metadata: Pick<AuthMetadata, 'authMethod' | 'status'>,
): 'subscription' | 'api' | null | undefined {
  if (metadata.status === 'signed-out') return null;
  if (metadata.status === 'subscription-candidate') return 'subscription';
  return metadata.authMethod === 'api_key' || metadata.authMethod === 'api_key_helper'
    ? 'api'
    : undefined;
}

/** Project known fields only. Authentication alone grants no dispatch authority. */
export function projectAuthStatus(input: {
  stdout: Uint8Array;
  stderrBytes: number;
  exitCode: number | null;
}): AuthMetadata {
  if (
    input.stdout.byteLength > MAX_STDOUT_BYTES ||
    !Number.isSafeInteger(input.stderrBytes) ||
    input.stderrBytes < 0 ||
    input.stderrBytes > MAX_STDERR_BYTES
  )
    throw new DiscoveryError('limit');
  if (input.exitCode !== 0 && input.exitCode !== 1) throw new DiscoveryError('incomplete');
  let parsed: z.output<typeof status>;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(input.stdout);
    parsed = status.parse(JSON.parse(text));
  } catch {
    throw new DiscoveryError('invalid-message');
  }
  const named = parsed.authMethod;
  const expired = named === 'claude.ai' && parsed.loggedIn === false;
  // A signed-out client exits 1. Only loggedIn false with a named method may pair with exit 0 or 1.
  if (!expired && (input.exitCode === 1) !== (named === 'none'))
    throw new DiscoveryError('inconsistent-status');
  const method = expired ? 'none' : named;
  return {
    authMethod: method,
    expired,
    status:
      method === 'none'
        ? 'signed-out'
        : method === 'claude.ai'
          ? 'subscription-candidate'
          : 'unsupported',
    billing: 'unknown',
    qualified: false,
  };
}
