import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { groupAbsent, type Schedule } from '../../../host/worker.ts';
import {
  type AcpClientIdentity,
  type AcpClientPin,
  AcpClientPinSchema,
  AcpImportPinSchema,
  acpClientPin,
  googleAcpDeveloperIdRequirement,
  readAcpPrivateFile,
  readGoogleAcpPin,
  validateAcpDirectory,
} from './profile.ts';

type SignatureReceipt = {
  verified: true;
  signerTeamId: string;
  requirement: string;
  quiescent: true;
};
type SignatureInput = { executable: string; client: AcpClientPin };
type Spawn = (
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    detached: true;
    stdio: ['pipe', 'pipe', 'pipe'];
  },
) => ChildProcessWithoutNullStreams;
export type AcpImportDependencies = {
  verifySignature?: (input: SignatureInput) => Promise<SignatureReceipt>;
  now?: () => number;
  schedule?: Schedule;
  spawn?: Spawn;
  lifecycle?: { beforePhase(): void; owned(group: number): void; quiescent(group: number): void };
};
export type AcpImportResult = {
  imported: boolean;
  reason:
    | 'imported'
    | 'already-imported'
    | 'pin-conflict'
    | 'invalid-import'
    | 'signature-refused'
    | 'ownership';
  client: AcpClientIdentity | null;
};

function synchronous(callback: (() => unknown) | undefined) {
  const result = callback?.();
  if (result instanceof Promise) {
    void result.catch(() => {});
    throw new Error('Import lifecycle callbacks must finish synchronously.');
  }
}

/** A signature check owns its process group until both pipes close and the group is absent. */
function signaturePhase(
  executable: string,
  args: string[],
  deadline: number,
  dependencies: AcpImportDependencies,
): Promise<string> {
  const now = dependencies.now ?? (() => performance.now());
  const schedule: Schedule =
    dependencies.schedule ??
    ((work, milliseconds) => {
      const timer = setTimeout(work, milliseconds);
      return () => clearTimeout(timer);
    });
  synchronous(dependencies.lifecycle?.beforePhase);
  if (deadline - now() < 1000) return Promise.reject(new Error('signature-refused'));
  const child = (dependencies.spawn ?? spawn)('/usr/bin/codesign', args, {
    cwd: dirname(executable),
    env: { LANG: 'C', PATH: '/usr/bin:/bin' },
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const group = child.pid ?? 0;
  return new Promise((resolve, reject) => {
    let closed = false;
    let finished = false;
    let failed = false;
    let stopping = false;
    let code: number | null = null;
    let size = 0;
    const output: Buffer[] = [];
    const cancellations: Array<() => void> = [];
    const absent = () => group > 0 && groupAbsent(group);
    const signal = (value: NodeJS.Signals) => {
      if (group <= 0 || absent()) return;
      try {
        process.kill(-group, value);
      } catch {}
    };
    const settle = () => {
      if (finished) return;
      finished = true;
      for (const cancel of cancellations) cancel();
      if (!closed || !absent()) return reject(new Error('ownership'));
      try {
        synchronous(
          dependencies.lifecycle ? () => dependencies.lifecycle?.quiescent(group) : undefined,
        );
      } catch {
        return reject(new Error('signature-refused'));
      }
      if (failed || code !== 0 || now() >= deadline) return reject(new Error('signature-refused'));
      try {
        resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output)));
      } catch {
        reject(new Error('signature-refused'));
      }
    };
    const stop = () => {
      if (finished || stopping) return;
      stopping = true;
      signal('SIGTERM');
      cancellations.push(
        schedule(() => signal('SIGKILL'), Math.max(0, Math.min(250, deadline - now()))),
      );
      cancellations.push(schedule(settle, Math.max(0, Math.min(1000, deadline - now()))));
    };
    const receive = (bytes: Buffer) => {
      if (finished) return;
      size += bytes.length;
      if (size > 16384) {
        failed = true;
        stop();
        return;
      }
      output.push(Buffer.from(bytes));
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.stdin.on('error', () => {
      failed = true;
      stop();
    });
    child.stdout.on('error', () => {
      failed = true;
      stop();
    });
    child.stderr.on('error', () => {
      failed = true;
      stop();
    });
    child.on('error', () => {
      failed = true;
      stop();
    });
    child.on('close', (status) => {
      closed = true;
      code = status;
      if (absent()) settle();
      else stop();
    });
    try {
      if (!Number.isSafeInteger(group) || group <= 0) throw new Error();
      synchronous(dependencies.lifecycle ? () => dependencies.lifecycle?.owned(group) : undefined);
      child.stdin.end();
    } catch {
      failed = true;
      stop();
    }
    cancellations.push(
      schedule(
        () => {
          failed = true;
          stop();
        },
        Math.max(0, deadline - now() - 1000),
      ),
    );
  });
}

async function verifyOsSignature(
  input: SignatureInput,
  dependencies: AcpImportDependencies,
): Promise<SignatureReceipt> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('signature-refused');
  const deadline = (dependencies.now ?? (() => performance.now()))() + 5000;
  const requirement = googleAcpDeveloperIdRequirement(input.client.signerTeamId);
  await signaturePhase(
    input.executable,
    ['--verify', '--strict', '--verbose=4', '-R', `=${requirement}`, input.executable],
    deadline,
    dependencies,
  );
  return { verified: true, signerTeamId: input.client.signerTeamId, requirement, quiescent: true };
}

function privateDirectory(path: string, home: string) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  validateAcpDirectory(path, home);
}

function writePrivate(path: string, bytes: Buffer, mode: number) {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, bytes);
    chmodSync(path, mode);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const directory = openSync(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function managedSnapshot(home: string, executable: string): string {
  validateAcpDirectory(dirname(executable), home);
  const paths = [home];
  let current = home;
  for (const part of relative(home, dirname(executable)).split('/').filter(Boolean)) {
    current = join(current, part);
    paths.push(current);
  }
  paths.push(executable);
  return JSON.stringify(
    paths.map((path) => {
      const state = lstatSync(path, { bigint: true });
      return [
        state.dev,
        state.ino,
        state.ctimeNs,
        state.mtimeNs,
        state.mode,
        state.uid,
        state.nlink,
        state.size,
      ].map(String);
    }),
  );
}

/** Import reads fixed staging files. Publishing the private pin is the last write. */
export async function importGoogleAcp(
  options: { home: string; consent: 'explicit' },
  dependencies: AcpImportDependencies = {},
): Promise<AcpImportResult> {
  const refused = (reason: AcpImportResult['reason']): AcpImportResult => ({
    imported: false,
    reason,
    client: null,
  });
  try {
    if (options.consent !== 'explicit') return refused('invalid-import');
    validateAcpDirectory(options.home);
    const staging = join(options.home, 'imports/google-acp-v1');
    validateAcpDirectory(staging, options.home);
    const identityBytes = readAcpPrivateFile(join(staging, 'identity.json'), 4096);
    const client = AcpClientPinSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(identityBytes)),
    );
    const source = join(staging, 'agy_acp_server.par');
    const bytes = readAcpPrivateFile(source, 256 * 1024 * 1024);
    if (createHash('sha256').update(bytes).digest('hex') !== client.sha256)
      return refused('invalid-import');
    const root = join(options.home, 'providers/google-acp-v1');
    const pinPath = join(root, 'pin.json');
    if (existsSync(pinPath)) {
      const current = readGoogleAcpPin(options.home);
      return JSON.stringify(acpClientPin(current)) === JSON.stringify(client)
        ? { imported: true, reason: 'already-imported', client: current }
        : refused('pin-conflict');
    }
    privateDirectory(join(options.home, 'providers'), options.home);
    privateDirectory(root, options.home);
    const managed = join(root, client.sha256);
    privateDirectory(managed, options.home);
    const executable = join(managed, 'agy_acp_server.par');
    if (!existsSync(executable)) writePrivate(executable, bytes, 0o500);
    if (!readAcpPrivateFile(executable, 256 * 1024 * 1024, true).equals(bytes))
      return refused('invalid-import');
    const snapshot = managedSnapshot(options.home, executable);
    let receipt: SignatureReceipt;
    try {
      receipt = await (
        dependencies.verifySignature ?? ((input) => verifyOsSignature(input, dependencies))
      )({ executable, client });
      if (
        receipt.verified !== true ||
        receipt.quiescent !== true ||
        receipt.signerTeamId !== client.signerTeamId ||
        receipt.requirement !== googleAcpDeveloperIdRequirement(client.signerTeamId)
      )
        return refused('signature-refused');
    } catch (error) {
      return refused(
        error instanceof Error && error.message === 'ownership' ? 'ownership' : 'signature-refused',
      );
    }
    if (
      managedSnapshot(options.home, executable) !== snapshot ||
      !readAcpPrivateFile(executable, 256 * 1024 * 1024, true).equals(bytes) ||
      !readAcpPrivateFile(source, 256 * 1024 * 1024).equals(bytes) ||
      !readAcpPrivateFile(join(staging, 'identity.json'), 4096).equals(identityBytes) ||
      managedSnapshot(options.home, executable) !== snapshot
    )
      return refused('invalid-import');
    const pin = AcpImportPinSchema.parse({
      version: 1,
      profileId: 'google-acp-v1',
      client,
      signature: {
        method: 'macos-codesign',
        verified: true,
        requirement: receipt.requirement,
        sha256: client.sha256,
        signerTeamId: receipt.signerTeamId,
      },
    });
    try {
      writePrivate(pinPath, Buffer.from(JSON.stringify(pin)), 0o400);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const current = readGoogleAcpPin(options.home);
    if (JSON.stringify(acpClientPin(current)) !== JSON.stringify(client))
      return refused('pin-conflict');
    return { imported: true, reason: 'imported', client: current };
  } catch {
    return refused('invalid-import');
  }
}
