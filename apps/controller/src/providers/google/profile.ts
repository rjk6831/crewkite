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
