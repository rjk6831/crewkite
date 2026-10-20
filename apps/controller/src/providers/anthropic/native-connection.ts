import {
  CommandIdSchema,
  HashSchema,
  type NativeConnectionStatus,
  NativeConnectionStatusSchema,
} from '@crewkite/contracts';
import { z } from 'zod';
import { groupAbsent } from '../../host/worker.ts';
import type { NativeProfileResolution } from '../openai/profile.ts';
import {
  NativeDiscoveryError,
  nativeSynchronousHook,
  startNativeAuthStatus,
} from './native-discovery.ts';

type Status = NativeConnectionStatus;
export const ConnectionRecordSchema = z.strictObject({
  key: CommandIdSchema,
  requestHash: HashSchema,
  profileId: z.literal('anthropic-file-v1'),
  clientHash: HashSchema,
  phase: z.enum(['intent', 'owned', 'closed', 'complete']),
  group: z.number().int().positive().nullable(),
  status: NativeConnectionStatusSchema,
});
export type ConnectionRecord = z.infer<typeof ConnectionRecordSchema>;
export type ConnectionResult = {
  outcome: 'applied' | 'already-applied' | 'blocked' | 'denied';
  reason?: string;
  next?: string;
};
type Options = {
  latest: () => ConnectionRecord | null;
  completed: (key: string) => ConnectionRecord | null;
  append: (record: ConnectionRecord) => void;
  now: () => string;
};
const initial = (): Status => ({
  family: 'anthropic',
  profileId: 'anthropic-file-v1',
  state: 'unchecked',
  authMethod: null,
  observedAt: null,
  reason: null,
  next: 'Check the installed native client sign-in.',
  billing: 'unknown',
  qualified: false,
  quota: 'unknown',
});
const resultFor = (status: Status): ConnectionResult => ({
  outcome: status.state === 'signed-in' ? 'applied' : 'blocked',
  ...(status.reason ? { reason: status.reason } : {}),
  next: status.next,
});

/** Metadata ownership is independent of task admission and billing authority. */
export class NativeConnectionChecks {
  private readonly options: Options;
  private active?: {
    key: string;
    hash: string;
    promise: Promise<ConnectionResult>;
    stop?: () => void;
  };
  private closed = false;
  constructor(options: Options) {
    this.options = options;
  }

  status(): Status {
    try {
      const saved = this.options.latest();
      if (!saved) return initial();
      if (saved.phase === 'complete') return saved.status;
      if (
        !this.active &&
        (saved.phase === 'closed' ||
          (saved.phase === 'owned' && saved.group !== null && groupAbsent(saved.group)))
      ) {
        const status: Status = {
          ...initial(),
          state: 'blocked',
          reason: 'anthropic-connection-interrupted',
          observedAt: this.options.now(),
          next: 'The previous check stopped. Check the native sign-in again.',
        };
        return status;
      }
      return {
        ...initial(),
        state: this.active ? 'checking' : 'unknown',
        reason: this.active ? null : 'anthropic-connection-ownership-unknown',
        next: this.active
          ? 'Wait for the native sign-in check.'
          : 'Resolve the native client process before checking again. The previous check will not replay.',
      };
    } catch {
      return {
        ...initial(),
        state: 'unknown',
        reason: 'anthropic-connection-evidence-unavailable',
        next: 'Restore the retained connection evidence before checking again.',
      };
    }
  }

  recover(): boolean {
    try {
      const saved = this.options.latest();
      if (!this.active && saved && saved.phase !== 'complete') {
        const status = this.status();
        if (status.reason === 'anthropic-connection-interrupted')
          this.append({ ...saved, phase: 'complete', status });
      }
      return true;
    } catch {
      return false;
    }
  }

  private append(record: ConnectionRecord) {
    nativeSynchronousHook(() => this.options.append(record));
  }

  check(
    input: {
      key: string;
      requestHash: string;
      profile: NativeProfileResolution;
      directory: string;
      repositoryRoot: string;
    },
    execution: Parameters<typeof startNativeAuthStatus>[1] = {},
  ): Promise<ConnectionResult> {
    if (this.closed) return Promise.resolve({ outcome: 'blocked', reason: 'controller-closing' });
    if (this.active?.key === input.key)
      return this.active.hash === input.requestHash
        ? this.active.promise
        : Promise.resolve({ outcome: 'denied', reason: 'idempotency-key-reused' });
    try {
      if (!this.recover())
        return Promise.resolve({
          outcome: 'blocked',
          reason: 'anthropic-connection-evidence-unavailable',
        });
      const completed = this.options.completed(input.key);
      if (completed)
        return Promise.resolve(
          completed.requestHash !== input.requestHash
            ? { outcome: 'denied', reason: 'idempotency-key-reused' }
            : {
                ...resultFor(completed.status),
                ...(completed.status.state === 'signed-in'
                  ? { outcome: 'already-applied' as const }
                  : {}),
              },
        );
    } catch {
      return Promise.resolve({
        outcome: 'blocked',
        reason: 'anthropic-connection-evidence-unavailable',
      });
    }
    const status = this.status();
    if (this.active || status.state === 'unknown')
      return Promise.resolve({
        outcome: 'blocked',
        reason: 'anthropic-connection-ownership-unresolved',
        next: status.next,
      });
    const { profile } = input;
    if (
      profile.facts.id !== 'anthropic-file-v1' ||
      !profile.facts.available ||
      !profile.client ||
      !profile.environment
    )
      return Promise.resolve({
        outcome: 'blocked',
        reason: 'anthropic-client-unavailable',
        next: 'Install the supported native client and sign in there.',
      });
    const client = profile.client;
    const environment = profile.environment;
    const pending = Promise.withResolvers<ConnectionResult>();
    const active = {
      key: input.key,
      hash: input.requestHash,
      promise: pending.promise,
    } as NonNullable<NativeConnectionChecks['active']>;
    let group: number | null = null;
    const record = (phase: ConnectionRecord['phase'], value = status) =>
      this.append({
        key: input.key,
        requestHash: input.requestHash,
        profileId: 'anthropic-file-v1',
        clientHash: client.sha256,
        phase,
        group,
        status: value,
      });
    try {
      record('intent', { ...initial(), state: 'checking' });
    } catch {
      return Promise.resolve({ outcome: 'blocked', reason: 'anthropic-connection-storage-failed' });
    }
    this.active = active;
    // Deferral installs the owner before any synchronous launch refusal or journal callback.
    void Promise.resolve().then(async () => {
      let result: ConnectionResult;
      try {
        if (this.closed) throw new NativeDiscoveryError('stopped');
        const handle = startNativeAuthStatus(
          {
            ...client,
            environment,
            directory: input.directory,
            repositoryRoot: input.repositoryRoot,
          },
          {
            ...execution,
            lifecycle: {
              beforePhase: () => {},
              owned: (_phase, value) => {
                group = value;
                record('owned');
              },
              quiescent: () => record('closed'),
            },
          },
        );
        active.stop = handle.stop;
        if (this.closed) handle.stop();
        const observed = await handle.result;
        const metadata = observed.metadata;
        const value: Status = {
          ...initial(),
          state: !observed.quiescent
            ? 'unknown'
            : observed.reason
              ? 'blocked'
              : metadata?.status === 'subscription-candidate'
                ? 'signed-in'
                : metadata?.status === 'signed-out'
                  ? 'signed-out'
                  : 'unsupported',
          authMethod:
            metadata?.authMethod === 'claude.ai' ? 'subscription' : (metadata?.authMethod ?? null),
          observedAt: this.options.now(),
          reason: observed.reason,
          next: !observed.quiescent
            ? 'Resolve the native client process before checking again.'
            : metadata?.status === 'subscription-candidate'
              ? 'Native subscription sign-in observed. Billing and task qualification require their own checks.'
              : metadata?.status === 'signed-out'
                ? 'Sign in through the native client, then check again.'
                : observed.reason
                  ? 'Check the native client and retry the sign-in check.'
                  : 'Use a native subscription sign-in. This authentication method is unsupported.',
        };
        record('complete', value);
        result = resultFor(value);
      } catch (error) {
        // Refusal before spawn has no child. A failed ownership write retains uncertainty.
        if (
          group === null &&
          error instanceof NativeDiscoveryError &&
          error.reason !== 'ownership'
        ) {
          const value: Status = {
            ...initial(),
            state: 'blocked',
            reason: error.reason,
            observedAt: this.options.now(),
            next: 'Check the native client and retry the sign-in check.',
          };
          try {
            record('complete', value);
            result = resultFor(value);
          } catch {
            result = { outcome: 'blocked', reason: 'anthropic-connection-storage-failed' };
          }
        } else
          result = {
            outcome: 'blocked',
            reason: 'anthropic-connection-evidence-unavailable',
            next: 'Inspect the native client connection before retrying.',
          };
      }
      if (this.active === active) this.active = undefined;
      pending.resolve(result);
    });
    return pending.promise;
  }

  async close() {
    this.closed = true;
    this.active?.stop?.();
    await this.active?.promise;
  }
}
