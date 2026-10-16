import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { groupAbsent } from '../../host/worker.ts';
import { OpenAiDiscovery } from './discovery.ts';
import {
  type NativePhase,
  nativeDiscoveryArguments,
  startNativeDiscovery,
  startNativeTask,
} from './native-discovery.ts';

const fixture = `
const { createInterface } = require('node:readline');
const { spawn } = require('node:child_process');
const mode = process.argv[1];
if (process.argv[2] === 'features') {
  const keys = ['plugins', 'remote_plugin', 'apps', 'hooks', 'multi_agent'];
  process.stdout.write('guardianv2.thread_context  stable  true\\n' + keys.filter(key => mode !== 'feature-missing' || key !== 'hooks')
    .map(key => key + '  stable  ' + (mode === 'feature-enabled' && key === 'plugins' ? 'true' : 'false')).join('\\n') + '\\n');
  process.exit(0);
}
if (mode === 'stubborn') process.on('SIGTERM', () => {});
const config = {
  model_provider: 'openai', service_tier: 'default', approval_policy: 'on-request',
  openai_base_url: '', chatgpt_base_url: 'https://chatgpt.com/backend-api/',
  features: { plugins: false, remote_plugin: false, apps: false, hooks: false, multi_agent: false },
  approvals_reviewer: 'user', sandbox_mode: 'read-only', web_search: 'disabled',
  private: 'private-native-diagnostic', mcp_servers: {},
};
const replies = {
  initialize: { userAgent: 'private-native-diagnostic', platformFamily: 'unix', platformOs: 'fixture' },
  'account/read': { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true },
  'config/read': { config, origins: { private: 'private-native-diagnostic' } },
  'configRequirements/read': { requirements: mode === 'policy-change' ? { featureRequirements: { plugins: true } } : null },
  'account/rateLimits/read': { ordinaryUsageAllowed: true, rateLimits: {} },
  'model/list': { data: [], nextCursor: null },
};
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  if (!message.id) return;
  if (message.method === 'initialize' && (message.params.capabilities.explicitGatewayOauth !== true || message.params.capabilities.experimentalApi !== false)) process.exit(3);
  if (mode === 'invalid' || mode === 'stubborn') {
    if (mode === 'stubborn') spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'inherit' });
    process.stdout.write(JSON.stringify({ id: 99, method: 'auth/request', secret: 'private-native-diagnostic' }) + '\\n');
    return;
  }
  if (mode === 'oversized') return process.stderr.write(Buffer.alloc(1048577));
  if (mode === 'truncated') return process.stdout.write('{"id":1');
  if (message.method === 'model/list' && mode === 'descendant')
    spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit' });
  const notices = mode === 'notifications' && message.method === 'initialize' ?
    JSON.stringify({ method: 'configWarning', emittedAtMs: 1234, params: { summary: 'private-native-diagnostic', details: null } }) + '\\n' +
    JSON.stringify({ method: 'account/updated', emittedAtMs: 1234, params: { authMode: null, planType: null } }) + '\\n' +
    JSON.stringify({ method: 'remoteControl/status/changed', emittedAtMs: 1234, params: { status: 'disabled', serverName: 'private-native-diagnostic', installationId: 'private-native-diagnostic', environmentId: null } }) + '\\n' : '';
  process.stdout.write(JSON.stringify({ id: message.id, result: replies[message.method] }) + '\\n' + notices);
});
input.on('close', () => { if (mode !== 'stubborn' && mode !== 'trailing-partial') process.exit(mode === 'bad-exit' ? 1 : 0); });
if (mode === 'trailing-partial') process.stdin.on('end', () => { process.stdout.write('{', () => process.exit(0)); });
`;

test('native discovery returns metadata only after its owned process and descendants stop', async () => {
  mkdirSync(resolve('internal'), { recursive: true });
  const root = mkdtempSync(resolve('internal/native-discovery-'));
  const sha256 = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
  const owned: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<void> }> = [];
  const sourceEnvironment = {
    HOME: root,
    CODEX_HOME: resolve(root, 'native-auth'),
    PATH: process.env.PATH,
    OPENAI_API_KEY: 'private-native-diagnostic',
    OPENAI_BASE_URL: 'https://example.invalid',
    CODEX_REMOTE: 'https://example.invalid',
  };
  try {
    for (const mode of [
      'success',
      'notifications',
      'trailing-partial',
      'maximum-bound',
      'descendant',
      'invalid',
      'oversized',
      'stopped',
      'stubborn',
      'bad-exit',
      'launch',
      'truncated',
      'feature-enabled',
      'feature-missing',
      'policy-change',
    ]) {
      const directory = resolve(root, mode);
      mkdirSync(directory, { mode: 0o700 });
      let spawned = 0;
      const schedules: Array<() => void> = [];
      const handle = startNativeDiscovery(
        {
          executable: process.execPath,
          sha256,
          directory,
          repositoryRoot: root,
          environment: sourceEnvironment,
        },
        {
          timeoutMs: mode === 'maximum-bound' ? 60_000 : 5000,
          ...(mode === 'truncated'
            ? {
                schedule: (work: () => void, _milliseconds: number) => {
                  schedules.push(work);
                  return () => {};
                },
              }
            : {}),
          spawn: (executable, args, options) => {
            spawned++;
            assert.equal(executable, process.execPath);
            const phase = args.at(-1) === 'list' ? 'features' : 'discovery';
            assert.deepEqual(
              args,
              phase === 'features'
                ? [...nativeDiscoveryArguments(directory).slice(0, -3), 'features', 'list']
                : nativeDiscoveryArguments(directory),
            );
            assert.equal(options.detached, true);
            assert.equal(options.env.HOME, root);
            assert.equal(options.env.CODEX_HOME, sourceEnvironment.CODEX_HOME);
            assert.equal(options.env.OPENAI_API_KEY, undefined);
            assert.equal(options.env.OPENAI_BASE_URL, undefined);
            assert.equal(options.env.CODEX_REMOTE, undefined);
            assert.equal(options.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED, '1');
            const child = spawn(
              mode === 'launch' ? resolve(directory, 'absent') : process.execPath,
              ['-e', fixture, mode, phase],
              options,
            );
            owned.push({
              child,
              closed: new Promise((resolve) => child.once('close', () => resolve())),
            });
            return child;
          },
        },
      );
      if (mode === 'stopped') handle.stop();
      if (mode === 'truncated') {
        // The deadline callback is injected; no wall-clock delay is needed to request stop.
        schedules[0]();
      }
      const result = await handle.result;
      assert.equal(
        spawned,
        ['stopped', 'launch', 'truncated', 'feature-enabled', 'feature-missing'].includes(mode)
          ? 1
          : 2,
        mode,
      );
      assert.equal(result.quiescent, true, mode);
      assert(Number.isSafeInteger(result.stdoutBytes) && result.stdoutBytes >= 0, mode);
      assert(Number.isSafeInteger(result.stderrBytes) && result.stderrBytes >= 0, mode);
      if (mode === 'feature-enabled' || mode === 'feature-missing')
        assert.equal(result.lastRequest, 'features-list', mode);
      if (mode === 'invalid' || mode === 'stubborn') {
        assert.equal(result.lastRequest, 'initialize', mode);
        assert.equal(result.refusedEnvelope?.kind, 'other-notification', mode);
        assert.equal(result.refusedEnvelope?.extraEnvelopeFields, true, mode);
        assert(!JSON.stringify(result.refusedEnvelope).includes('auth/request'), mode);
      }
      if (mode === 'policy-change')
        assert.equal(result.lastRequest, 'configRequirements/read', mode);
      for (const group of handle.groups) if (group > 0) assert(groupAbsent(group), mode);
      assert(!JSON.stringify(result).includes('private-native-diagnostic'), mode);
      if (
        mode === 'success' ||
        mode === 'notifications' ||
        mode === 'maximum-bound' ||
        mode === 'descendant'
      ) {
        assert.equal(result.reason, null, mode);
        assert.equal(result.notifications, mode === 'notifications' ? 3 : 0);
        assert.equal(result.lastEnvelope, 'response');
        assert.equal(result.refusedEnvelope, null);
        assert.equal(result.metadata?.configuration?.model_provider, 'openai', mode);
      } else {
        assert.equal(result.metadata, null, mode);
        assert(result.reason, mode);
      }
    }
    const lifecycleCases = [
      { name: 'three phases', failure: '', sequence: -1 },
      ...['intent', 'owned', 'quiescent'].flatMap((failure) =>
        [0, 1, 2].map((sequence) => ({ name: `${failure}-${sequence}`, failure, sequence })),
      ),
      { name: 'stop during preparation ownership', failure: 'owned-stop', sequence: 1 },
      { name: 'stop during task ownership', failure: 'owned-stop', sequence: 2 },
      { name: 'async intent', failure: 'intent-async', sequence: 0 },
      { name: 'async ownership', failure: 'owned-async', sequence: 1 },
      { name: 'async closure', failure: 'quiescent-async', sequence: 1 },
      { name: 'cancel after features', failure: 'stop', sequence: 0 },
      { name: 'cancel after preparation', failure: 'stop', sequence: 1 },
    ];
    for (const entry of lifecycleCases) {
      const directory = resolve(root, entry.name);
      mkdirSync(directory, { mode: 0o700 });
      const trace: string[] = [];
      const groups: number[] = [];
      const ownedGroups = new Set<number>();
      const closedGroups = new Set<number>();
      let writesWithoutOwnership = 0;
      let stop: (() => void) | undefined;
      const checkpoint = (point: string, phase: NativePhase) => {
        trace.push(`${point}:${phase.sequence}`);
        if (entry.failure === point && entry.sequence === phase.sequence)
          throw new Error('Fixture persistence failure.');
        if (entry.failure === `${point}-async` && entry.sequence === phase.sequence)
          return Promise.resolve();
      };
      const start = () =>
        startNativeTask(
          {
            executable: process.execPath,
            sha256,
            directory,
            repositoryRoot: root,
            environment: sourceEnvironment,
          },
          {
            timeoutMs: 300_000,
            disableMcpServers: true,
            onSubmitted: () => assert.fail('Metadata fixtures submit no native turn.'),
            lifecycle: {
              beforePhase: (phase) => {
                assert.deepEqual(
                  phase.kind,
                  ['effective-features', 'metadata-preparation', 'app-server-task'][phase.sequence],
                );
                if (phase.sequence > 0)
                  assert.equal(trace.at(-1), `quiescent:${phase.sequence - 1}`);
                return checkpoint('intent', phase);
              },
              owned: (phase, group) => {
                assert.equal(trace.at(-1), `spawn:${phase.sequence}`);
                const pending = checkpoint('owned', phase);
                if (pending) return pending;
                ownedGroups.add(group);
                if (entry.failure === 'owned-stop' && entry.sequence === phase.sequence) stop?.();
              },
              quiescent: (phase, group) => {
                assert(closedGroups.has(group), 'closure follows closed process streams');
                assert(groupAbsent(group), 'closure follows process-group absence');
                const pending = checkpoint('quiescent', phase);
                if (pending) return pending;
                if (entry.failure === 'stop' && entry.sequence === phase.sequence) stop?.();
              },
            },
            spawn: (executable, args, options) => {
              const sequence = groups.length;
              assert.equal(trace.at(-1), `intent:${sequence}`);
              trace.push(`spawn:${sequence}`);
              assert(groups.every(groupAbsent), 'preceding phase has stopped before spawn');
              const child = spawn(
                executable,
                ['-e', fixture, 'success', args.at(-1) === 'list' ? 'features' : 'discovery'],
                options,
              );
              const group = child.pid as number;
              groups.push(group);
              const write = child.stdin.write.bind(child.stdin);
              child.stdin.write = ((data: string | Uint8Array) => {
                if (!ownedGroups.has(group)) writesWithoutOwnership++;
                assert(ownedGroups.has(group), 'ownership persists before protocol input');
                trace.push(`input:${sequence}`);
                return write(data);
              }) as typeof child.stdin.write;
              owned.push({
                child,
                closed: new Promise((resolve) =>
                  child.once('close', () => {
                    closedGroups.add(group);
                    resolve();
                  }),
                ),
              });
              return child;
            },
          },
          (remaining) =>
            new OpenAiDiscovery({
              now: () => 1,
              timeoutMs: Math.min(60_000, remaining),
              readConfiguration: true,
              configurationDirectory: directory,
            }),
        );
      if (entry.failure.startsWith('intent') && entry.sequence === 0) {
        assert.throws(start, /persistence failure|synchronously/, entry.name);
        assert.equal(groups.length, 0, entry.name);
        continue;
      }
      const handle = start();
      stop = handle.stop;
      const result = await handle.result;
      assert.equal(writesWithoutOwnership, 0, entry.name);
      if (entry.failure === 'owned-stop')
        assert.equal(trace.includes(`input:${entry.sequence}`), false, entry.name);
      assert(groups.every(groupAbsent), entry.name);
      assert.equal(result.quiescent, true, entry.name);
      assert.equal(
        groups.length,
        entry.failure === '' ? 3 : entry.sequence + (entry.failure.startsWith('intent') ? 0 : 1),
        entry.name,
      );
      if (entry.failure === '') {
        assert.equal(result.reason, null, entry.name);
        assert(result.metadata, entry.name);
        assert.equal(trace.at(-1), 'quiescent:2');
      } else {
        assert(result.reason, entry.name);
        assert.equal(result.metadata, null, entry.name);
      }
    }
    let spawned = false;
    assert.throws(
      () =>
        startNativeDiscovery(
          {
            executable: process.execPath,
            sha256: '0'.repeat(64),
            directory: root,
            repositoryRoot: resolve('internal'),
            environment: sourceEnvironment,
          },
          {
            timeoutMs: 1,
            spawn: () => {
              spawned = true;
              throw new Error('unexpected');
            },
          },
        ),
      /identity changed/,
    );
    assert.equal(spawned, false);
    assert.throws(
      () =>
        startNativeDiscovery(
          {
            executable: process.execPath,
            sha256,
            directory: root,
            repositoryRoot: resolve('internal'),
            environment: sourceEnvironment,
          },
          {
            timeoutMs: 60_001,
            spawn: () => {
              spawned = true;
              throw new Error('unexpected');
            },
          },
        ),
      /deadline is invalid/,
    );
    assert.equal(spawned, false);
    const publicDirectory = resolve(root, 'public');
    mkdirSync(publicDirectory, { mode: 0o755 });
    const linked = resolve(root, 'linked');
    symlinkSync(resolve(root, 'success'), linked, 'dir');
    for (const directory of [publicDirectory, linked]) {
      assert.throws(
        () =>
          startNativeDiscovery(
            {
              executable: process.execPath,
              sha256,
              directory,
              repositoryRoot: root,
              environment: sourceEnvironment,
            },
            {
              timeoutMs: 1,
              spawn: () => {
                spawned = true;
                throw new Error('unexpected');
              },
            },
          ),
        /private storage/,
      );
    }
    assert.equal(spawned, false);
  } finally {
    for (const { child } of owned) {
      const group = child.pid;
      if (group && Number.isSafeInteger(group) && !groupAbsent(group)) {
        try {
          process.kill(-group, 'SIGKILL');
        } catch {}
      }
    }
    let cancel!: ReturnType<typeof setTimeout>;
    const closed = await Promise.race([
      Promise.all(owned.map(({ closed }) => closed)).then(() => true),
      new Promise<false>((resolve) => {
        cancel = setTimeout(() => resolve(false), 2000);
      }),
    ]);
    clearTimeout(cancel);
    const absent = owned.every(({ child }) => !child.pid || groupAbsent(child.pid));
    if (closed && absent) rmSync(root, { recursive: true, force: true });
    assert(closed && absent, 'fixture cleanup must prove owned streams and groups absent');
  }
});
