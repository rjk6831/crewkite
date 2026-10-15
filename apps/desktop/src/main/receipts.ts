import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createCommandKey } from '@crewkite/client/node';
import { type Command, CommandSchema, canonicalJson, MAX_FRAME_BYTES } from '@crewkite/contracts';
import { desktopActor } from './runtime.ts';

export { syncDirectory } from '../../../../scripts/demo-state.ts';

import { syncDirectory } from '../../../../scripts/demo-state.ts';
export class CommandReceipts {
  readonly path: string;
  commands: Command[] = [];
  constructor(home: string, profile: string) {
    this.path = join(home, `desktop-${createHash('sha256').update(profile).digest('hex')}.jsonl`);
  }
  load() {
    const path = this.path;
    const prefix = path.slice(dirname(path).length + 1);
    const temporary = readdirSync(dirname(path)).filter(
      (name) =>
        name.startsWith(`${prefix}.`) &&
        /^cmd_[0-9A-HJKMNP-TV-Z]{26}\.next$/.test(name.slice(prefix.length + 1)),
    );
    if (temporary.length > 64)
      throw new Error('Too many interrupted receipt writes. Preserve this home for inspection.');
    for (const name of temporary) {
      const candidate = join(dirname(path), name);
      const file = openSync(
        candidate,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        this.validate(file);
      } finally {
        closeSync(file);
      }
      // The command is sent only after rename. An orphan temporary file has no dispatch authority.
      unlinkSync(candidate);
    }
    if (temporary.length) syncDirectory(dirname(path));
    let file: number;
    try {
      file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.commands = [];
        return;
      }
      throw error;
    }
    try {
      this.validate(file);
      const rows = readFileSync(file, 'utf8').split('\n');
      if (rows.length > 33) throw new Error('Too many desktop command receipts.');
      const commands = rows.map((row) => CommandSchema.parse(JSON.parse(row)));
      if (
        commands.some(
          (item) =>
            canonicalJson(item.actor) !== canonicalJson(desktopActor) ||
            !('expectedRevision' in item),
        ) ||
        new Set(commands.map((item) => item.key)).size !== commands.length
      )
        throw new Error('The desktop command receipt identity is invalid.');
      this.commands = commands;
    } finally {
      closeSync(file);
    }
  }
  private validate(file: number) {
    const state = fstatSync(file);
    if (
      !state.isFile() ||
      state.nlink !== 1 ||
      state.uid !== process.getuid?.() ||
      (state.mode & 0o777) !== 0o600 ||
      state.size > MAX_FRAME_BYTES
    )
      throw new Error('The desktop command receipt is invalid.');
  }
  retain(command: Command, pending: boolean) {
    const existing = this.commands.find((item) => item.key === command.key);
    if (existing && canonicalJson(existing) !== canonicalJson(command))
      throw new Error('The retained command key has different content.');
    if (existing && pending) return;
    const next = this.commands.filter((item) => item.key !== command.key);
    if (pending) next.push(command);
    const content = next.map((item) => JSON.stringify(item)).join('\n');
    const stop = command.command === 'StopRun';
    if (
      pending &&
      (next.length > (stop ? 33 : 32) ||
        Buffer.byteLength(content) > MAX_FRAME_BYTES - (stop ? 0 : 4096))
    )
      throw new Error(
        'Resolve pending command receipts before another change. Stop remains available.',
      );
    if (next.length) {
      const temporary = `${this.path}.${createCommandKey()}.next`;
      const file = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(file, content);
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(temporary, this.path);
    } else {
      try {
        unlinkSync(this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    syncDirectory(dirname(this.path));
    this.commands = next;
  }
}
