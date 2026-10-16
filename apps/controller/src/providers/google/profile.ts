import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { GoogleNativeProfileSchema } from '@crewkite/contracts';
import type { NativeProfileResolution } from '../openai/profile.ts';

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
const clientHash = 'a4502aaf310b2fd6eb657fcfec2fcc31a690fbbd0c2d14c8eefbb556409024ce';

/** Resolve one supported build without executing it or reading account configuration. */
export function resolveGoogleNativeProfile(environment = process.env): NativeProfileResolution {
  const unavailable = (reason: ReturnType<typeof GoogleNativeProfileSchema.parse>['reason']) => ({
    facts: GoogleNativeProfileSchema.parse({ ...descriptor, available: false, reason }),
  });
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    return unavailable('unsupported-platform');
  if (!environment.HOME || environment.HOME !== userInfo().homedir)
    return unavailable('native-home-unavailable');
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
      const executable = realpathSync(join(directory, 'agy'));
      const stat = lstatSync(executable);
      if (!stat.isFile() || stat.size > 512 * 1024 * 1024) continue;
      found = true;
      if (createHash('sha256').update(readFileSync(executable)).digest('hex') !== clientHash)
        continue;
      return {
        facts: GoogleNativeProfileSchema.parse({
          ...descriptor,
          available: true,
          reason: 'qualification-pending',
        }),
        client: { executable, sha256: clientHash, version: descriptor.clientVersion },
        environment: { HOME: environment.HOME },
        locationHash: createHash('sha256')
          .update(JSON.stringify({ home: environment.HOME, configurationHome: null }))
          .digest('hex'),
      };
    } catch {}
  }
  return unavailable(found ? 'client-build-mismatch' : 'client-unavailable');
}
