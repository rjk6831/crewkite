import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
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

test('authentication metadata waits for bounded owned child and descendant cleanup', async () => {
  mkdirSync(resolve('internal'), { recursive: true });
  const root = mkdtempSync(resolve('internal/auth-process-'));
  const sha256 = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
  const owned: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<void> }> = [];
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
    ]) {
      const directory = join(root, mode);
      mkdirSync(directory, { mode: 0o700 });
      let ready!: () => void;
      const output = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let deadline: (() => void) | undefined;
      let launches = 0;
      const handle = startNativeAuthStatus(
        { executable: process.execPath, sha256, directory, repositoryRoot: root, environment },
        {
          now: () => 0,
          schedule: (work, milliseconds) => {
            if (milliseconds === 30000) {
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
              PATH: '/usr/bin:/bin',
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
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
        assert(deadline, 'leader exit cannot cancel the metadata deadline before EOF');
        deadline();
      } else if (['stopped', 'stubborn', 'deadline'].includes(mode)) {
        await output;
        if (mode === 'deadline') {
          assert(deadline);
          deadline();
        } else handle.stop();
      }
      const result = await handle.result;
      assert.equal(launches, 1, mode);
      assert.equal(result.quiescent, true, mode);
      if (handle.group > 0) assert(groupAbsent(handle.group), mode);
      assert(!JSON.stringify(result).includes(secret), mode);
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
          }[mode],
          mode,
        );
      }
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
