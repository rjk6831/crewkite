import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { spawnCheckChild as spawn } from '../../host/check-ownership.ts';
import { groupAbsent } from '../../host/worker.ts';
import { NativeDiscoveryError, startNativeAuthStatus } from './native-discovery.ts';

const secret = 'private-native-account@example.test';
const fixture = `
const { spawn } = require('node:child_process');
const { MessageChannel } = require('node:worker_threads');
const mode = process.argv[1];
const status = JSON.stringify({ authMethod: mode === 'signed-out' ? 'none' : 'claude.ai', email: '${secret}', token: '${secret}' });
const hold = () => { const channel = new MessageChannel(); channel.port1.on('message', () => {}); };
process.stdin.resume();
process.stdin.on('end', () => {
  if (mode === 'stdout-limit') return process.stdout.write(Buffer.alloc(65537));
  if (mode === 'stderr-limit') return process.stderr.write(Buffer.alloc(16385));
  if (mode === 'truncated') return process.stdout.write('{"authMethod":');
  if (mode === 'stubborn' || mode.startsWith('descendant')) {
    if (mode === 'stubborn') process.on('SIGTERM', () => {});
    const child = spawn(process.execPath, ['-e', "const {MessageChannel}=require('node:worker_threads');process.on('SIGTERM',()=>{});const channel=new MessageChannel();channel.port1.on('message',()=>{});process.send('ready');"], { stdio: ['inherit','inherit','inherit','ipc'] });
    child.once('message', () => {
      process.stdout.write(status + '\\n', () => { if (mode.startsWith('descendant')) process.exit(0); });
    });
    return;
  }
  process.stdout.write(status + '\\n', () => {
    if (mode === 'stopped' || mode === 'deadline') hold();
    else process.exit(mode === 'bad-exit' || mode === 'signed-out' ? 1 : 0);
  });
});
`;

test('authentication metadata waits for bounded owned child and descendant cleanup', {
  skip:
    process.platform !== 'darwin' &&
    'Linux process ownership is unqualified: an orphan that init never reaps keeps its group present after SIGKILL',
}, async () => {
  mkdirSync(resolve('internal'), { recursive: true });
  const root = mkdtempSync(resolve('internal/auth-process-'));
  const sha256 = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
  const owned: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<void> }> = [];
  const waitFor = async <T>(mode: string, phase: string, pending: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error(`${mode}: ${phase} did not finish within the metadata deadline`)),
            30_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const environment = {
    HOME: root,
    USER: secret,
    LOGNAME: secret,
    ANTHROPIC_API_KEY: secret,
    ANTHROPIC_AUTH_TOKEN: secret,
    CLAUDE_CODE_OAUTH_TOKEN: secret,
    ANTHROPIC_BASE_URL: 'https://example.invalid',
    HTTPS_PROXY: secret,
    GH_TOKEN: secret,
    DEBUG: '1',
    CLAUDE_CODE_ENTRYPOINT: secret,
    // A client installed as a script finds node on the person's own PATH.
    PATH: '/opt/person/bin:/usr/bin:/bin',
  };
  try {
    for (const mode of [
      'success',
      'signed-out',
      'descendant',
      'descendant-deadline',
      'stopped',
      'stubborn',
      'deadline',
      'stdout-limit',
      'stderr-limit',
      'truncated',
      'bad-exit',
      'launch',
      'spawn-throw',
      'owned-throw',
      'owned-promise',
      'owned-deadline',
      'quiescent-throw',
      'quiescent-promise',
      'quiescent-deadline',
    ]) {
      const directory = join(root, mode);
      mkdirSync(directory, { mode: 0o700 });
      let ready!: () => void;
      const output = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let deadline: (() => void) | undefined;
      let launches = 0;
      let time = 0;
      const trace: string[] = [];
      const handle = startNativeAuthStatus(
        { executable: process.execPath, sha256, directory, repositoryRoot: root, environment },
        {
          now: () => time,
          ...(mode.endsWith('-deadline') && mode !== 'descendant-deadline'
            ? { deadline: 6000 }
            : {}),
          lifecycle: {
            beforePhase: (kind) => {
              assert.equal(kind, 'auth-status');
              trace.push('before');
            },
            owned: (kind, group) => {
              assert.equal(kind, 'auth-status');
              trace.push('owned');
              const child = owned.at(-1)?.child;
              assert.equal(child?.pid, group);
              assert(
                child && child.listenerCount('error') > 0 && child.stdin.listenerCount('error') > 0,
              );
              if (mode === 'owned-throw') throw Error(secret);
              if (mode === 'owned-promise') return Promise.reject(Error(secret));
              if (mode === 'owned-deadline') time = 5000;
            },
            quiescent: (kind, group) => {
              assert.equal(kind, 'auth-status');
              assert(groupAbsent(group));
              trace.push('quiescent');
              if (mode === 'quiescent-throw') throw Error(secret);
              if (mode === 'quiescent-promise') return Promise.reject(Error(secret));
              if (mode === 'quiescent-deadline') time = 6000;
            },
          },
          schedule: (work, milliseconds) => {
            if (
              milliseconds ===
              (mode.endsWith('-deadline') && mode !== 'descendant-deadline' ? 4000 : 28000)
            ) {
              deadline = work;
              return () => {
                deadline = undefined;
              };
            }
            const timer = setTimeout(work, milliseconds);
            return () => clearTimeout(timer);
          },
          spawn: (executable, argv, options) => {
            launches++;
            assert.equal(executable, process.execPath);
            assert.deepEqual(argv, ['auth', 'status']);
            assert.equal(options.detached, true);
            assert.deepEqual(options.env, {
              HOME: root,
              USER: userInfo().username,
              PATH: '/opt/person/bin:/usr/bin:/bin',
              LANG: 'C',
              TMPDIR: join(directory, 'tmp'),
              DISABLE_UPDATES: '1',
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
              CLAUDE_CODE_SAFE_MODE: '1',
              CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
              CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
            });
            if (mode === 'spawn-throw') throw new Error(secret);
            const child = spawn(
              mode === 'launch' ? join(directory, 'absent') : process.execPath,
              ['-e', fixture, mode],
              options,
            );
            child.stdout.once('data', () => ready());
            owned.push({
              child,
              closed: new Promise((resolve) => child.once('close', () => resolve())),
            });
            return child;
          },
        },
      );
      if (mode === 'descendant-deadline') {
        const child = owned.at(-1)?.child;
        assert(child);
        await waitFor(
          mode,
          'leader exit',
          new Promise<void>((resolve) => child.once('exit', () => resolve())),
        );
        assert(deadline, 'leader exit cannot cancel the metadata deadline before EOF');
        deadline();
      } else if (['stopped', 'stubborn', 'deadline'].includes(mode)) {
        await waitFor(mode, 'first output', output);
        if (mode === 'deadline') {
          assert(deadline);
          deadline();
        } else handle.stop();
      }
      const result = await waitFor(mode, 'result', handle.result);
      assert.equal(launches, 1, mode);
      assert.equal(result.quiescent, true, mode);
      if (handle.group > 0) assert(groupAbsent(handle.group), mode);
      assert(!JSON.stringify(result).includes(secret), mode);
      assert.equal(trace[0], 'before', mode);
      assert.equal(trace.filter((step) => step === 'owned').length, handle.group > 0 ? 1 : 0, mode);
      assert.equal(
        trace.filter((step) => step === 'quiescent').length,
        handle.group > 0 ? 1 : 0,
        mode,
      );
      if (['success', 'signed-out', 'descendant'].includes(mode)) {
        assert.equal(result.reason, null, mode);
        assert.equal(
          result.metadata?.status,
          mode === 'signed-out' ? 'signed-out' : 'subscription-candidate',
          mode,
        );
        assert.equal(result.metadata?.qualified, false, mode);
        assert.equal(result.metadata?.billing, 'unknown', mode);
      } else {
        assert.equal(result.metadata, null, mode);
        assert.equal(
          result.reason,
          {
            stopped: 'stopped',
            stubborn: 'stopped',
            deadline: 'deadline',
            'descendant-deadline': 'deadline',
            'stdout-limit': 'output-limit',
            'stderr-limit': 'output-limit',
            truncated: 'protocol',
            'bad-exit': 'protocol',
            launch: 'launch',
            'spawn-throw': 'launch',
            'owned-throw': 'ownership',
            'owned-promise': 'ownership',
            'owned-deadline': 'deadline',
            'quiescent-throw': 'ownership',
            'quiescent-promise': 'ownership',
            'quiescent-deadline': 'deadline',
          }[mode],
          mode,
        );
      }
    }
    for (const mode of [
      'queued-close',
      'late-kill',
      'late-kill-reversed',
      'late-kill-near-deadline',
    ]) {
      const directory = join(root, mode);
      mkdirSync(directory, { mode: 0o700 });
      let time = 0;
      let ready!: () => void;
      const output = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let callbackError: unknown;
      const timers: Array<{ milliseconds: number; work: () => void; live: boolean }> = [];
      let capture = true;
      // Every due callback is found before the first one runs, so the order stays the test's.
      const fire = (order: number[]) => {
        const due = order.map((milliseconds) => {
          const row = timers.find((timer) => timer.live && timer.milliseconds === milliseconds);
          assert(row, `${mode}: pending ${milliseconds}ms callback`);
          return row;
        });
        capture = false;
        for (const row of due) {
          row.live = false;
          row.work();
        }
      };
      const handle = startNativeAuthStatus(
        { executable: process.execPath, sha256, directory, repositoryRoot: root, environment },
        {
          now: () => time,
          schedule: (work, milliseconds) => {
            const row = { milliseconds, work, live: true };
            timers.push(row);
            let timer: ReturnType<typeof setTimeout> | undefined;
            if (!capture) {
              const at = time + milliseconds;
              timer = setTimeout(() => {
                row.live = false;
                time = Math.max(time, at);
                work();
              }, milliseconds);
            }
            return () => {
              row.live = false;
              clearTimeout(timer);
            };
          },
          spawn: (_executable, _argv, options) => {
            const child = spawn(
              process.execPath,
              ['-e', fixture, mode === 'queued-close' ? 'stopped' : 'stubborn'],
              options,
            );
            child.stdout.once('data', () => ready());
            owned.push({
              child,
              closed: new Promise((resolve) => child.once('close', () => resolve())),
            });
            // This listener runs before the process handler's own. The cutoff then meets an
            // exited group whose stream-close event is still queued.
            if (mode === 'queued-close')
              child.once('exit', () => {
                try {
                  time = 2000;
                  fire([1000, 2000]);
                } catch (error) {
                  callbackError = error;
                }
              });
            return child;
          },
        },
      );
      await waitFor(mode, 'first output', output);
      handle.stop();
      if (mode !== 'queued-close') {
        // A blocked loop runs the stop timers in one pass. Node runs one duration list at a
        // time, so an older 2000 ms list can reach the verdict before the kill.
        time = mode === 'late-kill-near-deadline' ? 29_500 : 2000;
        fire(mode === 'late-kill-reversed' ? [2000, 1000] : [1000, 2000]);
      }
      const result = await waitFor(mode, 'result', handle.result);
      assert.ifError(callbackError);
      assert.equal(result.quiescent, true, mode);
      assert.equal(result.reason, 'stopped', mode);
      assert(groupAbsent(handle.group), mode);
      if (mode === 'late-kill-near-deadline')
        assert(
          timers.some((timer) => timer.milliseconds === 500),
          `${mode}: the late kill waits only until the deadline`,
        );
      assert.equal(
        timers.some((timer) => timer.live),
        false,
        `${mode}: settlement cancels every timer`,
      );
    }
    for (const mode of [
      'expired',
      'validation-time',
      'before-time',
      'before-throw',
      'before-promise',
    ]) {
      const directory = join(root, mode);
      mkdirSync(directory, { mode: 0o700 });
      let time = 0;
      let ticks = 0;
      let launched = false;
      assert.throws(
        () =>
          startNativeAuthStatus(
            { executable: process.execPath, sha256, repositoryRoot: root, directory, environment },
            {
              deadline: mode === 'expired' ? 2000 : 6000,
              now: () => (mode === 'validation-time' && ++ticks > 2 ? 5000 : time),
              lifecycle: {
                beforePhase: () => {
                  if (mode === 'before-time') time = 5000;
                  if (mode === 'before-throw') throw Error(secret);
                  if (mode === 'before-promise') return Promise.reject(Error(secret));
                },
                owned: () => assert.fail('No child should be owned.'),
                quiescent: () => assert.fail('No child should close.'),
              },
              spawn: () => {
                launched = true;
                throw Error(secret);
              },
            },
          ),
        (error: unknown) =>
          error instanceof NativeDiscoveryError &&
          error.reason ===
            (mode === 'before-throw' || mode === 'before-promise' ? 'ownership' : 'deadline'),
      );
      assert.equal(launched, false, mode);
    }
    const directory = join(root, 'refused');
    mkdirSync(directory, { mode: 0o700 });
    const linked = join(root, 'linked');
    symlinkSync(directory, linked);
    const shared = join(root, 'shared');
    mkdirSync(shared, { mode: 0o755 });
    for (const change of [
      { sha256: '0'.repeat(64) },
      { directory: linked },
      { directory: `${shared}/` },
      { environment: { HOME: root, CLAUDE_CONFIG_DIR: '/private/native-profile' } },
    ]) {
      let spawned = false;
      assert.throws(
        () =>
          startNativeAuthStatus(
            {
              executable: process.execPath,
              sha256,
              directory,
              repositoryRoot: root,
              environment,
              ...change,
            },
            {
              spawn: () => {
                spawned = true;
                throw new Error(secret);
              },
            },
          ),
        (error) => error instanceof NativeDiscoveryError && !error.message.includes(secret),
      );
      assert.equal(spawned, false);
    }
  } finally {
    for (const { child } of owned) {
      const group = child.pid;
      if (group && Number.isSafeInteger(group) && !groupAbsent(group)) {
        try {
          process.kill(-group, 'SIGKILL');
        } catch {}
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      Promise.all(owned.map(({ closed }) => closed)).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 2000);
      }),
    ]);
    clearTimeout(timer);
    const absent = owned.every(({ child }) => !child.pid || groupAbsent(child.pid));
    if (closed && absent) rmSync(root, { recursive: true, force: true });
    assert(closed && absent, 'owned fixture streams and groups must be absent');
  }
});
