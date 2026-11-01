import assert from 'node:assert/strict';
import { test } from 'node:test';
import { permissionDetail } from './permission-detail.ts';

const scratch = '/work/scratch/tsk_1';

test('a command request shows the command line and its folder inside the scratch copy', () => {
  const raw = {
    CommandLine: 'rg -n "netMinor" src',
    Cwd: `${scratch}/src`,
    NotificationTimeoutSeconds: 10,
    WaitMsBeforeAsync: 500,
  };
  assert.equal(permissionDetail(raw, new Set(), scratch), 'rg -n "netMinor" src\nFolder: src');
  assert.equal(
    permissionDetail({ CommandLine: 'ls', Cwd: scratch }, new Set(), scratch),
    'ls\nFolder: scratch copy',
  );
  assert.equal(permissionDetail({ command: ['git', 'status'] }, new Set(), scratch), 'git status');
});

test('a command outside the scratch copy names its folder as given', () => {
  assert.equal(
    permissionDetail({ CommandLine: 'ls', Cwd: '/etc' }, new Set(), scratch),
    'ls\nFolder: /etc',
  );
});

test('any other request keeps its paths and input', () => {
  assert.equal(
    permissionDetail({ AbsolutePath: 'x' }, new Set(['src/a.ts']), scratch),
    'Paths: src/a.ts\n{"AbsolutePath":"x"}',
  );
  assert.equal(permissionDetail(undefined, new Set(), scratch), null);
});
