import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
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
  type AcpHash,
  AcpImportIdentitySchema,
  AcpImportPinSchema,
  AcpServerMaximumBytes,
  acpClientPin,
  copyAcpPrivateFile,
  googleAcpDeveloperIdRequirement,
  hashAcpPrivateFileAsync,
  readAcpPrivateFile,
  readGoogleAcpPinAsync,
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
  /**
   * How many of the two client files have been copied and hashed. The install shows it as
   * "Checking file 1 of 2".
   */
  onCheck?: (done: number) => void;
  /**
   * The hashing the import does, so a test can count it. `create` starts the hash that runs while a
   * staged file is copied. `file` hashes a file that is already in place.
   */
  hashing?: { create?: () => AcpHash; file?: typeof hashAcpPrivateFileAsync };
};
export type AcpImportResult = {
  imported: boolean;
  reason:
    | 'imported'
    | 'already-imported'
    | 'pin-conflict'
    | 'invalid-import'
    | 'signature-refused'
    | 'signature-timeout'
    | 'ownership';
  client: AcpClientIdentity | null;
};

const KILL_MS = 250;
const CUTOFF_MS = 1000;
/**
 * How long one codesign check may run. Each file gets its own window. codesign hashes every page
 * of the file, and right after the unpack macOS also scans the new 281 MB and 120 MB files, so
 * the first check can take many seconds. One shared five-second window for both files ran out
 * on a first connect and read as a failed signature.
 */
export const ACP_SIGNATURE_MS = 60_000;

function synchronous(callback: (() => unknown) | undefined) {
  const result = callback?.();
  if (result instanceof Promise) {
    void result.catch(() => {});
    throw new Error('Import lifecycle callbacks must finish synchronously.');
  }
}

/** A signature check owns its process group until both pipes close and the group is absent. */
export function signaturePhase(
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
  if (deadline - now() < 1000) return Promise.reject(new Error('signature-timeout'));
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
    let timedOut = false;
    let stopping = false;
    let killedAt: number | undefined;
    let exitedAt: number | undefined;
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
      // A check that ran out of time proves nothing about the signature. It is a separate reason,
      // so the connect can run it again. A finished check that codesign refused stays refused.
      // The close event can reach this loop long after the child exited. The time the check took is
      // the time of the exit, and a busy loop must not turn a check that finished into a timeout.
      if (timedOut || (exitedAt ?? now()) >= deadline)
        return reject(new Error('signature-timeout'));
      if (failed || code !== 0) return reject(new Error('signature-refused'));
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
      exitedAt ??= now();
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
          timedOut = true;
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
  const managed = paths.at(-1);
  paths.push(executable, join(dirname(executable), 'localharness_external'));
  return JSON.stringify(
    paths.map((path) => {
      const state = lstatSync(path, { bigint: true });
      // The controller home and the folders above the managed client gain and lose entries
      // while a read or a usage check runs, so their times and link counts move during the
      // signature checks. Their identity, owner and mode still pin them. The managed folder
      // and the two client files keep every field.
      const ancestor = path !== managed && !path.startsWith(`${managed}/`);
      return (
        ancestor
          ? [state.dev, state.ino, state.mode, state.uid]
          : [
              state.dev,
              state.ino,
              state.ctimeNs,
              state.mtimeNs,
              state.mode,
              state.uid,
              state.nlink,
              state.size,
            ]
      ).map(String);
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
    ].map((file) => ({ ...file, source: join(staging, file.name) }));
    // The client files are copied and hashed in pieces, so a Local connect or any other socket in
    // the controller keeps running while the import moves about 400 MB. Each file is read once
    // from staging, where the copy gives its digest, and once from the managed folder, where the
    // hash proves what reached the disk.
    const hashFile = dependencies.hashing?.file ?? hashAcpPrivateFileAsync;
    const holds = async (path: string, file: (typeof files)[number], executable = false) =>
      (await hashFile(path, file.maximum, executable)) === file.sha256;
    const root = join(options.home, 'providers/google-acp-v1');
    const pinPath = join(root, 'pin.json');
    const matchesIdentity = (current: AcpClientIdentity) =>
      JSON.stringify(acpClientPin(current)) === JSON.stringify(client) &&
      current.harnessSha256 === identity.harnessSha256;
    if (existsSync(pinPath)) {
      for (const file of files)
        if (!(await holds(file.source, file))) return refused('invalid-import');
      const current = await readGoogleAcpPinAsync(options.home, true);
      return matchesIdentity(current)
        ? { imported: true, reason: 'already-imported', client: current }
        : refused('pin-conflict');
    }
    privateDirectory(join(options.home, 'providers'), options.home);
    privateDirectory(root, options.home);
    const managed = join(root, client.sha256);
    privateDirectory(managed, options.home);
    dependencies.onCheck?.(0);
    for (const [index, file] of files.entries()) {
      const destination = join(managed, file.name);
      if (existsSync(destination)) {
        if (!(await holds(file.source, file))) return refused('invalid-import');
      } else
        await copyAcpPrivateFile(
          file.source,
          destination,
          { maximum: file.maximum, mode: 0o500, sha256: file.sha256 },
          dependencies.hashing?.create,
        );
      if (!(await holds(destination, file, true))) return refused('invalid-import');
      dependencies.onCheck?.(index + 1);
    }
    if (
      JSON.stringify(readdirSync(managed).sort()) !== JSON.stringify(files.map((file) => file.name))
    )
      return refused('invalid-import');
    const executable = join(managed, 'agy_acp_server.par');
    // The identity of the files, with the hashes above, is what the signature checks run on. A
    // write, chmod, link or replacement changes the inode or ctime, so the same snapshot after
    // the checks proves the bytes did not change under them. No file is hashed again.
    const snapshot = managedSnapshot(options.home, executable);
    const receipts: SignatureReceipt[] = [];
    const clock = dependencies.now ?? (() => performance.now());
    try {
      // The two files are checked at the same time, each in its own window. A failed check does
      // not return before the other one has ended, so no process outlives the import.
      const started = clock();
      const outcomes = await Promise.allSettled(
        files.map((file) =>
          (
            dependencies.verifySignature ??
            ((input) => verifyOsSignature(input, dependencies, started + ACP_SIGNATURE_MS))
          )({ executable: join(managed, file.name), client: { ...client, sha256: file.sha256 } }),
        ),
      );
      for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
      for (const outcome of outcomes) {
        const receipt = (outcome as PromiseFulfilledResult<SignatureReceipt>).value;
        if (
          receipt.verified !== true ||
          receipt.quiescent !== true ||
          receipt.signerTeamId !== client.signerTeamId ||
          receipt.requirement !== googleAcpDeveloperIdRequirement(client.signerTeamId)
        )
          return refused('signature-refused');
        receipts.push(receipt);
      }
      if (
        managedSnapshot(options.home, executable) !== snapshot ||
        !readAcpPrivateFile(join(staging, 'identity.json'), 4096).equals(identityBytes)
      )
        return refused('invalid-import');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return refused(
        message === 'ownership' || message === 'signature-timeout' ? message : 'signature-refused',
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
    const current = await readGoogleAcpPinAsync(options.home, true);
    if (!matchesIdentity(current)) return refused('pin-conflict');
    return { imported: true, reason: 'imported', client: current };
  } catch {
    return refused('invalid-import');
  }
}
