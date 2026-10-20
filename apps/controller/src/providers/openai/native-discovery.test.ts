import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { spawnCheckChild as spawn } from '../../host/check-ownership.ts';
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
  'model/list': {
    data: mode === 'empty-catalog' ? [] : [{
      id: 'native-model', model: 'native-model',
      supportedReasoningEfforts: [{ reasoningEffort: 'native-effort' }],
      defaultReasoningEffort: 'native-effort',
    }],
    nextCursor: null,
  },
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
  if (mode.startsWith('flood:')) {
    const [stdout, stderr] = mode.split(':').slice(1).map(Number);
    return process.stderr.write(Buffer.alloc(stderr, 32), () =>
      process.stdout.write(Buffer.alloc(stdout, 32), () => process.exit(0)));
  }
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

// One stdout write of the requested size, ending in a newline, then wait for input to close.
const writer = `
process.stdout.write('x'.repeat(Number(process.argv[1]) - 1) + '\\n');
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
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
      'empty-catalog',
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
      if (mode === 'empty-catalog') {
        assert.equal(result.lastRequest, 'model/list', mode);
        assert.equal(result.reason, 'protocol', mode);
      }
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
      // A reader that names no bound keeps the one MiB default.
      if (mode === 'oversized') assert.equal(result.reason, 'output-limit', mode);
    }
    for (const mode of [
      'callback-stop',
      'callback-cutoff',
      'callback-deadline',
      'callback-async',
      'late-close',
      'before-marker',
    ]) {
      const directory = resolve(root, mode);
      mkdirSync(directory, { mode: 0o700 });
      const schedules: { milliseconds: number; work: () => void }[] = [];
      let clock = 0;
      let submissions = 0;
      let writes = 0;
      let ready!: () => void;
      const submitted = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let phase = 0;
      let sent = false;
      const handle = startNativeTask(
        {
          executable: process.execPath,
          sha256,
          directory,
          repositoryRoot: root,
          environment: sourceEnvironment,
        },
        {
          timeoutMs: 300_000,
          now: () => clock,
          schedule: (work, milliseconds) => {
            schedules.push({ work, milliseconds });
            return () => {};
          },
          onSubmitted: () => {
            submissions++;
            ready();
            if (mode === 'callback-stop') handle.stop();
            if (mode === 'callback-cutoff') clock = 298_000;
            if (mode === 'callback-deadline') clock = 300_000;
            if (mode === 'callback-async') return Promise.resolve();
          },
          spawn: (executable, args, options) => {
            const task = args.at(-1) !== 'list';
            const child = spawn(
              executable,
              ['-e', fixture, 'success', task ? 'task' : 'features'],
              options,
            );
            const write = child.stdin.write.bind(child.stdin);
            child.stdin.write = ((data: string | Uint8Array) => {
              for (const line of Buffer.from(data).toString().trim().split('\n'))
                if (JSON.parse(line).method === 'turn/start') writes++;
              return write(data);
            }) as typeof child.stdin.write;
            if (task && mode === 'late-close')
              child.once('close', () => {
                clock = 300_000;
              });
            owned.push({
              child,
              closed: new Promise((resolve) => child.once('close', () => resolve())),
            });
            return child;
          },
        },
        () => ({
          next: () => {
            if (sent || phase === 2) return null;
            sent = true;
            if (phase === 0)
              return Buffer.from(
                `${JSON.stringify({ id: 1, method: 'initialize', params: { capabilities: { explicitGatewayOauth: true, experimentalApi: false } } })}\n`,
              );
            if (mode === 'before-marker') {
              clock = 298_000;
              ready();
            }
            return Buffer.from(`${JSON.stringify({ id: 2, method: 'turn/start', params: {} })}\n`);
          },
          push: () => {
            phase++;
            sent = false;
          },
          finish: () => ({ completed: true }),
          get submitted() {
            return phase === 1 && sent;
          },
          get complete() {
            return phase === 2;
          },
          pendingRequest: 'turn/start',
          lastEnvelope: null,
          refusedEnvelope: null,
          notifications: 0,
        }),
      );
      await submitted;
      if (mode !== 'late-close')
        schedules
          .find((call) => call.milliseconds === (mode === 'callback-deadline' ? 0 : 250))
          ?.work();
      const result = await handle.result;
      assert.equal(submissions, mode === 'before-marker' ? 0 : 1, mode);
      assert.equal(writes, mode === 'late-close' ? 1 : 0, mode);
      assert.equal(
        result.reason,
        mode === 'callback-stop' ? 'stopped' : mode === 'callback-async' ? 'protocol' : 'deadline',
        mode,
      );
      assert.equal(result.metadata, null, mode);
      assert.equal(result.quiescent, true, mode);
      assert(handle.groups.every(groupAbsent), mode);
    }
    for (const mode of [
      'queued-close',
      'unobserved-close',
      'live-at-cutoff',
      'late-kill',
      'late-kill-reversed',
      'late-kill-near-deadline',
    ]) {
      const directory = resolve(root, mode);
      mkdirSync(directory, { mode: 0o700 });
      const schedules: Array<{ milliseconds: number; work: () => void; live: boolean }> = [];
      let capture = true;
      const ready = Promise.withResolvers<void>();
      let clock = 0;
      let phase = 0;
      let sent = false;
      let task: ChildProcessWithoutNullStreams | undefined;
      let closed: Promise<void> | undefined;
      let closeSeen = false;
      let callbackError: unknown;
      let onExit: (() => void) | undefined;
      const fire = (milliseconds: number) => {
        const row = schedules.find((row) => row.live && row.milliseconds === milliseconds);
        assert(row, `${mode}: pending ${milliseconds}ms callback`);
        row.live = false;
        row.work();
      };
      const handle = startNativeTask(
        {
          executable: process.execPath,
          sha256,
          directory,
          repositoryRoot: root,
          environment: sourceEnvironment,
        },
        {
          timeoutMs: 300_000,
          now: () => clock,
          schedule: (work, milliseconds) => {
            const row = { work, milliseconds, live: true };
            schedules.push(row);
            let timer: ReturnType<typeof setTimeout> | undefined;
            if (!capture) {
              const at = clock + milliseconds;
              timer = setTimeout(() => {
                row.live = false;
                clock = Math.max(clock, at);
                work();
              }, milliseconds);
            }
            return () => {
              row.live = false;
              clearTimeout(timer);
            };
          },
          onSubmitted: () => ready.resolve(),
          spawn: (executable, args, options) => {
            const isTask = args.at(-1) !== 'list';
            const child = spawn(
              executable,
              ['-e', fixture, 'success', isTask ? 'task' : 'features'],
              options,
            );
            const completed = new Promise<void>((resolve) =>
              child.once('close', () => {
                if (isTask) closeSeen = true;
                resolve();
              }),
            );
            owned.push({ child, closed: completed });
            if (isTask) {
              task = child;
              closed = completed;
              child.once('exit', () => onExit?.());
            }
            return child;
          },
        },
        () => ({
          next: () => {
            if (sent || phase >= 2) return null;
            sent = true;
            return Buffer.from(
              `${JSON.stringify(
                phase === 0
                  ? {
                      id: 1,
                      method: 'initialize',
                      params: {
                        capabilities: { explicitGatewayOauth: true, experimentalApi: false },
                      },
                    }
                  : { id: 2, method: 'turn/start', params: {} },
              )}\n`,
            );
          },
          push: () => {
            phase++;
            sent = false;
          },
          finish: () => ({ completed: true }),
          get submitted() {
            return phase === 1 && sent;
          },
          complete: false,
          pendingRequest: 'turn/start',
          lastEnvelope: null,
          refusedEnvelope: null,
          notifications: 0,
        }),
      );
      await ready.promise;
      assert(task);
      assert(closed);
      const child = task;
      handle.stop();
      if (mode === 'live-at-cutoff') {
        clock = 2000;
        assert.equal(groupAbsent(child.pid as number), false);
        fire(2000);
        assert.equal(
          schedules.some((row) => row.live && row.milliseconds === 0),
          false,
        );
      } else if (mode.startsWith('late-kill')) {
        // A blocked loop runs an owned task's stop timers in one pass. Node runs one duration
        // list at a time, so an older 2000 ms list can reach the cutoff before the kill.
        clock = mode === 'late-kill-near-deadline' ? 299_500 : 2000;
        capture = false;
        for (const milliseconds of mode === 'late-kill-reversed'
          ? [250, 2000, 1000]
          : [250, 1000, 2000])
          fire(milliseconds);
      } else {
        onExit = () => {
          try {
            clock = 2000;
            assert.equal(closeSeen, false);
            assert(groupAbsent(child.pid as number));
            if (mode === 'queued-close') capture = false;
            fire(1000);
            fire(2000);
            if (mode === 'unobserved-close') {
              assert.equal(schedules.filter((row) => row.live && row.milliseconds === 0).length, 1);
              fire(0);
            }
          } catch (error) {
            callbackError = error;
          }
        };
        fire(250);
      }
      const result = await handle.result;
      assert.ifError(callbackError);
      assert.equal(result.metadata, null, mode);
      const quiet = mode === 'queued-close' || mode.startsWith('late-kill');
      assert.equal(result.quiescent, quiet, mode);
      assert.equal(result.reason, quiet ? 'stopped' : 'ownership', mode);
      if (mode === 'late-kill-near-deadline')
        assert(
          schedules.some((row) => row.milliseconds === 500),
          `${mode}: the late kill waits only until the deadline`,
        );
      if (mode === 'live-at-cutoff') child.stdin.end();
      await closed;
      assert(groupAbsent(child.pid as number));
      assert.deepEqual(await handle.result, result, `${mode}: late closure cannot heal a result`);
      assert.equal(
        schedules.some((row) => row.live),
        false,
        `${mode}: settlement cancels every timer`,
      );
    }
    // A task reader names its own bound, here above the one MiB default. The process may write
    // exactly that many bytes and is stopped by the next one.
    const bound = 1_572_864;
    for (const [mode, written, reason] of [
      ['output-at-bound', bound, null],
      ['output-past-bound', bound + 1, 'output-limit'],
    ] as const) {
      const directory = resolve(root, mode);
      mkdirSync(directory, { mode: 0o700 });
      let complete = false;
      const handle = startNativeTask(
        {
          executable: process.execPath,
          sha256,
          directory,
          repositoryRoot: root,
          environment: sourceEnvironment,
        },
        {
          timeoutMs: 300_000,
          // A stop gives the native interrupt 250 ms before it ends input. Run that step at once.
          // After a complete response the same delay only confirms the stop, so it stays pending.
          schedule: (work, milliseconds) => {
            if (milliseconds === 250 && !complete) queueMicrotask(work);
            return () => {};
          },
          onSubmitted: () => assert.fail('Output rows submit no native turn.'),
          spawn: (executable, args, options) => {
            const child = spawn(
              executable,
              args.at(-1) === 'list'
                ? ['-e', fixture, 'success', 'features']
                : ['-e', writer, String(written)],
              options,
            );
            owned.push({
              child,
              closed: new Promise((resolve) => child.once('close', () => resolve())),
            });
            return child;
          },
        },
        () => ({
          next: () => null,
          push: (bytes) => {
            complete = bytes.at(-1) === 10;
          },
          finish: () => ({ completed: true }),
          get complete() {
            return complete;
          },
          pendingRequest: 'turn/start',
          lastEnvelope: null,
          refusedEnvelope: null,
          notifications: 0,
          outputLimit: bound,
        }),
      );
      const result = await handle.result;
      assert.equal(result.reason, reason, mode);
      assert.equal(result.stdoutBytes, written, mode);
      assert.deepEqual(result.metadata, reason ? null : { completed: true }, mode);
      assert.equal(result.quiescent, true, mode);
      assert(handle.groups.every(groupAbsent), mode);
    }
    // A task transcript sets the byte bound for stdout and stderr together.
    const limit = 4096;
    for (const row of [
      { name: 'stdout over', stdout: limit + 1, stderr: 0, reason: 'output-limit' },
      { name: 'stderr over', stdout: 0, stderr: limit + 1, reason: 'output-limit' },
      { name: 'split over', stdout: limit / 2 + 1, stderr: limit / 2, reason: 'output-limit' },
      { name: 'split at limit', stdout: limit / 2, stderr: limit / 2, reason: null },
    ]) {
      const directory = resolve(root, `flood-${row.name.replace(' ', '-')}`);
      mkdirSync(directory, { mode: 0o700 });
      let sent = false;
      let pushed = false;
      const handle = startNativeTask(
        {
          executable: process.execPath,
          sha256,
          directory,
          repositoryRoot: root,
          environment: sourceEnvironment,
        },
        {
          timeoutMs: 10_000,
          onSubmitted: () => {},
          spawn: (executable, args, options) => {
            const child = spawn(
              executable,
              [
                '-e',
                fixture,
                `flood:${row.stdout}:${row.stderr}`,
                args.at(-1) === 'list' ? 'features' : 'task',
              ],
              options,
            );
            owned.push({
              child,
              closed: new Promise((resolve) => child.once('close', () => resolve())),
            });
            return child;
          },
        },
        () => ({
          outputLimit: limit,
          next: () => {
            if (sent) return null;
            sent = true;
            return Buffer.from(
              `${JSON.stringify({ id: 1, method: 'initialize', params: { capabilities: { explicitGatewayOauth: true, experimentalApi: false } } })}\n`,
            );
          },
          push: () => {
            pushed = true;
          },
          finish: () => ({ completed: true }),
          get complete() {
            return pushed;
          },
          pendingRequest: 'turn/start',
          lastEnvelope: null,
          refusedEnvelope: null,
          notifications: 0,
        }),
      );
      const result = await handle.result;
      assert.equal(result.reason, row.reason, row.name);
      assert.equal(result.quiescent, true, row.name);
      assert.deepEqual(result.metadata, row.reason ? null : { completed: true }, row.name);
      assert(handle.groups.every(groupAbsent), row.name);
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
    chmodSync(publicDirectory, 0o755);
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
