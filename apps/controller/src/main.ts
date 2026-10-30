import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RuntimeManifestSchema } from '@crewkite/contracts';
import { Controller, type ControllerOptions } from './commands/controller.ts';
import { installCrashCapture } from './diagnostics/crash.ts';
import { appendControllerLog } from './diagnostics/log.ts';
import { configuredIdentity } from './host/publication.ts';
import {
  resolveAnthropicChatClient,
  resolveAnthropicCompactNativeProfile,
  resolveAnthropicNativeProfile,
} from './providers/anthropic/profile.ts';
import { resolveGoogleNativeProfile } from './providers/google/profile.ts';
import { refreshAvailableMemory, startGpuProbe } from './providers/local/hardware.ts';
import {
  resolveNativeProfile,
  resolveOpenAiChatClient,
  resolveOpenAiUsageClient,
  resolveRepositoryProfile,
} from './providers/openai/profile.ts';
import { serve } from './server/index.ts';

function runtimeBytes(path: string, maximum: number) {
  if (realpathSync(path) !== path) throw Error('The packaged runtime path changed.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(maximum) ||
      before.mode & 0o022n
    )
      throw Error('The packaged runtime file is unavailable.');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (
      BigInt(offset) !== before.size ||
      !current.isFile() ||
      (['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeNs', 'ctimeNs'] as const).some(
        (key) => before[key] !== after[key] || after[key] !== current[key],
      )
    )
      throw Error('The packaged runtime file changed while reading.');
    return bytes.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

/** The helper, source and manifest must belong to the same fixed runtime. */
export function resolvePackagedLocalInput(root: string) {
  const runtimeRoot = realpathSync(root);
  const manifestPath = join(runtimeRoot, 'manifest.json');
  if (!lstatSync(manifestPath, { throwIfNoEntry: false })) return undefined;
  const manifest = RuntimeManifestSchema.parse(
    JSON.parse(runtimeBytes(manifestPath, 4096).toString('utf8')),
  );
  if (!manifest.localInput) return undefined;
  if (
    manifest.node.platform !== 'darwin' ||
    manifest.node.arch !== 'arm64' ||
    process.platform !== 'darwin' ||
    process.arch !== 'arm64'
  )
    return undefined;
  const hash = (path: string, maximum: number) =>
    createHash('sha256').update(runtimeBytes(path, maximum)).digest('hex');
  if (
    hash(join(runtimeRoot, 'bin/node'), 256 * 1024 * 1024) !== manifest.node.sha256 ||
    hash(join(runtimeRoot, 'bin/local-secure-input'), 1024 * 1024) !== manifest.localInput.sha256 ||
    hash(join(runtimeRoot, 'apps/controller/src/providers/local/secure-input.m'), 1024 * 1024) !==
      manifest.localInput.sourceHash
  )
    throw Error('The packaged Local input identity changed.');
  return {
    root: runtimeRoot,
    sha256: manifest.localInput.sha256,
    sourceHash: manifest.localInput.sourceHash,
    target: manifest.localInput.target,
  };
}

export async function startController(options: ControllerOptions) {
  const configuration = {
    openAiUsageClient:
      !options.nativeProfile && !options.nativeProfiles
        ? () => resolveOpenAiUsageClient()
        : undefined,
    // Chat finds each client by version range. The writer profiles below keep their exact pins.
    chatClients:
      !options.nativeProfile && !options.nativeProfiles
        ? {
            openai: () => resolveOpenAiChatClient(),
            anthropic: () => resolveAnthropicChatClient(),
          }
        : undefined,
    registerGoogleAcp: !options.nativeProfile && !options.nativeProfiles,
    nativeProfiles: options.nativeProfile
      ? undefined
      : () => [
          resolveNativeProfile(),
          resolveAnthropicNativeProfile(),
          resolveAnthropicCompactNativeProfile(),
          resolveGoogleNativeProfile(),
          resolveRepositoryProfile(),
        ],
    localInputHelper: resolvePackagedLocalInput(
      fileURLToPath(new URL('../../../', import.meta.url)),
    ),
    ...options,
  };
  const controller = new Controller(configuration);
  try {
    const server = await serve(controller);
    let closing: Promise<void> | undefined;
    return {
      controller,
      socketPath: server.socketPath,
      close: () => {
        if (closing) return closing;
        const completion = Promise.withResolvers<void>();
        closing = completion.promise;
        try {
          // The socket closes first, so the next controller on this home cannot start while this
          // one still owns the socket path.
          void (async () => {
            try {
              await server.close();
            } finally {
              await controller.close();
            }
          })().then(completion.resolve, completion.reject);
        } catch (error) {
          completion.reject(error);
        }
        return closing;
      },
    };
  } catch (error) {
    await controller.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const home = process.env.CREWKITE_HOME ?? join(homedir(), '.crewkite');
  installCrashCapture(home);
  try {
    // The GPU report takes a moment, so it starts with the process and the first workspace read
    // after it lands carries the core count.
    startGpuProbe();
    // Memory is read again at every Local model read. This first reading fills the hardware card.
    void refreshAvailableMemory();
    const runtime = await startController({ home, identity: () => configuredIdentity(home) });
    console.log(`Controller ready at ${runtime.socketPath}`);
    appendControllerLog(home, 'controller ready');
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      appendControllerLog(home, 'controller stopping');
      await runtime.close();
      process.exit(0);
    };
    process.once('SIGTERM', () => {
      void close();
    });
    process.once('SIGINT', () => {
      void close();
    });
  } catch {
    appendControllerLog(home, 'controller could not start');
    console.error('Controller could not start. Check its private home and existing owner.');
    process.exitCode = 1;
  }
}
