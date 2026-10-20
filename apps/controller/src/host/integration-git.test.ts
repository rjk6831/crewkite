import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import {
  createIntegrationGit,
  type IntegrationGitLifecycle,
  type IntegrationGitOptions,
} from './integration-git.ts';
import { type FileContent, git, treeFromFiles } from './source.ts';

const runId = `run_${'0'.repeat(26)}`;
const executable = realpathSync(
  execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim(),
);
const pinnedGit = {
  executable,
  sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
};
function file(
  path: string,
  text: string | Buffer,
  mode: FileContent['mode'] = '100644',
): FileContent {
  const content = Buffer.isBuffer(text) ? text : Buffer.from(text);
  return {
    path,
    mode,
    content,
    bytes: content.length,
    hash: createHash('sha256').update(content).digest('hex'),
  };
}
function temporary(t: { after: (callback: () => void) => void }) {
  mkdirSync(resolve('internal'), { recursive: true });
  const directory = realpathSync(mkdtempSync(join(resolve('internal'), 'integration-git-test-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('integration refs preserve exact trees and expected heads', async (t) => {
  const directory = temporary(t);
  const template = join(directory, 'ambient-template');
  mkdirSync(join(template, 'hooks'), { recursive: true });
  writeFileSync(join(template, 'hooks', 'reference-transaction'), 'ambient hook');
  const ambientConfig = join(directory, 'ambient-config');
  writeFileSync(
    ambientConfig,
    `[init]\n\ttemplateDir = ${template}\n[core]\n\tsharedRepository = all\n`,
  );
  const ambient = {
    GIT_TEMPLATE_DIR: template,
    GIT_CONFIG_GLOBAL: ambientConfig,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(directory, 'absent-objects'),
  };
  const previous = Object.fromEntries(Object.keys(ambient).map((key) => [key, process.env[key]]));
  Object.assign(process.env, ambient);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const trace: string[] = [];
  const groups: number[] = [];
  let lastPhase = -1;
  const lifecycle: IntegrationGitLifecycle = {
    beforePhase(phase) {
      if (phase.sequence === 0) lastPhase = -1;
      assert.equal(phase.sequence, lastPhase + 1);
      if (phase.sequence > 0) assert.equal(trace.at(-1), `closed:${lastPhase}`);
      assert.match(phase.digest, /^[a-f0-9]{64}$/);
      assert.equal(Object.isFrozen(phase), true);
      trace.push(`before:${phase.sequence}`);
      lastPhase = phase.sequence;
    },
    owned(phase, group) {
      assert.equal(trace.at(-1), `before:${phase.sequence}`);
      assert.ok(group > 0);
      groups.push(group);
      trace.push(`owned:${phase.sequence}`);
    },
    quiescent(phase, group) {
      assert.equal(trace.at(-1), `owned:${phase.sequence}`);
      assert.throws(() => process.kill(-group, 0), { code: 'ESRCH' });
      trace.push(`closed:${phase.sequence}`);
    },
  };
  const options = (): IntegrationGitOptions => ({
    deadline: performance.now() + 15_000,
    lifecycle,
  });
  const host = createIntegrationGit({ directory, runId, git: pinnedGit });
  const repository = join(directory, `integration-${runId}.git`);
  const ref = `refs/crewkite/integration/${runId}`;
  assert.equal(existsSync(repository), false);
  assert.equal((await host.initialize(options()).result).value, true);
  assert.equal(readFileSync(join(repository, 'HEAD'), 'utf8'), 'ref: refs/heads/private\n');
  assert.equal(existsSync(join(repository, 'hooks')), false);
  assert.equal(existsSync(join(repository, 'objects/info/alternates')), false);
  assert.deepEqual(await host.readHead(options()).result, {
    value: null,
    reason: null,
    quiescent: true,
  });
  const original = [
    file('nested/é\tquote"\nfile', 'last line'),
    file('binary', Buffer.from([0, 255, 13, 10])),
    file('run', 'same\n', '100755'),
    file('ordinary', 'same\n'),
  ];
  const first = await host.importTree(original, options()).result;
  assert.equal(first.reason, null);
  assert.ok(first.value);
  assert.match(first.value ?? '', /^[a-f0-9]{40}$/);
  const independent = join(directory, 'expected');
  assert.equal(first.value, treeFromFiles(independent, original));
  assert.equal(
    (await host.importTree([...original].reverse(), options()).result).value,
    first.value,
  );
  assert.equal(
    (await host.compareAndSwap({ old: null, new: first.value }, options()).result).reason,
    null,
  );
  assert.equal(git(repository, ['cat-file', '-t', ref]).toString(), 'tree\n');
  const nextFiles = [file('ordinary', 'changed'), file('added', ''), file('run', 'same\n')];
  const second = (await host.importTree(nextFiles, options()).result).value;
  assert.ok(second);
  assert.notEqual(second, first.value);
  const stale = await host.compareAndSwap({ old: null, new: second }, options()).result;
  assert.equal(stale.reason, 'git');
  assert.equal(stale.quiescent, true);
  assert.equal((await host.readHead(options()).result).value, first.value);
  assert.equal(
    (await host.compareAndSwap({ old: first.value, new: second }, options()).result).reason,
    null,
  );
  assert.equal((await host.readHead(options()).result).value, second);
  assert.equal(second, treeFromFiles(independent, nextFiles));
  const blob = git(repository, ['hash-object', '-w', '--stdin'], 'not a tree').toString().trim();
  assert.equal(
    (await host.compareAndSwap({ old: second, new: blob }, options()).result).reason,
    'git',
  );
  assert.equal(
    (await host.compareAndSwap({ old: second, new: 'f'.repeat(40) }, options()).result).reason,
    'git',
  );
  assert.equal((await host.readHead(options()).result).value, second);
  git(repository, ['symbolic-ref', ref, 'refs/heads/other']);
  assert.equal(
    (await host.compareAndSwap({ old: null, new: second }, options()).result).reason,
    'git',
  );
  assert.equal((await host.readHead(options()).result).reason, 'git');
  git(repository, ['symbolic-ref', '--delete', ref]);
  assert.equal((await host.readHead(options()).result).value, null);
  const unsupported = [
    [file('../escape', '')],
    [file('same', ''), file('SAME', '')],
    [file('prefix', ''), file('prefix/child', '')],
    [{ ...file('wrong', ''), hash: '0'.repeat(64) }],
    [{ ...file('size', ''), bytes: 1 }],
    [{ ...file('mode', ''), mode: '120000' as FileContent['mode'] }],
  ];
  for (const files of unsupported) assert.throws(() => host.importTree(files, options()));
  assert.throws(() => host.compareAndSwap({ old: null, new: '--help' }, options()));
  assert.throws(() => createIntegrationGit({ directory, runId: '../elsewhere', git: pinnedGit }));
  const alias = join(directory, 'alias');
  symlinkSync(directory, alias);
  assert.throws(() => createIntegrationGit({ directory: alias, runId, git: pinnedGit }));
  writeFileSync(join(repository, 'objects/info/alternates'), independent);
  assert.equal((await host.readHead(options()).result).reason, 'git');
  rmSync(join(repository, 'objects/info/alternates'));
  renameSync(join(repository, 'config'), join(repository, 'config.saved'));
  execFileSync('mkfifo', [join(repository, 'config')]);
  assert.equal((await host.readHead(options()).result).reason, 'git');
  assert.ok(groups.length > 0);
  for (const group of groups) assert.throws(() => process.kill(-group, 0), { code: 'ESRCH' });
});

test('integration effects require durable ownership and quiescence', async (t) => {
  const cases = [
    'success',
    'close before group disappears',
    'intent refused',
    'owner refused',
    'closure refused',
    'async owner',
    'deadline before spawn',
    'stop',
    'deadline',
    'late close',
    'late final',
    'output',
    'stdout error',
    'stderr error',
    'missing close',
    'missing EOF',
    'remaining group',
    'nonzero',
    'spawn throw',
  ];
  for (const name of cases) {
    const directory = temporary(t);
    let current = 0;
    let exists = true;
    let launches = 0;
    let releases = 0;
    let closures = 0;
    let child!: EventEmitter & {
      stdin: Writable;
      stdout: PassThrough;
      stderr: PassThrough;
      pid: number;
    };
    const scheduled: Array<{ at: number; work: () => void; cancelled: boolean }> = [];
    const signals: NodeJS.Signals[] = [];
    const close = (code = 0) => {
      exists = ['remaining group', 'close before group disappears'].includes(name);
      if (name === 'close before group disappears')
        scheduled.push({
          at: current + 1,
          work: () => {
            exists = false;
          },
          cancelled: false,
        });
      if (name !== 'missing EOF') {
        child.stdout.end();
        child.stderr.end();
      }
      setImmediate(() => {
        if (name !== 'missing close') child.emit('close', code, null);
      });
    };
    const host = createIntegrationGit(
      { directory, runId, git: pinnedGit },
      {
        now: () => current,
        schedule(work, milliseconds) {
          const entry = { at: current + milliseconds, work, cancelled: false };
          scheduled.push(entry);
          return () => {
            entry.cancelled = true;
          };
        },
        groupAbsent: () => !exists,
        signal(group, signal) {
          assert.equal(group, 12345);
          signals.push(signal);
          if (!['missing close', 'missing EOF', 'remaining group'].includes(name)) close(1);
        },
        spawn(_executable, argv, options) {
          launches++;
          assert.deepEqual(argv.slice(1), ['integration-git-child-v1']);
          assert.equal(options.detached, true);
          assert.equal(options.env.GIT_CONFIG_GLOBAL, '/dev/null');
          assert.equal(options.env.GIT_ALTERNATE_OBJECT_DIRECTORIES, undefined);
          if (name === 'spawn throw') throw Error('launch failed');
          const frames: Buffer[] = [];
          child = Object.assign(new EventEmitter(), {
            pid: 12345,
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            stdin: new Writable({
              write(chunk, _encoding, callback) {
                frames.push(Buffer.from(chunk));
                callback();
              },
              final(callback) {
                releases++;
                const frame = Buffer.concat(frames);
                assert.equal(frame.readUInt32BE(0), frame.length - 4);
                const release = JSON.parse(frame.subarray(4).toString());
                assert.equal(release.kind, 'initialize');
                if (name === 'output') child.stdout.write(Buffer.alloc(1024 * 1024 + 1));
                else if (name === 'stdout error')
                  child.stdout.emit('error', Error('untrusted output'));
                else if (name === 'stderr error')
                  child.stderr.emit('error', Error('untrusted output'));
                else if (!['stop', 'deadline'].includes(name)) {
                  if (name === 'late close') current = 1000;
                  close(name === 'nonzero' ? 1 : 0);
                }
                callback();
              },
            }),
          });
          return child as unknown as ChildProcessWithoutNullStreams;
        },
      },
    );
    const lifecycle: IntegrationGitLifecycle = {
      beforePhase(phase) {
        assert.equal(phase.kind, 'initialize');
        assert.equal(launches, 0);
        if (name === 'intent refused') throw Error('intent failed');
        if (name === 'deadline before spawn') current = 1000;
      },
      owned() {
        assert.equal(releases, 0);
        if (name === 'owner refused') throw Error('owner failed');
        if (name === 'async owner') return Promise.resolve() as unknown as undefined;
      },
      quiescent() {
        closures++;
        if (name === 'closure refused') throw Error('closure failed');
        if (name === 'late final')
          queueMicrotask(() => {
            current = 1000;
          });
      },
    };
    const operation = host.initialize({ deadline: 1000, lifecycle });
    if (name === 'stop') operation.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (name === 'close before group disappears') {
      assert.equal(closures, 0);
      assert.deepEqual(signals, []);
    }
    while (scheduled.length) {
      scheduled.sort((a, b) => a.at - b.at);
      const timer = scheduled.shift();
      assert(timer);
      if (timer.cancelled) continue;
      current = timer.at;
      timer.work();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const outcome = await operation.result;
    assert.equal(
      outcome.reason === null,
      ['success', 'close before group disappears'].includes(name),
      name,
    );
    if (name === 'close before group disappears') {
      assert.equal(current, 10);
      assert.equal(closures, 1);
      assert.deepEqual(signals, []);
    }
    if (['deadline', 'late close', 'late final'].includes(name))
      assert.equal(outcome.reason, 'deadline', name);
    if (['output', 'stdout error', 'stderr error'].includes(name))
      assert.equal(outcome.reason, 'output', name);
    assert.equal(
      launches,
      ['intent refused', 'deadline before spawn'].includes(name) ? 0 : 1,
      name,
    );
    assert.equal(
      releases,
      [
        'intent refused',
        'owner refused',
        'async owner',
        'deadline before spawn',
        'spawn throw',
      ].includes(name)
        ? 0
        : 1,
      name,
    );
    if (
      [
        'missing close',
        'missing EOF',
        'remaining group',
        'owner refused',
        'closure refused',
        'async owner',
      ].includes(name)
    ) {
      assert.equal(outcome.reason, 'ownership', name);
      assert.equal(outcome.quiescent, false, name);
      assert.throws(
        () => host.initialize({ deadline: current + 1000, lifecycle }),
        /unresolved/,
        name,
      );
    } else assert.equal(outcome.quiescent, true, name);
    if (['missing close', 'missing EOF', 'remaining group'].includes(name))
      assert.equal(closures, 0, name);
    if (name === 'missing close') {
      child.emit('close', 0, null);
      assert.equal(closures, 1);
      assert.equal(outcome.quiescent, false);
      assert.throws(() => host.initialize({ deadline: current + 1000, lifecycle }), /unresolved/);
    }
    if (['intent refused', 'deadline before spawn', 'spawn throw'].includes(name))
      assert.deepEqual(signals, [], name);
  }
});
