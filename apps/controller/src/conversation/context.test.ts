import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { git } from '../host/source.ts';
import { captureConversationContext } from './context.ts';

test('selected conversation context retains exact bounded source and log bytes without authority', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'conversation-context-')));
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  try {
    git(root, ['init', '-q']);
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'logs'));
    mkdirSync(join(root, 'many'));
    writeFileSync(join(root, 'src/a.ts'), 'export const answer = 42;\n');
    writeFileSync(join(root, 'src/案内.md'), '選択した文脈\n');
    writeFileSync(join(root, 'literal*[x].ts'), 'literal path\n');
    writeFileSync(join(root, 'bom.txt'), '\uFEFFsource with BOM\n');
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0xff, 0, 0x80]));
    writeFileSync(join(root, '.env'), 'DO_NOT_READ_CONTEXT_SECRET=canary\n');
    writeFileSync(join(root, 'large.txt'), 'x'.repeat(8193));
    writeFileSync(join(root, 'escaped.txt'), '\\'.repeat(8192));
    writeFileSync(join(root, 'escaped2.txt'), '\\'.repeat(8192));
    for (let index = 0; index < 33; index++) writeFileSync(join(root, 'many', `${index}.txt`), 'x');
    symlinkSync('src/a.ts', join(root, 'source-link'));
    git(root, ['add', '--all']);
    git(root, ['commit', '-qm', 'fixture'], undefined, {
      name: 'Context fixture',
      email: 'context@example.invalid',
      at: '2026-10-17T00:00:00Z',
    });
    const base = git(root, ['rev-parse', 'HEAD']).toString().trim();
    const indexBefore = sha(readFileSync(join(root, '.git/index')));
    writeFileSync(join(root, 'src/a.ts'), 'dirty source stays private\n');
    writeFileSync(join(root, 'logs/build.log'), 'explicit selected log\r\n');
    chmodSync(join(root, 'logs/build.log'), 0o600);
    const defaults = { projectRoot: root, projectId: 'prj_00000000000000000000000001', base };
    const capture = (selections: Parameters<typeof captureConversationContext>[0]['selections']) =>
      captureConversationContext({ ...defaults, selections });
    const first = capture([
      { kind: 'source-folder', path: 'src' },
      { kind: 'log-file', path: 'logs/build.log' },
    ]);
    const second = capture([
      { kind: 'log-file', path: 'logs/build.log' },
      { kind: 'source-file', path: 'src/a.ts' },
      { kind: 'source-folder', path: 'src' },
    ]);
    assert.deepEqual(first, second);
    assert.equal(first.hash, sha(first.content));
    assert.equal(first.bytes, first.content.length);
    assert.deepEqual(
      first.bundle.files.map((file) => [file.path, file.text]),
      [
        ['logs/build.log', 'explicit selected log\r\n'],
        ['src/a.ts', 'export const answer = 42;\n'],
        ['src/案内.md', '選択した文脈\n'],
      ],
    );
    assert(Object.isFrozen(first.bundle) && Object.isFrozen(first.bundle.files));
    for (const entry of first.bundle.files) {
      assert.equal(entry.hash, sha(Buffer.from(entry.text)));
      assert.equal(entry.bytes, Buffer.byteLength(entry.text));
      assert(Object.isFrozen(entry));
    }
    assert.equal(
      capture([{ kind: 'source-file', path: 'literal*[x].ts' }]).bundle.files[0].text,
      'literal path\n',
    );
    assert.equal(
      capture([{ kind: 'source-file', path: 'bom.txt' }]).bundle.files[0].text,
      '\uFEFFsource with BOM\n',
    );
    writeFileSync(join(root, 'logs/build.log'), 'later log bytes\n');
    assert.equal(first.bundle.files[0].text, 'explicit selected log\r\n');
    assert.notEqual(capture([{ kind: 'log-file', path: 'logs/build.log' }]).hash, first.hash);
    symlinkSync('build.log', join(root, 'logs/link.log'));
    symlinkSync('logs', join(root, 'log-parent'));
    linkSync(join(root, 'logs/build.log'), join(root, 'logs/hard.log'));
    for (const selection of [
      { kind: 'source-file', path: '../outside' },
      { kind: 'source-file', path: '/etc/passwd' },
      { kind: 'source-file', path: '.env' },
      { kind: 'source-file', path: 'source-link' },
      { kind: 'source-file', path: 'binary.bin' },
      { kind: 'source-file', path: 'large.txt' },
      { kind: 'source-file', path: 'missing' },
      { kind: 'source-file', path: 'src' },
      { kind: 'source-folder', path: 'src/a.ts' },
      { kind: 'source-folder', path: 'many' },
      { kind: 'log-file', path: 'logs/link.log' },
      { kind: 'log-file', path: 'log-parent/build.log' },
      { kind: 'log-file', path: 'logs/hard.log' },
      { kind: 'log-file', path: '.git/config' },
      { kind: 'log-file', path: 'logs' },
      { kind: 'source-file', path: `${'a/'.repeat(16)}b` },
    ] as const)
      assert.throws(() => capture([selection]), selection.path);
    assert.throws(() =>
      capture(
        Array.from({ length: 5 }, () => ({ kind: 'source-file' as const, path: 'src/a.ts' })),
      ),
    );
    assert.throws(() =>
      capture([
        { kind: 'source-file', path: 'src/a.ts' },
        { kind: 'source-file', path: 'src/a.ts' },
      ]),
    );
    assert.throws(() =>
      capture([
        { kind: 'source-file', path: 'src/a.ts' },
        { kind: 'log-file', path: 'src/a.ts' },
      ]),
    );
    // Escaping every byte makes the complete JSON exceed the bound even though each file fits.
    assert.throws(() =>
      capture([
        { kind: 'source-file', path: 'escaped.txt' },
        { kind: 'source-file', path: 'escaped2.txt' },
      ]),
    );
    assert.equal(readFileSync(join(root, 'src/a.ts'), 'utf8'), 'dirty source stays private\n');
    assert.equal(sha(readFileSync(join(root, '.git/index'))), indexBefore);
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'DO_NOT_READ_CONTEXT_SECRET=canary\n');
    assert.equal(git(root, ['rev-parse', 'HEAD']).toString().trim(), base);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
