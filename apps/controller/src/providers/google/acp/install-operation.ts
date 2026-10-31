import {
  CommandIdSchema,
  type GoogleAcpInstallStatus,
  GoogleAcpInstallStatusSchema,
  HashSchema,
} from '@crewkite/contracts';
import { z } from 'zod';
import { groupAbsent } from '../../../host/worker.ts';
import { nativeSynchronousHook } from '../../anthropic/native-discovery.ts';
import {
  type AcpInstallDependencies,
  type AcpInstallProgress,
  type AcpInstallResult,
  installGoogleAcp,
} from './install.ts';

export type GoogleInstallStatus = GoogleAcpInstallStatus;
export const InstallRecordSchema = z
  .strictObject({
    key: CommandIdSchema,
    requestHash: HashSchema,
    step: z.number().int().min(0).max(16),
    phase: z.enum(['intent', 'signature', 'stopping', 'complete']),
    signatures: z
      .array(
        z
          .strictObject({
            sequence: z.number().int().min(1).max(2),
            state: z.enum(['intent', 'owned', 'closed']),
            group: z.number().int().positive().nullable(),
          })
          .refine((signature) => (signature.state === 'intent') === (signature.group === null)),
      )
      .max(2),
    status: GoogleAcpInstallStatusSchema,
  })
  .refine((record) =>
    record.signatures.every(
      (signature, index) =>
        signature.sequence === index + 1 &&
        (index === 0 || record.signatures[index - 1].state === 'closed'),
    ),
  )
  .refine((record) =>
    record.phase === 'intent'
      ? record.step === 0 && record.signatures.length === 0
      : record.step > 0,
  )
  .refine((record) => (record.phase === 'signature' ? record.signatures.length > 0 : true))
  .refine((record) =>
    record.phase === 'complete'
      ? ['installed', 'blocked', 'unknown'].includes(record.status.state)
      : ['installing', 'stopping'].includes(record.status.state),
  )
  .refine((record) =>
    ['installing', 'stopping', 'unknown'].includes(record.status.state)
      ? record.status.operationId === record.key
      : record.status.operationId === null,
  );
export type InstallRecord = z.infer<typeof InstallRecordSchema>;
export type InstallOperationResult = {
  outcome: 'applied' | 'already-applied' | 'blocked' | 'denied';
  reason?: string;
  next?: string;
  data: { kind: 'google-acp-install'; install: GoogleInstallStatus };
};
type Options = {
  latest: () => InstallRecord | null;
  forKey: (key: string) => InstallRecord | null;
  append: (record: InstallRecord) => void;
  now: () => string;
  install?: typeof installGoogleAcp;
};
const idle = (): GoogleInstallStatus => ({
  profileId: 'google-acp-v1',
  state: 'idle',
  operationId: null,
  observedAt: null,
  reason: null,
  next: 'Install the official client before authentication.',
});
const resultFor = (status: GoogleInstallStatus): InstallOperationResult => ({
  outcome: status.state === 'installed' ? 'applied' : 'blocked',
  ...(status.reason ? { reason: status.reason } : {}),
  next: status.next,
  data: { kind: 'google-acp-install', install: status },
});
const canRelease = (record: InstallRecord) =>
  !(record.status.state === 'unknown' && record.signatures.length === 0) &&
  record.signatures.every(
    (signature) =>
      signature.state === 'closed' || (signature.group !== null && groupAbsent(signature.group)),
  );

/** Installation owns only its download and the two signature checks. */
export class GoogleAcpInstallation {
  private readonly options: Options;
  private active?: {
    key: string;
    hash: string;
    abort: AbortController;
    promise: Promise<InstallOperationResult>;
    record: InstallRecord;
    progress: AcpInstallProgress | null;
  };
  private closed = false;
  constructor(options: Options) {
    this.options = options;
  }

  status(): GoogleInstallStatus {
    try {
      const saved = this.options.latest();
      if (!saved) return idle();
      // Progress lives in memory. The journal keeps steps, not every chunk of the download.
      if (this.active) return { ...saved.status, progress: this.active.progress };
      if (saved.phase === 'complete' && saved.status.state !== 'unknown') return saved.status;
      return canRelease(saved)
        ? {
            ...idle(),
            state: 'blocked',
            observedAt: this.options.now(),
            reason: 'google-install-interrupted',
            next: 'The previous install stopped. Start a new installation.',
          }
        : {
            ...saved.status,
            state: 'unknown',
            reason: 'google-install-ownership-unknown',
            next: 'Resolve the signature-check process before installing again. Nothing will replay.',
          };
    } catch {
      return {
        ...idle(),
        state: 'unknown',
        reason: 'google-install-evidence-unavailable',
        next: 'Restore the retained installation evidence before trying again.',
      };
    }
  }

  recover(): boolean {
    try {
      const saved = this.options.latest();
      if (
        !this.active &&
        saved &&
        (saved.phase !== 'complete' || saved.status.state === 'unknown') &&
        canRelease(saved)
      ) {
        this.append({ ...saved, step: saved.step + 1, phase: 'complete', status: this.status() });
      }
      return true;
    } catch {
      return false;
    }
  }

  private append(record: InstallRecord) {
    nativeSynchronousHook(() => this.options.append(record));
  }

  install(
    input: { key: string; requestHash: string; home: string },
    dependencies: AcpInstallDependencies = {},
  ): Promise<InstallOperationResult> {
    const denied = (): InstallOperationResult => ({
      ...resultFor(this.status()),
      outcome: 'denied',
      reason: 'idempotency-key-reused',
    });
    if (this.closed)
      return Promise.resolve({
        ...resultFor(this.status()),
        outcome: 'blocked',
        reason: 'controller-closing',
      });
    if (this.active?.key === input.key)
      return this.active.hash === input.requestHash
        ? this.active.promise
        : Promise.resolve(denied());
    try {
      if (!this.recover())
        return Promise.resolve({
          ...resultFor(this.status()),
          outcome: 'blocked',
          reason: 'google-install-evidence-unavailable',
        });
      const prior = this.options.forKey(input.key);
      if (prior?.phase === 'complete')
        return Promise.resolve(
          prior.requestHash !== input.requestHash
            ? denied()
            : {
                ...resultFor(prior.status),
                ...(prior.status.state === 'installed'
                  ? { outcome: 'already-applied' as const }
                  : {}),
              },
        );
      if (prior && prior.requestHash !== input.requestHash) return Promise.resolve(denied());
    } catch {
      return Promise.resolve({
        ...resultFor(this.status()),
        outcome: 'blocked',
        reason: 'google-install-evidence-unavailable',
      });
    }
    const status = this.status();
    if (this.active || status.state === 'unknown')
      return Promise.resolve({
        ...resultFor(status),
        outcome: 'blocked',
        reason: 'google-install-busy',
      });
    const completion = Promise.withResolvers<InstallOperationResult>();
    const record: InstallRecord = {
      key: input.key,
      requestHash: input.requestHash,
      step: 0,
      phase: 'intent',
      signatures: [],
      status: {
        ...idle(),
        state: 'installing',
        operationId: input.key,
        next: 'Downloading and verifying the official client.',
      },
    };
    try {
      this.append(record);
    } catch {
      return Promise.resolve({
        ...resultFor(status),
        outcome: 'blocked',
        reason: 'google-install-storage-failed',
      });
    }
    const active = {
      key: input.key,
      hash: input.requestHash,
      abort: new AbortController(),
      promise: completion.promise,
      record,
      progress: null as AcpInstallProgress | null,
    };
    this.active = active;
    const save = (phase: InstallRecord['phase']) => {
      active.record.step++;
      active.record.phase = phase;
      this.append(active.record);
    };
    void Promise.resolve().then(async () => {
      let result: InstallOperationResult;
      try {
        if (this.closed) active.abort.abort();
        const outcome: AcpInstallResult = await (this.options.install ?? installGoogleAcp)(
          {
            home: input.home,
            consent: 'explicit',
            signal: active.abort.signal,
            onProgress: (progress) => {
              active.progress = progress;
            },
          },
          {
            ...dependencies,
            import: {
              ...dependencies.import,
              lifecycle: {
                beforePhase: () => {
                  active.abort.signal.throwIfAborted();
                  if (active.record.signatures.length >= 2) throw Error('signature-phase-limit');
                  active.record.signatures.push({
                    sequence: active.record.signatures.length + 1,
                    state: 'intent',
                    group: null,
                  });
                  save('signature');
                },
                owned: (group) => {
                  const phase = active.record.signatures.at(-1);
                  if (phase?.state !== 'intent' || !Number.isSafeInteger(group) || group <= 0)
                    throw Error('signature-owner-unavailable');
                  phase.group = group;
                  phase.state = 'owned';
                  save('signature');
                },
                quiescent: (group) => {
                  const phase = active.record.signatures.at(-1);
                  if (!phase || phase.group !== group || phase.state !== 'owned')
                    throw Error('signature-owner-changed');
                  phase.state = 'closed';
                  save('signature');
                },
              },
            },
          },
        );
        const unknown = outcome.reason === 'ownership' || !canRelease(active.record);
        active.record.status = {
          ...idle(),
          state: unknown ? 'unknown' : outcome.imported ? 'installed' : 'blocked',
          operationId: unknown ? input.key : null,
          observedAt: this.options.now(),
          reason: unknown
            ? 'google-install-ownership-unknown'
            : (outcome.cleanupReason ?? (outcome.imported ? null : outcome.reason)),
          next: unknown
            ? 'Resolve the signature-check process before installing again.'
            : outcome.imported
              ? outcome.cleanupReason
                ? 'The official client is installed. Temporary cleanup failed; inspect the private installation directory before authentication.'
                : 'The official client is installed. Authenticate separately.'
              : outcome.reason === 'cancelled'
                ? 'Installation stopped. Start a new installation when ready.'
                : 'Check the installation failure and try again.',
        };
        save('complete');
        result = resultFor(active.record.status);
      } catch {
        result = {
          ...resultFor(this.status()),
          outcome: 'blocked',
          reason: 'google-install-evidence-unavailable',
        };
      }
      if (this.active === active) this.active = undefined;
      completion.resolve(result);
    });
    return active.promise;
  }

  async stop(operationId: string): Promise<InstallOperationResult> {
    const active = this.active;
    if (!active || active.key !== operationId)
      return {
        ...resultFor(this.status()),
        outcome: 'blocked',
        reason: 'google-install-not-current',
      };
    if (!active.abort.signal.aborted) {
      active.record.step++;
      active.record.phase = 'stopping';
      active.record.status = {
        ...active.record.status,
        state: 'stopping',
        next: 'Waiting for installation cleanup.',
      };
      try {
        this.append(active.record);
      } catch {
        /* Cancellation still belongs to this current owner. */
      }
      active.abort.abort();
    }
    return active.promise;
  }

  close(): void | Promise<void> {
    this.closed = true;
    if (this.active) return this.stop(this.active.key).then(() => {});
  }
}
