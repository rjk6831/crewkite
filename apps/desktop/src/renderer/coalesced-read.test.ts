import assert from 'node:assert/strict';
import test from 'node:test';
import { coalescedRead } from './coalesced-read.ts';

test('a caller gets the next read after its call while new calls keep arriving', async () => {
  const passes: PromiseWithResolvers<number | undefined>[] = [];
  const read = coalescedRead(() => {
    const pass = Promise.withResolvers<number | undefined>();
    passes.push(pass);
    return pass.promise;
  });
  const settle = async () => {
    for (let index = 0; index < 6; index++) await Promise.resolve();
  };
  const first = read();
  const second = read();
  await settle();
  assert.equal(passes.length, 1, 'calls during a read share one more read');
  let answered: number | null = null;
  const local = read().then((value) => {
    answered = value;
  });
  passes[0].resolve(1);
  assert.equal(await first, 1);
  await settle();
  // A steady stream of calls, as a setup poll each second makes: the earlier caller is answered
  // by the read that started after it, not held until the stream stops.
  const poll = read();
  passes[1].resolve(2);
  await local;
  assert.equal(answered, 2);
  assert.equal(await second, 2);
  await settle();
  passes[2].resolve(3);
  assert.equal(await poll, 3);
});

test('a read that changed under it runs again, and a failure reaches only its own callers', async () => {
  const answers: (number | undefined | Error)[] = [undefined, 4, new Error('offline'), 5];
  const read = coalescedRead(async () => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  assert.equal(await read(), 4);
  await assert.rejects(read(), /offline/);
  assert.equal(await read(), 5);
});
