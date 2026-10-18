import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { NativeProfileSchema } from '@crewkite/contracts';
import { nativeDiscoveryEnvironment } from './native-discovery.ts';

const descriptor = {
  id: 'openai-file-v1',
  family: 'openai',
  displayName: 'OpenAI single-file proposal',
  clientVersion: '0.163.0',
  model: 'gpt-6.1-sol',
  effort: 'low',
  accountClass: 'pro',
  serviceTier: 'default',
  qualifiedAt: '2026-10-16',
  creditPolicies: ['ordinary', 'existing-credits'],
  maximumTaskMs: 300000,
  maximumFileBytes: 65536,
  maximumSubmissions: 1,
} as const;
const clientHash = '8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31';
export type NativeProfileResolution = {
  facts: ReturnType<typeof NativeProfileSchema.parse>;
  client?: { executable: string; sha256: string; version: string };
  environment?: NodeJS.ProcessEnv;
  locationHash?: string;
};
export function unavailableNativeProfile(
  reason: Extract<
    NativeProfileResolution['facts'],
    { family: 'openai' }
  >['reason'] = 'not-configured',
) {
  return {
    facts: NativeProfileSchema.options[0].parse({ ...descriptor, available: false, reason }),
  };
}

/** Resolve the supported installation without executing it or reading authentication files. */
export function resolveNativeProfile(environment = process.env): NativeProfileResolution {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    return unavailableNativeProfile('unsupported-platform');
  if (!environment.HOME || environment.HOME !== userInfo().homedir)
    return unavailableNativeProfile('native-home-unavailable');
  if (environment.CODEX_HOME !== undefined)
    return unavailableNativeProfile('configuration-location-unsupported');
  let found = false;
  for (const directory of [
    ...new Set([
      ...(environment.PATH ?? '').split(':').filter(isAbsolute),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ]),
  ]) {
    try {
      const entry = realpathSync(join(directory, 'codex'));
      const candidates = [
        entry,
        join(
          dirname(dirname(entry)),
          'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
        ),
      ];
      for (const candidate of candidates) {
        const executable = realpathSync(candidate);
        const stat = lstatSync(executable);
        if (!stat.isFile() || stat.size > 256 * 1024 * 1024) continue;
        found = true;
        if (createHash('sha256').update(readFileSync(executable)).digest('hex') !== clientHash)
          continue;
        return {
          facts: NativeProfileSchema.parse({ ...descriptor, available: true, reason: 'available' }),
          client: { executable, sha256: clientHash, version: descriptor.clientVersion },
          environment: nativeDiscoveryEnvironment(environment),
          locationHash: createHash('sha256')
            .update(JSON.stringify({ home: environment.HOME, configurationHome: null }))
            .digest('hex'),
        };
      }
    } catch {}
  }
  return unavailableNativeProfile(found ? 'client-build-mismatch' : 'client-unavailable');
}

export function unavailableRepositoryProfile(
  reason: Parameters<typeof unavailableNativeProfile>[0] = 'not-configured',
): NativeProfileResolution {
  return repositoryResolution(unavailableNativeProfile(reason));
}

/** Repository work reuses the installation identity without inheriting file consent. */
export function resolveRepositoryProfile(environment = process.env): NativeProfileResolution {
  return repositoryResolution(resolveNativeProfile(environment));
}

function repositoryResolution(resolved: NativeProfileResolution): NativeProfileResolution {
  const { maximumFileBytes: _fileLimit, ...common } = descriptor;
  return {
    ...resolved,
    facts: NativeProfileSchema.parse({
      ...common,
      id: 'openai-repository-v1',
      displayName: 'OpenAI repository work',
      qualifiedAt: null,
      maximumTaskMs: 600000,
      maximumSourceFiles: 10000,
      maximumSourceBytes: 67108864,
      execution: { sandbox: 'workspace-write', approvalPolicy: 'never', networkAccess: false },
      available: resolved.facts.available,
      reason: resolved.facts.available ? 'qualification-pending' : resolved.facts.reason,
    }),
  };
}
