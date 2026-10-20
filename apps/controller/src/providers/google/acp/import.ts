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
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { groupAbsent, type Schedule } from '../../../host/worker.ts';
import {
  type AcpClientIdentity,
  type AcpClientPin,
  AcpHarnessMaximumBytes,
  AcpImportIdentitySchema,
  AcpImportPinSchema,
  AcpServerMaximumBytes,
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

const KILL_MS = 250;
const CUTOFF_MS = 1000;

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
    let killedAt: number | undefined;
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
    const settleAtCutoff = () => {
      // An exited group can precede delivery of its final stream-close event.
      if (!closed && absent()) cancellations.push(schedule(settle, 0));
      else settle();
    };
    const cutoff = () => {
      if (finished) return;
      if (absent()) return settleAtCutoff();
      // Timers run before the poll phase that reaps children. When synchronous work holds the
      // loop past the cutoff, KILL and this check run in one pass, microseconds apart. Node runs
      // one timer list per duration at a time, so an older cutoff list can even run before the
      // KILL. Deciding after one poll phase lets the kill go out and the child be reaped. A group
      // still present then gets the usual gap between KILL and cutoff, counted from the kill and
      // capped by the deadline.
      setImmediate(() => {
        if (finished) return;
        if (absent()) return settleAtCutoff();
        const late = killedAt === undefined ? 0 : killedAt + CUTOFF_MS - KILL_MS - now();
        const wait = Math.min(late, deadline - now());
        if (wait > 0) cancellations.push(schedule(settleAtCutoff, wait));
        else settle();
      });
    };
    const stop = () => {
      if (finished || stopping) return;
      stopping = true;
      signal('SIGTERM');
      cancellations.push(
        schedule(
          () => {
            killedAt = now();
            signal('SIGKILL');
          },
          Math.max(0, Math.min(KILL_MS, deadline - now())),
        ),
      );
      cancellations.push(schedule(cutoff, Math.max(0, Math.min(CUTOFF_MS, deadline - now()))));
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
  deadline: number,
): Promise<SignatureReceipt> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('signature-refused');
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
  paths.push(executable, join(dirname(executable), 'localharness_external'));
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
  options: { home: string; consent: 'explicit'; installerStaging?: string },
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
    const staging = options.installerStaging ?? join(options.home, 'imports/google-acp-v1');
    if (
      options.installerStaging &&
      (dirname(staging) !== join(options.home, 'imports') ||
        !/^\.google-acp-install-[A-Za-z0-9]{6}$/.test(basename(staging)))
    )
      return refused('invalid-import');
    validateAcpDirectory(staging, options.home);
    if (
      options.installerStaging &&
      JSON.stringify(readdirSync(staging).sort()) !==
        JSON.stringify(['agy_acp_server.par', 'identity.json', 'localharness_external'])
    )
      return refused('invalid-import');
    const identityBytes = readAcpPrivateFile(join(staging, 'identity.json'), 4096);
    const identity = AcpImportIdentitySchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(identityBytes)),
    );
    const client = acpClientPin(identity);
    const files = [
      { name: 'agy_acp_server.par', sha256: client.sha256, maximum: AcpServerMaximumBytes },
      {
        name: 'localharness_external',
        sha256: identity.harnessSha256,
        maximum: AcpHarnessMaximumBytes,
      },
    ].map((file) => ({
      ...file,
      source: join(staging, file.name),
      bytes: readAcpPrivateFile(join(staging, file.name), file.maximum),
    }));
    if (files.some((file) => createHash('sha256').update(file.bytes).digest('hex') !== file.sha256))
      return refused('invalid-import');
    const root = join(options.home, 'providers/google-acp-v1');
    const pinPath = join(root, 'pin.json');
    const matchesIdentity = (current: AcpClientIdentity) =>
      JSON.stringify(acpClientPin(current)) === JSON.stringify(client) &&
      current.harnessSha256 === identity.harnessSha256;
    if (existsSync(pinPath)) {
      const current = readGoogleAcpPin(options.home);
      return matchesIdentity(current)
        ? { imported: true, reason: 'already-imported', client: current }
        : refused('pin-conflict');
    }
    privateDirectory(join(options.home, 'providers'), options.home);
    privateDirectory(root, options.home);
    const managed = join(root, client.sha256);
    privateDirectory(managed, options.home);
    for (const file of files) {
      const destination = join(managed, file.name);
      if (!existsSync(destination)) writePrivate(destination, file.bytes, 0o500);
      if (!readAcpPrivateFile(destination, file.maximum, true).equals(file.bytes))
        return refused('invalid-import');
    }
    if (
      JSON.stringify(readdirSync(managed).sort()) !== JSON.stringify(files.map((file) => file.name))
    )
      return refused('invalid-import');
    const executable = join(managed, 'agy_acp_server.par');
    const snapshot = managedSnapshot(options.home, executable);
    const receipts: SignatureReceipt[] = [];
    const signatureDeadline = (dependencies.now ?? (() => performance.now()))() + 5000;
    try {
      for (const file of files) {
        const receipt = await (
          dependencies.verifySignature ??
          ((input) => verifyOsSignature(input, dependencies, signatureDeadline))
        )({ executable: join(managed, file.name), client: { ...client, sha256: file.sha256 } });
        if (
          receipt.verified !== true ||
          receipt.quiescent !== true ||
          receipt.signerTeamId !== client.signerTeamId ||
          receipt.requirement !== googleAcpDeveloperIdRequirement(client.signerTeamId)
        )
          return refused('signature-refused');
        receipts.push(receipt);
        if (
          managedSnapshot(options.home, executable) !== snapshot ||
          !files.every(
            (entry) =>
              readAcpPrivateFile(join(managed, entry.name), entry.maximum, true).equals(
                entry.bytes,
              ) && readAcpPrivateFile(entry.source, entry.maximum).equals(entry.bytes),
          ) ||
          !readAcpPrivateFile(join(staging, 'identity.json'), 4096).equals(identityBytes) ||
          managedSnapshot(options.home, executable) !== snapshot
        )
          return refused('invalid-import');
      }
    } catch (error) {
      return refused(
        error instanceof Error && error.message === 'ownership' ? 'ownership' : 'signature-refused',
      );
    }
    const signature = (index: number) => ({
      method: 'macos-codesign' as const,
      verified: true as const,
      requirement: receipts[index].requirement,
      sha256: files[index].sha256,
      signerTeamId: receipts[index].signerTeamId,
    });
    const pin = AcpImportPinSchema.parse({
      version: 2,
      profileId: 'google-acp-v1',
      client,
      signature: signature(0),
      harness: { sha256: identity.harnessSha256, signature: signature(1) },
    });
    try {
      writePrivate(pinPath, Buffer.from(JSON.stringify(pin)), 0o400);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const current = readGoogleAcpPin(options.home);
    if (!matchesIdentity(current)) return refused('pin-conflict');
    return { imported: true, reason: 'imported', client: current };
  } catch {
    return refused('invalid-import');
  }
}
