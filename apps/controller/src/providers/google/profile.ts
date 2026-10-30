import { userInfo } from 'node:os';
import { type ClientVersionStatus, GoogleNativeProfileSchema } from '@crewkite/contracts';
import {
  CLIENT_VERSIONS,
  clientDirectories,
  clientStatusReason,
  findClient,
} from '../client-versions.ts';
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

// The quota reader runs automatically using one zero-turn /usage command on the installed CLI
// and never prepares, starts or submits a task. It accepts any build the version table accepts
// (ADR 0009, amendment of 2026-10-31); the ACP bundle keeps its exact pin.
export const googleUsageDescriptor = {
  id: 'google-usage-v1',
  family: 'google',
  displayName: 'Google quota read',
  clientVersion: CLIENT_VERSIONS.google.tested,
  command: '/usage',
  maximumReadMs: 20000,
} as const;

export type GoogleUsageClientResolution =
  | {
      available: true;
      reason: 'available';
      client: GoogleClientIdentity;
      environment: NodeJS.ProcessEnv;
      status?: ClientVersionStatus;
    }
  | {
      available: false;
      reason:
        | 'unsupported-platform'
        | 'native-home-unavailable'
        | 'client-unavailable'
        | 'client-build-mismatch'
        | 'client-version-unsupported'
        | 'client-version-unreadable'
        | 'client-untrusted';
      status?: ClientVersionStatus;
    };

/** Find an accepted CLI build and read its version. No account file is read. */
export function resolveGoogleUsageClient(
  environment = process.env,
  searchDirectories?: readonly string[],
  options: { cachedOnly?: boolean } = {},
): GoogleUsageClientResolution {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    return { available: false, reason: 'unsupported-platform' };
  if (!environment.HOME || environment.HOME !== userInfo().homedir)
    return { available: false, reason: 'native-home-unavailable' };
  const found = findClient('google', {
    directories: searchDirectories ?? clientDirectories('google', environment),
    home: environment.HOME,
    path: environment.PATH,
    cachedOnly: options.cachedOnly,
  });
  const status = found.status;
  if (!found.client) return { available: false, reason: clientStatusReason(status), status };
  return {
    available: true,
    reason: 'available',
    // The metadata launch takes a plain three-part version. A prerelease keeps its core here and
    // its full text in the status.
    client: { ...found.client, version: found.client.version.split('-')[0] },
    environment: { HOME: environment.HOME },
    status,
  };
}
