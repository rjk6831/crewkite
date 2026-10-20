import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const BUFFER_LIMIT = 64 * 1024 * 1024;
export const ARTIFACT_CHUNK_BYTES = 65536;
const unchanged = (before: BigIntStats, after: BigIntStats) =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mtimeNs === after.mtimeNs &&
  before.ctimeNs === after.ctimeNs &&
  after.nlink === 1n;
function regular(state: BigIntStats): number {
  if (!state.isFile() || state.nlink !== 1n || state.size > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Artifact is not a safe regular file.');
  return Number(state.size);
}

export class ArtifactFiles {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const state = lstatSync(directory);
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new Error('Invalid artifact directory.');
  }

  // The caller must hold the controller's exclusive writer lease before recovering incoming names.
  recoverIncoming(): void {
    const directory = openSync(
      this.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let entries: ReturnType<typeof opendirSync> | undefined;
    let removed = false;
    const owner = process.getuid?.();
    const sameEntry = (before: BigIntStats, after: BigIntStats) =>
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.mode === after.mode &&
      before.uid === after.uid &&
      before.nlink === after.nlink &&
      before.size === after.size &&
      before.mtimeNs === after.mtimeNs &&
      before.ctimeNs === after.ctimeNs;
    try {
      const root = fstatSync(directory, { bigint: true });
      const currentDirectory = () => {
        const current = lstatSync(this.directory, { bigint: true });
        if (
          !current.isDirectory() ||
          current.dev !== root.dev ||
          current.ino !== root.ino ||
          current.uid !== root.uid ||
          current.mode !== root.mode
        )
          throw Error('The artifact directory changed during recovery.');
      };
      if (
        owner === undefined ||
        !root.isDirectory() ||
        root.uid !== BigInt(owner) ||
        (root.mode & 0o077n) !== 0n
      )
        throw Error('Artifact recovery requires an owned private directory.');
      currentDirectory();
      entries = opendirSync(this.directory);
      for (;;) {
        const entry = entries.readSync();
        if (!entry) break;
        if (
          !/^\.incoming-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            entry.name,
          )
        )
          continue;
        currentDirectory();
        const path = join(this.directory, entry.name);
        const before = lstatSync(path, { bigint: true });
        if (
          !before.isFile() ||
          before.uid !== BigInt(owner) ||
          (before.mode & 0o7777n) !== 0o600n ||
          (before.nlink !== 1n && before.nlink !== 2n)
        )
          throw Error('An incoming artifact has an unknown ownership or file identity.');
        const file = openSync(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          if (
            !sameEntry(before, fstatSync(file, { bigint: true })) ||
            !sameEntry(before, lstatSync(path, { bigint: true }))
          )
            throw Error('An incoming artifact changed during recovery.');
          currentDirectory();
          unlinkSync(path);
          removed = true;
        } finally {
          closeSync(file);
        }
      }
    } finally {
      try {
        if (removed) fsyncSync(directory);
      } finally {
        try {
          entries?.closeSync();
        } finally {
          closeSync(directory);
        }
      }
    }
  }

  publish(content: Buffer): { hash: string; bytes: number } {
    if (content.length > BUFFER_LIMIT)
      throw new Error('Artifact exceeds the trusted buffer limit.');
    const hash = createHash('sha256').update(content).digest('hex');
    const destination = this.path(hash);
    const temporary = join(this.directory, `.incoming-${randomUUID()}`);
    const file = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );

    try {
      writeFileSync(file, content);
      fsyncSync(file);
    } catch (error) {
      // Cleanup attempt 1: Close the file descriptor.
      try {
        closeSync(file);
      } catch (_cleanupError) {
        // Discard cleanup error to preserve original failure context.
      }

      // Cleanup attempt 2: Remove the temporary incoming file.
      try {
        unlinkSync(temporary);
      } catch (_unlinkError) {
        // Discard cleanup error to preserve original failure context.
      }

      throw error;
    }

    // Success path: Close the file descriptor before publication logic.
    closeSync(file);

    try {
      try {
        linkSync(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!this.read(hash).equals(content))
          throw new Error('Artifact content does not match its hash.');
      }
      const directory = openSync(this.directory, constants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      unlinkSync(temporary);
    }

    return { hash, bytes: content.length };
  }

  read(hash: string): Buffer {
    const path = this.path(hash);
    const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let content: Buffer;
    try {
      const state = fstatSync(file);
      if (!state.isFile() || state.nlink !== 1 || state.size > BUFFER_LIMIT)
        throw new Error('Artifact is not a bounded regular file.');
      content = readFileSync(file);
      if (content.length !== state.size) throw new Error('Artifact changed during its read.');
    } finally {
      closeSync(file);
    }
    if (createHash('sha256').update(content).digest('hex') !== hash)
      throw new Error('Artifact checksum failed.');
    return content;
  }

  async publishStream(
    source: AsyncIterable<Uint8Array>,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ hash: string; bytes: number }> {
    options.signal?.throwIfAborted();
    const temporary = join(this.directory, `.incoming-${randomUUID()}`);
    const file = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    const digest = createHash('sha256');
    let bytes = 0;
    try {
      try {
        for await (const chunk of source) {
          options.signal?.throwIfAborted();
          if (!(chunk instanceof Uint8Array) || chunk.byteLength > ARTIFACT_CHUNK_BYTES)
            throw new Error('Artifact publication needs bounded byte chunks.');
          if (!Number.isSafeInteger(bytes + chunk.byteLength))
            throw new Error('Artifact length exceeds the file offset range.');
          const content = Buffer.from(chunk);
          let offset = 0;
          while (offset < content.byteLength) {
            options.signal?.throwIfAborted();
            const written = await file.write(content, offset, content.byteLength - offset);
            if (written.bytesWritten === 0)
              throw new Error('Artifact publication made no progress.');
            offset += written.bytesWritten;
          }
          digest.update(content);
          bytes += content.byteLength;
        }
        options.signal?.throwIfAborted();
        await file.sync();
      } catch (error) {
        await file.close().catch(() => {});
        throw error;
      }
      await file.close();
      const hash = digest.digest('hex');
      options.signal?.throwIfAborted();
      // Once linked, finish publication even if cancellation arrives during the directory flush.
      try {
        await link(temporary, this.path(hash));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await this.verify(hash, options);
        if (existing.bytes !== bytes) throw new Error('Artifact length does not match its hash.');
      }
      await unlink(temporary);
      const directory = await open(this.directory, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return { hash, bytes };
    } finally {
      // Incoming files carry no published authority. Preserve the operation's original failure.
      await unlink(temporary).catch(() => {});
    }
  }

  // A range validates file structure and length. Whole-content integrity needs verification.
  async readRange(
    hash: string,
    input: { offset: number; limit: number },
  ): Promise<{ bytes: Buffer; totalBytes: number; eof: boolean }> {
    const { offset, limit } = input;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > ARTIFACT_CHUNK_BYTES
    )
      throw new Error('Artifact range is invalid.');
    const file = await open(
      this.path(hash),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await file.stat({ bigint: true });
      const totalBytes = regular(before);
      if (offset > totalBytes) throw new Error('Artifact range exceeds its length.');
      const bytes = Buffer.alloc(Math.min(limit, totalBytes - offset));
      let received = 0;
      while (received < bytes.length) {
        const result = await file.read(bytes, received, bytes.length - received, offset + received);
        if (result.bytesRead === 0) throw new Error('Artifact changed during its read.');
        received += result.bytesRead;
      }
      if (!unchanged(before, await file.stat({ bigint: true })))
        throw new Error('Artifact changed during its read.');
      return { bytes, totalBytes, eof: offset + received === totalBytes };
    } finally {
      await file.close();
    }
  }

  async verify(
    hash: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ hash: string; bytes: number }> {
    options.signal?.throwIfAborted();
    const file = await open(
      this.path(hash),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await file.stat({ bigint: true });
      const bytes = regular(before);
      const buffer = Buffer.alloc(ARTIFACT_CHUNK_BYTES);
      const digest = createHash('sha256');
      let offset = 0;
      while (offset < bytes) {
        options.signal?.throwIfAborted();
        const result = await file.read(buffer, 0, Math.min(buffer.length, bytes - offset), offset);
        if (result.bytesRead === 0) throw new Error('Artifact changed during verification.');
        digest.update(buffer.subarray(0, result.bytesRead));
        offset += result.bytesRead;
      }
      options.signal?.throwIfAborted();
      if (!unchanged(before, await file.stat({ bigint: true })))
        throw new Error('Artifact changed during verification.');
      if (digest.digest('hex') !== hash) throw new Error('Artifact checksum failed.');
      return { hash, bytes };
    } finally {
      await file.close();
    }
  }

  private path(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid artifact identity.');
    return join(this.directory, hash);
  }
}
