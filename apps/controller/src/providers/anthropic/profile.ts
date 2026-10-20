import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { AnthropicNativeProfileSchema } from '@crewkite/contracts';
import { z } from 'zod';
import type { NativeProfileResolution } from '../openai/profile.ts';
import { nativeAuthEnvironment } from './native-discovery.ts';

const descriptor = {
  id: 'anthropic-file-v1',
  family: 'anthropic',
  displayName: 'Anthropic single-file proposal',
  clientVersion: '2.1.302',
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  effectiveEffort: 'unknown',
  accountClass: 'unknown',
  serviceTier: 'unknown',
  billingBasis: 'requires-user-attestation',
  qualifiedAt: null,
  creditPolicies: ['ordinary'],
  maximumTaskMs: 300000,
  maximumFileBytes: 65536,
  maximumSubmissions: 1,
} as const;
const compactDescriptor = {
  ...descriptor,
  id: 'anthropic-file-compact-v1',
  displayName: 'Anthropic compact single-file proposal',
  model: 'claude-haiku-5-5',
} as const;
const clientHash = '5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37';

const subscriptionMetadata = z.strictObject({
  authMethod: z.literal('claude.ai'),
  status: z.literal('subscription-candidate'),
  billing: z.literal('unknown'),
  qualified: z.literal(false),
});
export function subscriptionAuth(metadata: unknown): boolean {
  return subscriptionMetadata.safeParse(metadata).success;
}

/** Resolve a known build without executing it or reading authentication files. */
function resolve(
  selected: typeof descriptor | typeof compactDescriptor,
  environment: NodeJS.ProcessEnv,
): NativeProfileResolution {
  const unavailable = (
    reason: ReturnType<typeof AnthropicNativeProfileSchema.parse>['reason'],
  ) => ({
    facts: AnthropicNativeProfileSchema.parse({ ...selected, available: false, reason }),
  });
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    return unavailable('unsupported-platform');
  if (!environment.HOME || environment.HOME !== userInfo().homedir)
    return unavailable('native-home-unavailable');
  if (environment.CLAUDE_CONFIG_DIR !== undefined)
    return unavailable('configuration-location-unsupported');
  let found = false;
  for (const directory of [
    ...new Set([
      ...(environment.PATH ?? '').split(':').filter(isAbsolute),
      join(environment.HOME, '.local/bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ]),
  ]) {
    try {
      const executable = realpathSync(join(directory, 'claude'));
      const stat = lstatSync(executable);
      if (!stat.isFile() || stat.size > 512 * 1024 * 1024) continue;
      found = true;
      if (createHash('sha256').update(readFileSync(executable)).digest('hex') !== clientHash)
        continue;
      return {
        facts: AnthropicNativeProfileSchema.parse({
          ...selected,
          available: true,
          reason: 'qualification-pending',
        }),
        client: { executable, sha256: clientHash, version: selected.clientVersion },
        environment: nativeAuthEnvironment(environment, '/tmp'),
        locationHash: createHash('sha256')
          .update(JSON.stringify({ home: environment.HOME, configurationHome: null }))
          .digest('hex'),
      };
    } catch {}
  }
  return unavailable(found ? 'client-build-mismatch' : 'client-unavailable');
}

export function resolveAnthropicNativeProfile(environment = process.env): NativeProfileResolution {
  return resolve(descriptor, environment);
}

export function resolveAnthropicCompactNativeProfile(
  environment = process.env,
): NativeProfileResolution {
  return resolve(compactDescriptor, environment);
}
