import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export class ArtifactFiles {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const state = lstatSync(directory);
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new Error('Invalid artifact directory.');
  }

  publish(content: Buffer): { hash: string; bytes: number } {
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
    } finally {
      closeSync(file);
    }
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
    const state = lstatSync(path);
    if (!state.isFile() || state.isSymbolicLink())
      throw new Error('Artifact is not a regular file.');
    const content = readFileSync(path);
    if (createHash('sha256').update(content).digest('hex') !== hash)
      throw new Error('Artifact checksum failed.');
    return content;
  }

  private path(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid artifact identity.');
    return join(this.directory, hash);
  }
}
