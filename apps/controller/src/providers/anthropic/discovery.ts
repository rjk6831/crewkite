import { z } from 'zod';

const command = z.enum(['version', 'help', 'auth-status']);
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
        : [parsed.data === 'help' ? '--help' : '--version'],
    timeoutMs: parsed.data === 'auth-status' ? 30_000 : 5_000,
    maxStdoutBytes: MAX_STDOUT_BYTES,
    maxStderrBytes: MAX_STDERR_BYTES,
  };
}

export type AuthMetadata = {
  authMethod: z.output<typeof authMethod>;
  status: 'signed-out' | 'subscription-candidate' | 'unsupported';
  billing: 'unknown';
  qualified: false;
};

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
  let method: AuthMetadata['authMethod'];
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(input.stdout);
    method = status.parse(JSON.parse(text)).authMethod;
  } catch {
    throw new DiscoveryError('invalid-message');
  }
  if ((input.exitCode === 1) !== (method === 'none'))
    throw new DiscoveryError('inconsistent-status');
  return {
    authMethod: method,
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
