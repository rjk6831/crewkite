import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { ArtifactFiles } from '../../../artifacts/index.ts';
import { spawnCheckChild as spawn } from '../../../host/check-ownership.ts';
import { groupAbsent } from '../../../host/worker.ts';
import { GoogleAcpInstallation, type InstallRecord } from './install-operation.ts';

test('installation Stop waits for owned signature closure and recovery never replays', async () => {
  mkdirSync(resolve('internal'), { recursive: true });
  const root = mkdtempSync(resolve('internal/install-operation-'));
  const artifacts = new ArtifactFiles(resolve(root, 'artifacts'));
  const hashes: string[] = [];
  const records = () =>
    hashes.map((hash) => JSON.parse(artifacts.read(hash).toString()) as InstallRecord);
  const journal = {
    latest: () => records().at(-1) ?? null,
    forKey: (key: string) => records().findLast((record) => record.key === key) ?? null,
    append: (record: InstallRecord) => {
      hashes.push(artifacts.publish(Buffer.from(JSON.stringify(record))).hash);
    },
    now: () => '2026-10-21T00:00:00.000Z',
  };
  let launches = 0;
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const operation = new GoogleAcpInstallation({
    ...journal,
    install: async (input, dependencies) => {
      launches++;
      assert.equal(journal.latest()?.phase, 'intent');
      assert.equal(input.consent, 'explicit');
      const lifecycle = dependencies?.import?.lifecycle;
      assert.ok(lifecycle);
      for (let index = 0; index < 2; index++) {
        lifecycle.beforePhase();
        const child = spawn(
          process.execPath,
          ['-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"],
          {
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        assert.ok(child.pid);
        lifecycle.owned(child.pid);
        if (index === 1) {
          input.onProgress?.({ step: 'verify', bytes: 10, totalBytes: 10 });
          ready.resolve();
          await release.promise;
          assert.equal(input.signal?.aborted, true);
        }
        const ended = once(child, 'close');
        child.stdin.end();
        await ended;
        assert.ok(groupAbsent(child.pid));
        lifecycle.quiescent(child.pid);
      }
      closed.resolve();
      return { imported: false, reason: 'cancelled', client: null };
    },
  });
  try {
    const input = { key: 'first', requestHash: 'a'.repeat(64), home: root };
    const pending = operation.install(input);
    assert.equal(operation.install(input), pending);
    await ready.promise;
    assert.equal(operation.status().state, 'installing');
    // The running step reaches the status from memory. The journal never records it.
    assert.deepEqual(operation.status().progress, { step: 'verify', bytes: 10, totalBytes: 10 });
    assert.ok(records().every((record) => record.status.progress === undefined));
    assert.equal(
      (await operation.install({ ...input, requestHash: 'b'.repeat(64) })).outcome,
      'denied',
    );
    let settled = false;
    const stopping = operation.stop(input.key).then((result) => {
      settled = true;
      return result;
    });
    const closing = operation.close();
    assert.ok(closing instanceof Promise);
    let closeSettled = false;
    void closing.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    assert.equal(closeSettled, false);
    assert.equal(settled, false);
    assert.equal(operation.status().state, 'stopping');
    release.resolve();
    await closed.promise;
    const stopped = await stopping;
    await closing;
    assert.equal(closeSettled, true);
    assert.equal(stopped.outcome, 'blocked');
    assert.equal(stopped.reason, 'cancelled');
    assert.equal(operation.status().state, 'blocked');
    assert.equal(
      records()
        .at(-1)
        ?.signatures.filter((phase) => phase.state === 'closed').length,
      2,
    );
    const retryOperation = new GoogleAcpInstallation({
      ...journal,
      install: async () => {
        assert.fail('A completed install cannot replay.');
      },
    });
    assert.equal((await retryOperation.install(input)).reason, 'cancelled');
    assert.equal(retryOperation.close(), undefined);
    assert.equal(launches, 1);
    const previous = records().at(-1);
    assert.ok(previous);
    for (const phase of ['intent', 'complete', 'signature'] as const) {
      const key = `crashed-${phase}`;
      journal.append({
        ...previous,
        key,
        step: 0,
        phase,
        signatures:
          phase === 'intent'
            ? []
            : previous.signatures.map((signature) => ({
                ...signature,
                state: phase === 'signature' ? 'owned' : 'closed',
              })),
        status: {
          ...previous.status,
          state: phase === 'complete' ? 'unknown' : 'installing',
          operationId: key,
        },
      });
      const recovered = new GoogleAcpInstallation({
        ...journal,
        install: async () => {
          launches++;
          return { imported: false, reason: 'cancelled', client: null };
        },
      });
      const before: number = launches;
      const retry = await recovered.install({ ...input, key });
      assert.equal(retry.reason, 'google-install-interrupted');
      assert.equal(launches, before);
      assert.equal(
        (await recovered.install({ ...input, key: `${key}-fresh` })).reason,
        'cancelled',
      );
      assert.equal(launches, phase === 'intent' ? 2 : phase === 'complete' ? 3 : 4);
      await recovered.close();
    }
    const warning = new GoogleAcpInstallation({
      ...journal,
      install: async () => ({
        imported: true,
        reason: 'already-imported',
        client: null,
        cleanupReason: 'temporary-cleanup-failed',
      }),
    });
    const warned = await warning.install({ ...input, key: 'warning' });
    assert.equal(warned.outcome, 'applied');
    assert.equal(warned.data.install.state, 'installed');
    assert.equal(warned.reason, 'temporary-cleanup-failed');
    assert.match(warned.next ?? '', /Temporary cleanup failed/);
    await warning.close();
    journal.append({
      ...previous,
      key: 'uncertain',
      step: 0,
      phase: 'signature',
      signatures: [{ sequence: 1, state: 'intent', group: null }],
      status: { ...previous.status, state: 'installing', operationId: 'uncertain' },
    });
    const unknown = new GoogleAcpInstallation(journal);
    assert.equal(unknown.status().state, 'unknown');
    assert.equal((await unknown.install({ ...input, key: 'new' })).outcome, 'blocked');
    assert.equal(launches, 4);
    await unknown.close();
  } finally {
    await operation.close();
    rmSync(root, { recursive: true, force: true });
  }
});
