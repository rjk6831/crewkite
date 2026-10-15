import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron, expect, type Locator, test } from '@playwright/test';
import { git } from '../apps/controller/src/host/source.ts';
import { groupAbsent } from '../apps/controller/src/host/worker.ts';
import {
  type ControllerClient,
  connectController,
  readControllerEndpoint,
} from '../packages/client/src/node.ts';
import { type Event, EventSchema, SnapshotSchema } from '../packages/contracts/src/index.ts';

const root = resolve(import.meta.dirname, '..');
const internal = existsSync(join(root, 'internal/tools'))
  ? dirname(realpathSync(join(root, 'internal/tools')))
  : join(root, 'internal');
const node = process.execPath;
const require = createRequire(join(root, 'apps/desktop/package.json'));
const environment = (home: string) => ({
  PATH: process.env.PATH ?? '',
  LANG: 'en_US.UTF-8',
  CREWKITE_HOME: home,
  CREWKITE_FIXTURE_IDENTITY: '1',
});
function bounded<T>(pending: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded its deadline.`)), milliseconds);
  });
  return Promise.race([pending, deadline]).finally(() => clearTimeout(timer));
}
function launchController(home: string) {
  const child = spawn(node, [join(root, 'scripts/demo-controller.ts')], {
    cwd: root,
    env: environment(home),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise<void>((ready, reject) => {
    let output = '';
    let errors = '';
    child.stdout?.on('data', (bytes: Buffer) => {
      output = (output + bytes.toString('utf8')).slice(0, 4096);
      if (output.split('\n').includes('CREWKITE_CONTROLLER_READY')) ready();
    });
    child.stderr?.on('data', (bytes: Buffer) => {
      errors = (errors + bytes.toString()).slice(0, 4096);
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`Controller exited before readiness: ${code}. ${errors}`)),
    );
  });
  return { child, ready: bounded(ready, 15000, 'Controller readiness') };
}
async function stop(child: ChildProcess | undefined, signal: NodeJS.Signals = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((done) => child.once('exit', () => done()));
  child.kill(signal);
  try {
    await bounded(closed, 5000, 'Owned child exit');
  } catch {
    child.kill('SIGKILL');
    await bounded(closed, 2000, 'Owned child forced exit');
  }
}
async function closeDesktop(application: Awaited<ReturnType<typeof _electron.launch>>) {
  try {
    await bounded(application.close(), 10000, 'Desktop close');
  } catch (error) {
    await stop(application.process());
    throw error;
  }
}
class Timeline {
  rows: Event[] = [];
  private listeners = new Set<() => void>();
  append(value: Event) {
    this.rows.push(EventSchema.parse(value));
    for (const listener of this.listeners) listener();
  }
  wait(predicate: (event: Event) => boolean, after = 0): Promise<Event> {
    const found = this.rows.slice(after).find(predicate);
    if (found) return Promise.resolve(found);
    let listener: () => void;
    const pending = new Promise<Event>((done) => {
      listener = () => {
        const event = this.rows.slice(after).find(predicate);
        if (event) done(event);
      };
      this.listeners.add(listener);
    });
    return bounded(pending, 20000, 'Expected controller event').finally(() =>
      this.listeners.delete(listener),
    );
  }
}
function sourceIdentity(source: string) {
  return {
    status: git(source, ['status', '--porcelain=v1', '-z']),
    index: readFileSync(join(source, '.git/index')),
    files: [
      ...new Set(
        git(source, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
          .toString('utf8')
          .split('\0')
          .filter(Boolean),
      ),
    ]
      .sort()
      .map((path) => ({
        path,
        mode: lstatSync(join(source, path)).mode & 0o777,
        hash: createHash('sha256')
          .update(readFileSync(join(source, path)))
          .digest('hex'),
      })),
  };
}
function cli(home: string, ...args: string[]) {
  return JSON.parse(
    execFileSync(node, [join(root, 'apps/cli/src/main.ts'), ...args, '--json', '--home', home], {
      cwd: root,
      env: environment(home),
      maxBuffer: 1048576,
      timeout: 10000,
      encoding: 'utf8',
    }),
  );
}
async function groupExited(group: number) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (groupAbsent(group)) return;
    await new Promise<void>((done) => setImmediate(done));
  }
  throw new Error('The retained worker group lacks absence proof. Recovery stays unqualified.');
}

async function cleanupGroup(group: number) {
  try {
    process.kill(-group, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  await groupExited(group);
}

async function enter(button: Locator) {
  await expect(button).toBeEnabled();
  await button.press('Enter');
}

test('desktop and CLI retain one checked task through handoff and restart', async () => {
  test.setTimeout(120000);
  mkdirSync(internal, { recursive: true });
  const home = mkdtempSync(join(internal, 'journey-'));
  const profile = join(home, 'profile');
  const destination = join(home, 'candidate.patch');
  const timeline = new Timeline();
  const watchEvents = new Timeline();
  let controller: ChildProcess | undefined;
  let observer: ControllerClient | undefined;
  let watcher: ChildProcess | undefined;
  let retainedGroup: number | undefined;
  let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    const initial = launchController(home);
    controller = initial.child;
    await initial.ready;
    const source = join(home, 'demo-shop');
    const original = sourceIdentity(source);
    observer = await connectController({
      ...readControllerEndpoint(home),
      actor: { id: 'journey-observer', kind: 'cli' },
    });
    await observer.subscribe('0', (event) => timeline.append(event));
    application = await _electron.launch({
      executablePath: require('electron'),
      args: [join(root, 'apps/desktop')],
      env: {
        ...environment(home),
        ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
        ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
        CREWKITE_PROFILE: profile,
        CREWKITE_SOURCE_NODE: node,
        CREWKITE_SOURCE_NODE_HASH: createHash('sha256').update(readFileSync(node)).digest('hex'),
      },
      timeout: 15000,
    });
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByText('Controller connected', { exact: true })).toBeVisible();
    await expect(page.getByText('demo-shop', { exact: true }).first()).toBeVisible();
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, destination);
    await enter(page.getByRole('button', { name: 'New task', exact: true }).first());
    await enter(page.getByRole('dialog').getByRole('button', { name: 'Create task', exact: true }));
    const created = await timeline.wait((event) => event.type === 'task.created');
    assert.equal(created.type, 'task.created');
    const taskId = created.payload.id;
    const dialog = page.getByRole('dialog');
    await expect(
      page.getByRole('dialog', { name: 'Configure this run', exact: true }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Formation', exact: false }).click();
    await dialog.getByRole('tab', { name: 'Policy', exact: true }).click();
    await dialog.getByLabel('Attempts', { exact: true }).fill('6');
    await dialog.getByLabel(/write-scratch .* approval gate/).selectOption('once');
    await dialog
      .getByLabel(/run-review .* approval gate/)
      .first()
      .selectOption('ask');
    await dialog
      .getByLabel(/run-review .* approval gate/)
      .last()
      .selectOption('once');
    await enter(dialog.getByRole('button', { name: 'Resolve and review', exact: true }));
    await expect(
      page.getByRole('dialog', { name: 'Review the prepared run', exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText('Anthropic fixture', { exact: true }).first()).toBeVisible();
    await expect(dialog.getByText(/untracked/i).first()).toBeVisible();
    await enter(dialog.getByRole('button', { name: 'Start run', exact: true }));
    const firstApproval = await timeline.wait((event) => event.type === 'approval.requested');
    assert.equal(firstApproval.type, 'approval.requested');
    await expect(page.getByRole('region', { name: 'Pending approval' })).toContainText(
      firstApproval.payload.target,
    );
    const list = cli(home, 'task', 'list');
    const shown = cli(home, 'task', 'show', taskId);
    assert.equal(list.tasks[0].id, taskId);
    assert.equal(shown.task.id, taskId);
    assert.equal(shown.task.revision, list.tasks[0].revision);
    watcher = spawn(
      node,
      [join(root, 'apps/cli/src/main.ts'), 'task', 'watch', taskId, '--json', '--home', home],
      { cwd: root, env: environment(home), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let watchText = '';
    let watchBuffer = '';
    const watchReady = new Promise<void>((done) =>
      watcher?.stdout?.on('data', (bytes: Buffer) => {
        watchText = (watchText + bytes.toString()).slice(-1048576);
        watchBuffer += bytes.toString();
        while (watchBuffer.includes('\n')) {
          const end = watchBuffer.indexOf('\n');
          const parsed = EventSchema.safeParse(JSON.parse(watchBuffer.slice(0, end)));
          watchBuffer = watchBuffer.slice(end + 1);
          if (parsed.success) watchEvents.append(parsed.data);
        }
        if (watchText.includes('"type":"snapshot"')) done();
      }),
    );
    watcher.stderr?.on('data', () => {});
    await bounded(watchReady, 10000, 'CLI watch readiness');
    await enter(page.getByRole('button', { name: 'Approve once', exact: true }));
    const seal = await timeline.wait((event) => event.type === 'handoff.sealed');
    assert.equal(seal.type, 'handoff.sealed');
    assert.equal(seal.payload.packet.taskId, taskId);
    const watchedSeal = await watchEvents.wait((event) => event.id === seal.id);
    assert.equal(watchedSeal.taskId, taskId);
    assert.equal(seal.payload.packet.criteria.length, 4);
    const retained = await timeline.wait(
      (event) =>
        event.type === 'attempt.output' &&
        event.payload.generation === 1 &&
        event.payload.text.includes('Retained net.mjs'),
    );
    assert.equal(retained.type, 'attempt.output');
    const hostile = page
      .locator('.worker-output')
      .filter({ hasText: '<script>provider content stays inert</script>' })
      .first();
    await expect(hostile).toContainText(
      'Retained net.mjs edits. <script>provider content stays inert</script>',
    );
    await expect(hostile.locator('script')).toHaveCount(0);
    const roster = page.getByRole('complementary', { name: 'Team roster', exact: true });
    await expect(roster.locator('.role-card')).toContainText([
      /Builder.*Running.*OpenAI/s,
      /Reviewer.*Idle.*OpenAI/s,
    ]);
    const panel = page.getByRole('tabpanel');
    const scrolled = await panel.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    assert(scrolled > 0, 'The task panel must have real overflowing activity to scroll.');
    const stopButton = page.getByRole('button', { name: 'Stop', exact: true });
    await expect(stopButton).toBeInViewport();
    await expect(stopButton).toBeEnabled();
    await expect(
      page.getByRole('heading', {
        name: 'Add netMinor(subtotalMinor, discountMinor)',
        exact: true,
      }),
    ).toBeInViewport();
    await panel.evaluate((element) => {
      element.scrollTop = 0;
    });
    const current = await observer.snapshot();
    const currentRun = current.runs.find((run) => run.taskId === taskId);
    assert(currentRun?.decision.chosen);
    const switchControl = page.getByLabel('Saved coder route');
    await switchControl.selectOption(currentRun.decision.chosen);
    await expect(page.getByRole('button', { name: 'Switch route', exact: true })).toBeDisabled();
    await page.getByRole('tab', { name: /^Handoffs/ }).click();
    await page.getByRole('button', { name: 'Inspect packet', exact: true }).first().click();
    await expect(
      page.getByText(seal.payload.checksum.slice(0, 8), { exact: false }).first(),
    ).toBeVisible();
    const db = new DatabaseSync(join(home, 'state.sqlite'), { readOnly: true });
    const owned = db
      .prepare(
        "SELECT process_group FROM launch_intents WHERE attempt_id=? AND task_id=? AND run_id=? AND generation=1 AND scratch_path=? AND state='acknowledged' AND finished_at IS NULL",
      )
      .all(retained.payload.attemptId, taskId, currentRun.id, join(home, 'scratch', currentRun.id));
    db.close();
    assert.equal(owned.length, 1);
    const group = owned[0].process_group;
    assert(typeof group === 'number' && Number.isSafeInteger(group) && group > 0);
    retainedGroup = group;
    await page.screenshot({ path: join(internal, 'connected-checkpoint-dark.png') });
    observer.close();
    observer = undefined;
    await stop(controller, 'SIGKILL');
    await groupExited(group);
    retainedGroup = undefined;
    const restarted = launchController(home);
    controller = restarted.child;
    await restarted.ready;
    observer = await connectController({
      ...readControllerEndpoint(home),
      actor: { id: 'journey-observer', kind: 'cli' },
    });
    const recovered = SnapshotSchema.parse(await observer.snapshot());
    assert.equal(recovered.tasks[0].state, 'interrupted');
    const launches = recovered.attempts.length;
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    assert.equal(cli(home, 'task', 'show', taskId).task.state, 'interrupted');
    assert.equal((await observer.snapshot()).attempts.length, launches);
    const resumed = new Timeline();
    await observer.subscribe(recovered.cursor, (event) => resumed.append(event));
    await enter(page.getByRole('button', { name: 'Resume', exact: true }));
    let from = 0;
    let cliChangedState = false;
    for (;;) {
      const next = await resumed.wait(
        (event) =>
          event.type === 'approval.requested' ||
          (event.type === 'task.updated' &&
            ['ready', 'failed', 'unknown'].includes(event.payload.state)),
        from,
      );
      from = resumed.rows.indexOf(next) + 1;
      if (next.type === 'task.updated') {
        assert.equal(next.payload.state, 'ready');
        break;
      }
      await page.getByRole('tab', { name: 'Activity', exact: true }).click();
      if (
        next.type === 'approval.requested' &&
        next.payload.action === 'run-review' &&
        !cliChangedState
      ) {
        await expect(page.getByRole('region', { name: 'Pending approval' })).toContainText(
          next.payload.target,
        );
        const approved = cli(home, 'task', 'approve', next.payload.approvalId);
        assert.equal(approved.result.outcome, 'applied');
        cliChangedState = true;
      } else await enter(page.getByRole('button', { name: 'Approve once', exact: true }));
    }
    await page.getByRole('tab', { name: 'Changes', exact: true }).click();
    await expect(page.getByText('net.mjs', { exact: true }).first()).toBeVisible();
    await page.getByRole('tab', { name: 'Checks and review', exact: true }).click();
    await expect(page.getByText('SCRIPTED · passed', { exact: true }).first()).toBeVisible();
    assert(cliChangedState, 'A CLI approval must produce the review result observed in the GUI.');
    const final = await observer.snapshot();
    assert.equal(final.evidence.filter((evidence) => evidence.passed).length, 3);
    await enter(page.getByRole('button', { name: 'Accept candidate', exact: true }));
    await page.getByRole('tab', { name: 'Activity', exact: true }).click();
    await enter(page.getByRole('button', { name: 'Approve once', exact: true }));
    await resumed.wait((event) => event.type === 'candidate.accepted');
    assert.match(
      git(source, ['rev-parse', '--verify', 'refs/heads/feat/net-minor']).toString('utf8').trim(),
      /^[a-f0-9]{40}$/,
    );
    assert.deepEqual(sourceIdentity(source), original);
    await page.getByRole('tab', { name: 'Checks and review', exact: true }).click();
    await enter(page.getByRole('button', { name: 'Export patch', exact: true }));
    await page.getByRole('tab', { name: 'Activity', exact: true }).click();
    await enter(page.getByRole('button', { name: 'Approve once', exact: true }));
    const exported = await resumed.wait((event) => event.type === 'export.created');
    assert.equal(exported.type, 'export.created');
    await watchEvents.wait((event) => event.id === exported.id);
    await expect(page.getByText(/Patch saved/).first()).toBeVisible();
    assert.equal(
      createHash('sha256').update(readFileSync(destination)).digest('hex'),
      exported.payload.hash,
    );
    await enter(page.getByRole('button', { name: 'Switch to light theme', exact: true }));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.screenshot({ path: join(internal, 'connected-checkpoint-light.png') });
    assert(watchText.includes(taskId));
    console.log(`Connected journey home: ${home}`);
  } finally {
    observer?.close();
    const groups = new Set<number>(retainedGroup === undefined ? [] : [retainedGroup]);
    const discoveryFailures: unknown[] = [];
    try {
      if (existsSync(join(home, 'state.sqlite'))) {
        const db = new DatabaseSync(join(home, 'state.sqlite'), { readOnly: true });
        try {
          for (const row of db
            .prepare('SELECT process_group FROM launch_intents WHERE finished_at IS NULL')
            .all()) {
            const group = row.process_group;
            if (typeof group === 'number' && Number.isSafeInteger(group) && group > 0)
              groups.add(group);
          }
        } finally {
          db.close();
        }
      }
    } catch (error) {
      discoveryFailures.push(error);
    }
    const children = await Promise.allSettled([
      stop(watcher),
      application ? closeDesktop(application) : Promise.resolve(),
      stop(controller),
    ]);
    const workers = await Promise.allSettled([...groups].map(cleanupGroup));
    const failures = [...children, ...workers]
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason)
      .concat(discoveryFailures);
    assert.equal(failures.length, 0, `Owned process cleanup failed: ${failures.join('; ')}`);
  }
});
