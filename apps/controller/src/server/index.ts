import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { encodeFrame, FrameDecoder, ProtocolError } from '@crewkite/client';
import { readControllerEndpoint } from '@crewkite/client/node';
import {
  type Command,
  canonicalJson,
  MAX_FRAME_BYTES,
  type TransportMessage,
} from '@crewkite/contracts';
import type { Controller } from '../commands/controller.ts';

export async function serve(
  controller: Controller,
): Promise<{ close: () => Promise<void>; socketPath: string }> {
  const socketPath = join(controller.home, 'control.sock');
  const sockets = new Set<Socket>();
  let ownsSocket = false;
  try {
    try {
      const tokenFile = openSync(
        join(controller.home, 'token'),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        writeFileSync(tokenFile, randomBytes(32).toString('hex'));
        fsyncSync(tokenFile);
      } finally {
        closeSync(tokenFile);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const { token } = readControllerEndpoint(controller.home);
    try {
      const state = lstatSync(socketPath);
      if (!state.isSocket() || state.uid !== process.getuid?.())
        throw new Error('Controller socket path is occupied.');
      unlinkSync(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const server = createServer((socket) => {
      sockets.add(socket);
      const decoder = new FrameDecoder();
      let actor: Command['actor'] | null = null;
      let unsubscribe: (() => void) | undefined;
      let pending = Promise.resolve();
      let queued = 0;
      const send = (message: TransportMessage) => {
        if (socket.destroyed) return;
        if (socket.writableLength > MAX_FRAME_BYTES * 2) {
          socket.destroy();
          return;
        }
        try {
          socket.write(encodeFrame(message));
        } catch (error) {
          socket.destroy();
          throw error;
        }
      };
      const respond = async (command: Command) => {
        try {
          const result = await controller.execute(command, 'local-owner');
          try {
            encodeFrame({ type: 'result', key: command.key, result });
            send({ type: 'result', key: command.key, result });
          } catch {
            send({
              type: 'result',
              key: command.key,
              result: {
                outcome: 'expectedRevision' in command ? 'outcome-unknown' : 'blocked',
                reason: 'response-too-large',
                next:
                  'expectedRevision' in command
                    ? 'Read current state and retry the exact command key.'
                    : 'Request bounded artifact chunks or reduce the retained snapshot.',
              },
            });
          }
        } catch {
          send({
            type: 'result',
            key: command.key,
            result: {
              outcome: 'outcome-unknown',
              reason: 'command-could-not-complete',
              next: 'Refresh state and retry the same command key.',
            },
          });
        }
      };
      const reject = (reason: Extract<TransportMessage, { type: 'error' }>['reason']) => {
        try {
          send({
            type: 'error',
            reason,
            next: 'Reconnect with a valid authenticated protocol 1 client.',
          });
        } finally {
          socket.end();
        }
      };
      socket.setTimeout(5000, () => socket.destroy());
      socket.on('data', (chunk) => {
        try {
          for (const message of decoder.push(chunk)) {
            if (actor === null) {
              if (
                message.type !== 'hello' ||
                !timingSafeEqual(Buffer.from(message.token), Buffer.from(token))
              ) {
                reject('unauthorized');
                return;
              }
              actor = message.actor;
              socket.setTimeout(0);
              send({ type: 'welcome', protocol: 1, cursor: controller.store.cursor() });
              continue;
            }
            if (
              message.type !== 'command' ||
              canonicalJson(message.command.actor) !== canonicalJson(actor)
            ) {
              reject('unauthorized');
              return;
            }
            if (queued >= 32) {
              reject('invalid-frame');
              return;
            }
            queued++;
            const command = message.command;
            let detached = false;
            pending = pending
              .then(async () => {
                if (socket.destroyed) return;
                if (command.command === 'Subscribe') {
                  unsubscribe?.();
                  unsubscribe = undefined;
                  try {
                    const replay = controller.store.eventsAfter(command.payload.after);
                    for (const event of replay) send({ type: 'event', event });
                    unsubscribe = controller.subscribe((event) => send({ type: 'event', event }));
                    send({ type: 'result', key: command.key, result: { outcome: 'applied' } });
                  } catch {
                    send({
                      type: 'resync',
                      reason: 'history-gap',
                      cursor: controller.store.cursor(),
                    });
                    send({ type: 'result', key: command.key, result: { outcome: 'applied' } });
                  }
                  return;
                }
                if (
                  command.command === 'PrepareCandidateEvaluation' &&
                  command.payload.checkRecipeId === 'crewkite-verify-v1'
                ) {
                  detached = true;
                  void respond(command)
                    .catch(() => socket.destroy())
                    .finally(() => {
                      queued--;
                    });
                  return;
                }
                await respond(command);
              })
              .catch(() => {
                socket.destroy();
              })
              .finally(() => {
                if (!detached) queued--;
              });
          }
        } catch (error) {
          reject(error instanceof ProtocolError ? error.reason : 'invalid-frame');
        }
      });
      socket.on('end', () => {
        try {
          decoder.finish();
        } catch {
          socket.destroy();
        }
      });
      socket.on('error', () => socket.destroy());
      socket.once('close', () => {
        unsubscribe?.();
        sockets.delete(socket);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    ownsSocket = true;
    chmodSync(socketPath, 0o600);
    return {
      socketPath,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        if (ownsSocket) {
          try {
            unlinkSync(socketPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          ownsSocket = false;
        }
      },
    };
  } catch (error) {
    if (ownsSocket) unlinkSync(socketPath);

    throw error;
  }
}
