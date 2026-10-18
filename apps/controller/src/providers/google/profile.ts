import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { GoogleNativeProfileSchema } from '@crewkite/contracts';
import type { NativeProfileResolution } from '../openai/profile.ts';
import type { GoogleClientIdentity } from './native-writer.ts';

const descriptor = {
  id: 'google-file-v1',
  family: 'google',
  displayName: 'Google single-file proposal',
  clientVersion: '1.4.0',
  model: 'gemini-3.8-flash-low',
  effort: 'low',
  effectiveEffort: 'unknown',
  accountClass: 'unknown',
  serviceTier: 'unknown',
  billingBasis: 'requires-user-attestation',
  qualifiedAt: null,
  creditPolicies: ['ordinary'],
  permissionModes: ['request-review', 'strict', 'always-proceed', 'proceed-in-sandbox'],
  maximumTaskMs: 300000,
  maximumFileBytes: 65536,
  maximumSubmissions: 1,
} as const;
/** Consumer headless mode excludes third-party application wrappers. */
export function resolveGoogleNativeProfile(_environment = process.env): NativeProfileResolution {
  return {
    facts: GoogleNativeProfileSchema.parse({
      ...descriptor,
      available: false,
      reason: 'provider-policy-restricted',
    }),
  };
}

// The quota reader runs automatically using one zero-turn /usage command
// on the pinned client and never prepares, starts or submits a task.
export const googleUsageDescriptor = {
  id: 'google-usage-v1',
  family: 'google',
  displayName: 'Google quota read',
  clientVersion: '1.4.1',
  clientSha256: 'da7e0766b076e411343542db4c09380bf4656df24da47168c0fa0f7986813e11',
  command: '/usage',
  maximumReadMs: 20000,
} as const;

export type GoogleUsageClientResolution =
  | {
      available: true;
      reason: 'available';
      client: GoogleClientIdentity;
      environment: NodeJS.ProcessEnv;
    }
  | {
      available: false;
      reason:
        | 'unsupported-platform'
        | 'native-home-unavailable'
        | 'client-unavailable'
        | 'client-build-mismatch';
    };

/** Find the pinned client without executing it or reading authentication files. */
export function resolveGoogleUsageClient(
  environment = process.env,
  searchDirectories?: readonly string[],
): GoogleUsageClientResolution {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    return { available: false, reason: 'unsupported-platform' };
  if (!environment.HOME || environment.HOME !== userInfo().homedir)
    return { available: false, reason: 'native-home-unavailable' };
  let found = false;
  const directories = searchDirectories ?? [
    ...(environment.PATH ?? '').split(':').filter(isAbsolute),
    join(environment.HOME, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const directory of new Set(directories.filter(isAbsolute))) {
    try {
      const executable = realpathSync(join(directory, 'agy'));
      const stat = lstatSync(executable);
      if (!stat.isFile() || stat.size > 256 * 1024 * 1024) continue;
      found = true;
      if (
        createHash('sha256').update(readFileSync(executable)).digest('hex') !==
        googleUsageDescriptor.clientSha256
      )
        continue;
      return {
        available: true,
        reason: 'available',
        client: {
          executable,
          version: googleUsageDescriptor.clientVersion,
          sha256: googleUsageDescriptor.clientSha256,
        },
        environment: { HOME: environment.HOME },
      };
    } catch {}
  }
  return { available: false, reason: found ? 'client-build-mismatch' : 'client-unavailable' };
}
