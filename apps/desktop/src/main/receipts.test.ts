import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Command, CommandSchema } from '@crewkite/contracts';
import { sendRetained } from './receipts.ts';

const command: Command = CommandSchema.parse({
  protocol: 1,
  key: `cmd_${'0'.repeat(25)}1`,
  actor: { id: 'desktop', kind: 'desktop' },
  expectedRevision: 3,
  command: 'RefreshLocalModels',
  payload: { consent: 'explicit' },
});

// The receipt list without the disk, so a test sees what is held at each step.
function memoryReceipts() {
  const receipts = {
    commands: [] as Command[],
    retain(value: Command, pending: boolean) {
      receipts.commands = receipts.commands.filter((item) => item.key !== value.key);
      if (pending) receipts.commands.push(value);
    },
  };
  return receipts;
}

test('a change in flight holds its receipt and announces nothing until it answers', async () => {
  const receipts = memoryReceipts();
  const announced: boolean[] = [];
  let answer: (value: { outcome: string }) => void = () => {};
  const sent = sendRetained(
    receipts,
    command,
    () => new Promise<{ outcome: string }>((done) => (answer = done)),
    (available) => announced.push(available),
  );
  assert.deepEqual(receipts.commands, [command]);
  assert.deepEqual(announced, []);
  answer({ outcome: 'blocked' });
  assert.deepEqual(await sent, { outcome: 'blocked' });
  assert.deepEqual(receipts.commands, []);
  assert.deepEqual(announced, [false]);
});

test('an unknown outcome or a lost answer keeps the receipt and announces the retry', async () => {
  const receipts = memoryReceipts();
  const announced: boolean[] = [];
  await sendRetained(
    receipts,
    command,
    async () => ({ outcome: 'outcome-unknown' }),
    (available) => announced.push(available),
  );
  assert.deepEqual(receipts.commands, [command]);
  await assert.rejects(
    sendRetained(
      receipts,
      command,
      async () => {
        throw new Error('The controller closed the connection.');
      },
      (available) => announced.push(available),
    ),
  );
  assert.deepEqual(receipts.commands, [command]);
  assert.deepEqual(announced, [true, true]);
});
