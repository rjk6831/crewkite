import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { AnthropicNativeProfileSchema } from '@crewkite/contracts';
import { ArtifactFiles } from '../../artifacts/index.ts';
import { spawnCheckChild as spawn } from '../../host/check-ownership.ts';
import { groupAbsent } from '../../host/worker.ts';
import { unavailableNativeProfile } from '../openai/profile.ts';
import { type ConnectionRecord, NativeConnectionChecks } from './native-connection.ts';

test('connection metadata retains closure and idempotence without task authority', async () => {
  mkdirSync(resolve('internal'), { recursive: true });
  const root = mkdtempSync(resolve('internal/native-connection-'));
  const artifacts = new ArtifactFiles(resolve(root, 'artifacts'));
  const hashes: string[] = [];
  const records = () =>
    hashes.map((hash) => JSON.parse(artifacts.read(hash).toString()) as ConnectionRecord);
  const journal = {
    latest: () => records().at(-1) ?? null,
    completed: (key: string) =>
      records().findLast((record) => record.key === key && record.phase === 'complete') ?? null,
    append: (record: ConnectionRecord) => {
      hashes.push(artifacts.publish(Buffer.from(JSON.stringify(record))).hash);
    },
    now: () => '2026-10-21T00:00:00.000Z',
  };
  const profile = {
    ...unavailableNativeProfile(),
    facts: AnthropicNativeProfileSchema.parse({
      id: 'anthropic-file-v1',
      family: 'anthropic',
      displayName: 'Anthropic fixture',
      clientVersion: process.version,
      model: 'fixture',
      effort: 'medium',
      effectiveEffort: 'unknown',
      accountClass: 'unknown',
      serviceTier: 'unknown',
      billingBasis: 'requires-user-attestation',
      qualifiedAt: null,
      creditPolicies: ['ordinary'],
      maximumTaskMs: 300000,
      maximumFileBytes: 65536,
      maximumSubmissions: 1,
      available: true,
      reason: 'qualification-pending',
    }),
    client: {
      executable: process.execPath,
      version: process.version,
      sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
    },
    environment: { HOME: root },
  };
  let launches = 0;
  const groups: number[] = [];
  const checks = new NativeConnectionChecks(journal);
  try {
    for (const name of ['claude.ai', 'none', 'api_key', 'recovered-closed', 'recovered-owned']) {
      const method = name.startsWith('recovered-') ? 'claude.ai' : name;
      if (name.startsWith('recovered-')) {
        const previous = records().find((record) => record.phase === 'owned');
        assert.ok(previous);
        journal.append({
          ...previous,
          key: `${name}-interrupted`,
          phase: name === 'recovered-closed' ? 'closed' : 'owned',
        });
        const before = launches;
        const retry = await checks.check({
          key: `${name}-interrupted`,
          requestHash: previous.requestHash,
          profile,
          directory: root,
          repositoryRoot: root,
        });
        assert.equal(retry.outcome, 'blocked');
        assert.equal(retry.reason, 'anthropic-connection-interrupted');
        assert.equal(launches, before);
        assert.equal(checks.status().state, 'blocked');
        assert.equal(journal.latest()?.phase, 'complete');
      }
      const directory = resolve(root, name);
      mkdirSync(directory, { mode: 0o700 });
      const input = {
        key: name,
        requestHash: 'a'.repeat(64),
        profile,
        directory,
        repositoryRoot: root,
      };
      const pending = checks.check(input, {
        spawn: (executable, args, options) => {
          assert.equal(executable, process.execPath);
          assert.deepEqual(args, ['auth', 'status']);
          assert.equal(journal.latest()?.phase, 'intent');
          launches++;
          const child = spawn(
            process.execPath,
            [
              '-e',
              `process.stdout.write(${JSON.stringify(JSON.stringify({ authMethod: method, email: 'discard@example.invalid', token: 'discard' }))},()=>process.exit(${method === 'none' ? 1 : 0}));`,
            ],
            options,
          );
          assert.ok(child.pid);
          groups.push(child.pid);
          return child;
        },
      });
      assert.equal(checks.status().state, 'checking');
      assert.equal(checks.check(input), pending);
      assert.equal(
        (await checks.check({ ...input, requestHash: 'b'.repeat(64) })).outcome,
        'denied',
      );
      const result = await pending;
      assert.equal(result.outcome, method === 'claude.ai' ? 'applied' : 'blocked');
      const status = checks.status();
      assert.equal(
        status.state,
        method === 'claude.ai' ? 'signed-in' : method === 'none' ? 'signed-out' : 'unsupported',
      );
      assert.equal(status.billing, 'unknown');
      assert.equal(status.quota, 'unknown');
      assert.equal(status.qualified, false);
      assert.equal(JSON.stringify(records()).includes('discard'), false);
      assert.deepEqual(
        records()
          .filter((record) => record.key === name)
          .map((record) => record.phase),
        ['intent', 'owned', 'closed', 'complete'],
      );
      const before = launches;
      assert.equal(
        (await checks.check(input)).outcome,
        method === 'claude.ai' ? 'already-applied' : 'blocked',
      );
      assert.equal(launches, before);
    }
    const intent = records().find((record) => record.phase === 'intent');
    assert.ok(intent);
    journal.append({ ...intent, key: 'interrupted' });
    const reopened = new NativeConnectionChecks(journal);
    assert.equal(reopened.status().state, 'unknown');
    assert.equal(
      (
        await reopened.check({
          key: 'retry',
          requestHash: 'a'.repeat(64),
          profile,
          directory: root,
          repositoryRoot: root,
        })
      ).outcome,
      'blocked',
    );
    assert.equal(launches, 5);
    assert.ok(groups.every(groupAbsent));
    await reopened.close();
  } finally {
    await checks.close();
    rmSync(root, { recursive: true, force: true });
  }
});
