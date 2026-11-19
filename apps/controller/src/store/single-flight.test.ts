import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AcceptanceAttempt, RemoteEffect } from '@crewkite/contracts';
import { Store } from './index.ts';

const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
const at = '2026-11-18T09:00:00.000Z';
const ulid = (prefix: string, last: string) => `${prefix}_01JB7Q0V2N8W3X4Y5Z6A7B8C9${last}`;
const thread = ulid('tsk', 'A');
const other = ulid('tsk', 'B');
const busy = /UNIQUE constraint failed/;

const attempt = (last: string, state: AcceptanceAttempt['state'], taskId = thread) =>
  ({
    id: ulid('acc', last),
    taskId,
    state,
    baseCommit: 'e'.repeat(40),
    candidateTree: 'a'.repeat(40),
    commandsDigest: 'b'.repeat(64),
    choicesDigest: 'f'.repeat(64),
    preparationId: null,
    requiredChecks: [],
    mutatedPaths: [],
    mutatedCount: 0,
    refusal: state === 'refused' ? 'check-failed' : null,
    branch: 'feat/round-totals',
    commit: null,
  }) satisfies AcceptanceAttempt;

const push = (last: string, state: RemoteEffect['state']) =>
  ({
    id: ulid('rfx', last),
    taskId: thread,
    kind: 'push',
    state,
    target: {
      repo: { host: 'github.com', owner: 'crew-kite', name: 'daily-work' },
      branch: 'feat/round-totals',
      pr: null,
      headSha: 'c'.repeat(40),
      baseRef: null,
    },
    request: { kind: 'push', remote: 'origin', commit: 'c'.repeat(40), expectedRemote: null },
    confirmation: state === 'proposed' ? null : { at, by: 'person' },
    observed: state === 'applied' ? { at, result: 'applied', created: null } : null,
    reason: null,
  }) satisfies RemoteEffect;

test('one acceptance is active and one remote write of each kind is in flight per thread', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ck-single-flight-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'state.sqlite'));
  try {
    store.applyMigrations(migrations);
    const write = (work: () => void) => store.transaction(work);
    write(() => {
      for (const id of [thread, other]) store.put('task', id, 0, { id, title: 'Round totals' });
    });

    write(() => store.putAcceptanceAttempt(attempt('1', 'checking'), at));
    assert.throws(
      () => write(() => store.putAcceptanceAttempt(attempt('2', 'reserved'), at)),
      busy,
    );
    // Another thread accepts on its own, and a finished attempt frees its thread.
    write(() => store.putAcceptanceAttempt(attempt('3', 'reserved', other), at));
    write(() => store.putAcceptanceAttempt(attempt('1', 'refused'), at));
    write(() => store.putAcceptanceAttempt(attempt('2', 'reserved'), at));

    // A proposal holds nothing. A write of another kind goes beside one in flight.
    write(() => store.putRemoteEffect(push('1', 'proposed'), at));
    write(() => store.putRemoteEffect(push('2', 'proposed'), at));
    write(() => store.putRemoteEffect(push('1', 'sent'), at));
    assert.throws(() => write(() => store.putRemoteEffect(push('2', 'confirmed'), at)), busy);
    write(() =>
      store.putRemoteEffect(
        {
          ...push('3', 'confirmed'),
          kind: 'pr-ready',
          target: { ...push('3', 'confirmed').target, pr: 7 },
          request: { kind: 'pr-ready' },
        },
        at,
      ),
    );
    // An unknown push keeps the slot until a read of the remote settles it.
    write(() => store.putRemoteEffect(push('1', 'unknown'), at));
    assert.throws(() => write(() => store.putRemoteEffect(push('2', 'confirmed'), at)), busy);
    write(() => store.putRemoteEffect(push('1', 'applied'), at));
    write(() => store.putRemoteEffect(push('2', 'confirmed'), at));

    assert.deepEqual(
      store.acceptanceAttempts(thread).map(({ id, state }) => [id, state]),
      [
        [ulid('acc', '1'), 'refused'],
        [ulid('acc', '2'), 'reserved'],
      ],
    );
    assert.deepEqual(
      store.remoteEffects(thread).map(({ id, state }) => [id, state]),
      [
        [ulid('rfx', '1'), 'applied'],
        [ulid('rfx', '2'), 'confirmed'],
        [ulid('rfx', '3'), 'confirmed'],
      ],
    );
  } finally {
    store.close();
  }
});
