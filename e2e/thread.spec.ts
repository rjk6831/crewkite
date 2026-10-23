import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { _electron, expect as base, test } from '@playwright/test';
import {
  checkEnvironment,
  checkOwner,
  enrollCheckRoot,
  spawnCheckChild as spawn,
} from '../apps/controller/src/host/check-ownership.ts';
import { git } from '../apps/controller/src/host/source.ts';
import type { ChatScriptStep } from '../packages/testkit/src/chat-adapter.ts';

// The controller runs the demo fixtures with a scripted chat provider, so no provider client
// starts. One turn: stream a plan, read a file, ask before editing, edit it, report.
const expect = base.configure({ timeout: 15000 });
const root = resolve(import.meta.dirname, '..');
const internal =
  checkOwner()?.stateRoot ??
  (existsSync(join(root, 'internal/tools'))
    ? dirname(realpathSync(join(root, 'internal/tools')))
    : join(root, 'internal'));
const node = process.execPath;
const edit = {
  path: 'net.mjs',
  content: 'export function netMinor(a, b) {\n  return Math.max(0, a - b);\n}\n',
};
const script: ChatScriptStep[] = [
  { kind: 'text', itemId: 'plan', chunks: ['I will read net.mjs ', 'and then edit it.'] },
  { kind: 'tool', callId: 'read', toolKind: 'read', title: 'Read net.mjs' },
  { kind: 'permission', requestId: 'allow-edit', question: 'Edit net.mjs?' },
  { kind: 'tool', callId: 'edit', toolKind: 'edit', title: 'Edit net.mjs', write: edit },
  { kind: 'text', itemId: 'done', chunks: ['netMinor now ', 'clamps at zero.'] },
];

// The test timeout bounds a controller that never reports ready.
function ready(child: ChildProcess) {
  let output = '';
  return new Promise<void>((done, fail) => {
    const read = (bytes: Buffer) => {
      output = (output + bytes.toString('utf8')).slice(-4096);
      if (output.split('\n').includes('CREWKITE_CONTROLLER_READY')) done();
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.once('exit', (code) => fail(new Error(`The controller exited (${code}). ${output}`)));
  });
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((done) => child.once('exit', done));
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.kill('SIGTERM');
  await closed;
  clearTimeout(force);
}

test('a new thread streams a reply, asks before editing and lists the edited file', async () => {
  test.setTimeout(90000);
  mkdirSync(internal, { recursive: true });
  const home = mkdtempSync(join(internal, 'thread-'));
  if (Buffer.byteLength(join(home, 'control.sock')) > 100)
    throw Error('The journey home is too long for a control socket.');
  const environment = {
    ...checkEnvironment(),
    PATH: process.env.PATH ?? '',
    LANG: 'en_US.UTF-8',
    HOME: home,
    CREWKITE_HOME: home,
    CREWKITE_FIXTURE_IDENTITY: '1',
  };
  const controller = spawn(node, [join(root, 'scripts/demo-controller.ts')], {
    cwd: root,
    env: { ...environment, CREWKITE_DEMO_CHAT_SCRIPT: JSON.stringify(script) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    await ready(controller);
    const source = join(home, 'demo-shop');
    const checkoutBefore = git(source, ['status', '--porcelain=v1', '-z']).toString();
    const electronRoot = enrollCheckRoot('electron', true);
    application = await _electron.launch({
      executablePath:
        checkOwner()?.electronExecutable ??
        createRequire(join(root, 'apps/desktop/package.json'))('electron'),
      chromiumSandbox: true,
      args: [join(root, 'apps/desktop')],
      env: {
        ...environment,
        ...electronRoot.environment,
        ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
        ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
        CREWKITE_PROFILE: join(home, 'profile'),
        CREWKITE_SOURCE_NODE: node,
        CREWKITE_SOURCE_NODE_HASH: createHash('sha256').update(readFileSync(node)).digest('hex'),
      },
      timeout: 15000,
    });
    const child = application.process();
    assert(child);
    electronRoot.acknowledge(child);
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByText('Controller connected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New thread', exact: true }).click();
    await page
      .getByPlaceholder('Ask about this project or describe a change')
      .fill('Implement netMinor in net.mjs');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    const thread = page.getByRole('region', { name: 'Thread', exact: true });
    const seen = (text: string) => expect(thread.getByText(text)).toBeVisible();
    await expect(
      thread.getByRole('heading', { name: 'Implement netMinor in net.mjs' }),
    ).toBeVisible();
    await seen('I will read net.mjs and then edit it.');
    await expect(thread.getByRole('button', { name: /Read net\.mjs/ })).toBeVisible();
    const permission = thread.getByRole('region', { name: 'Permission request' });
    await expect(permission.getByText('Edit net.mjs?')).toBeVisible();
    await permission.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(permission.getByRole('button')).toHaveCount(0);
    await expect(permission.getByText('Allow once', { exact: true })).toBeVisible();
    await expect(thread.getByRole('button', { name: /Edit net\.mjs/ })).toBeVisible();
    await seen('netMinor now clamps at zero.');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Toggle inspector', exact: true }).click();
    const inspector = page.getByRole('complementary', { name: 'Inspector', exact: true });
    await expect(inspector.getByRole('tab', { name: 'Changes' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const files = inspector.getByRole('tabpanel').getByRole('listitem');
    await expect(files).toHaveCount(1);
    await expect(files.first()).toContainText('net.mjs');
    // The edit lives in the scratch copy. The person's checkout stays as it was.
    assert.equal(git(source, ['status', '--porcelain=v1', '-z']).toString(), checkoutBefore);
  } finally {
    await application?.close();
    await stop(controller);
  }
});
