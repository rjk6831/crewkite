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
  createCommandKey,
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
  ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
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
function launchController(home: string, nativeFixture = false) {
  const bootstrap = `
    import {spawn} from 'node:child_process';
    import {createHash} from 'node:crypto';
    import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {startController} from ${JSON.stringify(join(root, 'apps/controller/src/main.ts'))};
    import {unavailableNativeProfile} from ${JSON.stringify(join(root, 'apps/controller/src/providers/openai/profile.ts'))};
    import {AnthropicNativeProfileSchema} from ${JSON.stringify(join(root, 'packages/contracts/src/index.ts'))};
    import {replacementFixture as anthropicFixture} from ${JSON.stringify(join(root, 'apps/controller/src/providers/anthropic/replacement-fixture.ts'))};
    import {fixture, fixtureContent, fixtureModel} from ${JSON.stringify(join(root, 'apps/controller/src/providers/openai/replacement-fixture.ts'))};
    import {writeChallengeSolution} from ${JSON.stringify(join(root, 'packages/testkit/src/repository.ts'))};
    let phases=0;
    const proposal=join(process.env.CREWKITE_HOME,'native-fixture-proposal');
    mkdirSync(proposal,{recursive:true});
    writeFileSync(join(proposal,'net.mjs'),'');
    writeChallengeSolution(proposal);
    const replacement='const edit = {version:1,attemptId:message.params.outputSchema.properties.attemptId.const,path,baseHash:message.params.outputSchema.properties.baseHash.const,content:content(path)};';
    const transcript=fixture
      .replace('const content = '+fixtureContent.toString()+';','const content = () => '+JSON.stringify(readFileSync(join(proposal,'net.mjs'),'utf8'))+';')
      .replace('const path = message.params.outputSchema.properties.path.const;','const path = message.params.outputSchema.properties.path?.const;')
      .replace(replacement,'const edit = message.params.outputSchema.properties.bindingHash ? {version:1,bindingHash:message.params.outputSchema.properties.bindingHash.const,methodId:message.params.outputSchema.properties.methodId.const,cycle:1,outcome:"passed",findings:[],summary:"The bounded review completed."} : '+replacement.slice('const edit = '.length));
    const profile={...unavailableNativeProfile(),facts:{...unavailableNativeProfile().facts,displayName:'OpenAI scripted proposal fixture',model:fixtureModel,clientVersion:process.version,available:true,reason:'available'},client:{executable:process.execPath,sha256:createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),version:process.version},environment:{...process.env},locationHash:'1'.repeat(64)};
    const anthropicProfile={...profile,facts:AnthropicNativeProfileSchema.parse({...profile.facts,id:'anthropic-file-v1',family:'anthropic',displayName:'Anthropic scripted proposal fixture',effort:'medium',effectiveEffort:'unknown',accountClass:'unknown',serviceTier:'unknown',billingBasis:'requires-user-attestation',qualifiedAt:null,creditPolicies:['ordinary'],reason:'qualification-pending'}),locationHash:'2'.repeat(64)};
    const runtime=await startController({home:process.env.CREWKITE_HOME,identity:{name:'CrewKite fixture',email:'fixture@example.invalid'},nativeProfiles:()=>[profile,anthropicProfile],nativeSpawn:(executable,args,options)=>args[0]==='auth'||args.includes('--print')?spawn(executable,['-e',anthropicFixture(args,{content:readFileSync(join(proposal,'net.mjs'),'utf8')})],options):spawn(executable,['-e',transcript,'success',args.at(-1)==='list'?'features':++phases%2===1?'prepare':'task'],options)});
    console.log('CREWKITE_CONTROLLER_READY');
    process.once('SIGTERM',()=>void runtime.close().then(()=>process.exit(0)));
  `;
  const child = spawn(
    node,
    nativeFixture
      ? ['--input-type=module', '--eval', bootstrap]
      : [join(root, 'scripts/demo-controller.ts')],
    {
      cwd: root,
      env: environment(home),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
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
type DesktopProcess = { child: ChildProcess; closed: Promise<void>; closeObserved: boolean };
async function closeDesktop(
  application: Awaited<ReturnType<typeof _electron.launch>>,
  owned: DesktopProcess | undefined,
) {
  assert(owned, 'Desktop ownership was not captured.');
  let request: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  // Normal application close also disconnects the main-process inspector.
  const requested = application.close().then(
    () => {
      request = 'fulfilled';
    },
    (error: unknown) => {
      request = 'rejected';
      throw error;
    },
  );
  const facts = () =>
    `request=${request}, pid=${owned.child.pid}, exit=${owned.child.exitCode}, signal=${owned.child.signalCode}, close=${owned.closeObserved}, killed=${owned.child.killed}, stdoutEnded=${owned.child.stdout?.readableEnded}, stdoutDestroyed=${owned.child.stdout?.destroyed}, stderrEnded=${owned.child.stderr?.readableEnded}, stderrDestroyed=${owned.child.stderr?.destroyed}`;
  try {
    await bounded(Promise.all([requested, owned.closed]), 10000, 'Desktop close');
    assert.equal(owned.child.exitCode, 0, 'Desktop exit code');
    assert.equal(owned.child.signalCode, null, 'Desktop exit signal');
  } catch (error) {
    const before = facts();
    await stop(owned.child);
    throw new Error(`Desktop graceful close failed (${before}; after cleanup ${facts()}).`, {
      cause: error,
    });
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
  let desktop: DesktopProcess | undefined;
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
      chromiumSandbox: true,
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
    const child = application.process();
    assert(child);
    const closed = Promise.withResolvers<void>();
    desktop = { child, closed: closed.promise, closeObserved: false };
    child.once('close', () => {
      if (desktop) desktop.closeObserved = true;
      closed.resolve();
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
    await expect(dialog.getByText(/Minimum 4 attempts · Configured 6\./)).toBeVisible();
    await dialog.getByRole('tab', { name: 'Methods', exact: true }).click();
    const secondOpinion = dialog.locator('.method-card').filter({
      has: page.getByText('Second opinion', { exact: true }),
    });
    await secondOpinion.getByLabel(/^Round cap/).selectOption('2');
    await expect(dialog.getByText(/Minimum 5 attempts · Configured 6\./)).toBeVisible();
    await expect(dialog.getByText('Custom review settings', { exact: false })).toBeVisible();
    await secondOpinion.getByLabel(/^Round cap/).selectOption('1');
    await expect(dialog.getByText(/Minimum 4 attempts · Configured 6\./)).toBeVisible();
    await dialog.getByRole('tab', { name: 'Policy', exact: true }).click();
    await dialog.getByLabel('Attempts', { exact: true }).fill('6');
    await dialog
      .getByLabel('Write the scratch copy: demo-shop workspace approval gate', { exact: true })
      .selectOption('once');
    await dialog
      .getByLabel('Run a review: Second opinion · round 1 approval gate', { exact: true })
      .selectOption('ask');
    await dialog
      .getByLabel('Run a review: Keep it simple · round 1 approval gate', { exact: true })
      .selectOption('once');
    await enter(dialog.getByRole('button', { name: 'Resolve and review', exact: true }));
    await expect(
      page.getByRole('dialog', { name: 'Review the prepared run', exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText('Anthropic fixture', { exact: true }).first()).toBeVisible();
    await expect(dialog.getByText(/untracked/i).first()).toBeVisible();
    const previewSnapshot = await observer.snapshot();
    const preview = previewSnapshot.runs.find(
      ({ id }) => id === previewSnapshot.tasks.find(({ id }) => id === taskId)?.runId,
    );
    assert(preview);
    assert.deepEqual(
      preview.policy.policy.methods?.map(({ id }) => id),
      ['keep-it-simple', 'second-opinion'],
    );
    await enter(dialog.getByRole('button', { name: 'Edit configuration', exact: true }));
    await expect(
      dialog.getByLabel('Write the scratch copy: demo-shop workspace approval gate', {
        exact: true,
      }),
    ).toHaveValue('ask');
    await expect(
      dialog.getByLabel('Run a review: Keep it simple · round 1 approval gate', { exact: true }),
    ).toHaveValue('ask');
    await expect(
      dialog.getByLabel('Run a review: Second opinion · round 1 approval gate', { exact: true }),
    ).toHaveValue('ask');
    await dialog.getByLabel(/^Unknown usage/).selectOption('fixed-allowance');
    await expect(
      dialog.getByRole('button', { name: 'Resolve and review', exact: true }),
    ).toBeDisabled();
    await expect(dialog.getByText(/current 30-minute plan cannot start/)).toBeVisible();
    await dialog.getByLabel(/^Unknown usage/).selectOption('waiting');
    await dialog
      .getByLabel('Write the scratch copy: demo-shop workspace approval gate', { exact: true })
      .selectOption('once');
    await dialog
      .getByLabel('Run a review: Keep it simple · round 1 approval gate', { exact: true })
      .selectOption('once');
    await enter(dialog.getByRole('button', { name: 'Resolve and review', exact: true }));
    await expect(
      page.getByRole('dialog', { name: 'Review the prepared run', exact: true }),
    ).toBeVisible();
    await dialog.locator('.checkout-changes > summary').click();
    await expect(dialog.getByText('sentinels/staged.txt', { exact: true })).toBeVisible();

    await enter(dialog.getByRole('button', { name: 'Start run', exact: true }));
    const firstApproval = await timeline.wait((event) => event.type === 'approval.requested');
    assert.equal(firstApproval.type, 'approval.requested');
    assert.equal(firstApproval.payload.action, 'run-check');
    await expect(page.getByRole('region', { name: 'Pending approval' })).toContainText(
      'Run candidate checks',
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
    const currentRun = current.runs.find(
      (run) => run.id === current.tasks.find((task) => task.id === taskId)?.runId,
    );
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
        assert.equal(next.payload.target, 'second-opinion/cycle-1');
        await expect(page.getByRole('region', { name: 'Pending approval' })).toContainText(
          'Second opinion · round 1',
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
    await stop(watcher);
    watcher = undefined;
    observer.close();
    observer = undefined;
    await stop(controller);
    const nativeController = launchController(home, true);
    controller = nativeController.child;
    await nativeController.ready;
    observer = await connectController({
      ...readControllerEndpoint(home),
      actor: { id: 'native-journey-observer', kind: 'cli' },
    });
    const nativeEvents = new Timeline();
    await observer.subscribe('0', (event) => nativeEvents.append(event));
    await enter(page.getByRole('button', { name: 'Reconnect controller', exact: true }));
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.crewkite?.getSnapshot()))?.nativeProfiles[0]
            ?.displayName,
      )
      .toBe('OpenAI scripted proposal fixture');
    await enter(page.getByRole('button', { name: 'New task', exact: true }).first());
    await page.getByLabel('Task title', { exact: true }).fill('Retain one native file proposal');
    await enter(page.getByRole('dialog').getByRole('button', { name: 'Create task', exact: true }));
    await enter(
      page.getByRole('dialog').getByRole('button', { name: 'Native file proposal', exact: true }),
    );
    const nativeDialog = page.getByRole('dialog');
    await expect(nativeDialog.getByText('Requires Pro', { exact: true })).toBeVisible();
    await nativeDialog.getByLabel('Committed file path', { exact: true }).fill('net.mjs');
    const credits = nativeDialog.getByLabel('Allow existing credits after included usage', {
      exact: true,
    });
    await expect(credits).not.toBeChecked();
    const trust = nativeDialog.getByLabel('Trust the existing native client and login', {
      exact: true,
    });
    const consent = nativeDialog.getByLabel(
      'Send this committed file and task text; allow its replacement in independent scratch',
      { exact: true },
    );
    await trust.check();
    await consent.check();
    await enter(nativeDialog.getByRole('button', { name: 'Prepare native proposal', exact: true }));
    await expect(
      page.getByRole('dialog', { name: 'Review the native proposal', exact: true }),
    ).toBeVisible();
    await expect(nativeDialog.getByLabel('Prepared native target')).toContainText('net.mjs');
    let nativeSnapshot = await observer.snapshot();
    const nativeTask = nativeSnapshot.tasks.find(
      (task) => task.title === 'Retain one native file proposal',
    );
    assert(nativeTask?.runId);
    assert.equal(
      nativeSnapshot.attempts.filter((attempt) => attempt.runId === nativeTask.runId).length,
      0,
    );
    assert.equal(cli(home, 'task', 'show', nativeTask.id).nativeRun.stage, 'prepared');
    const nativeRun = nativeSnapshot.runs.find((run) => run.id === nativeTask.runId);
    assert(nativeRun);
    const hiddenPolicy = {
      ...nativeRun.policy.policy,
      effects: [
        ...nativeRun.policy.policy.effects,
        {
          taskId: nativeTask.id,
          action: 'accept-candidate' as const,
          target: 'refs/heads/feat/hidden-grant',
          expiresAt: new Date(0).toISOString(),
          revoked: true,
          usesRemaining: 0 as const,
        },
        {
          taskId: nativeTask.id,
          action: 'run-check' as const,
          target: 'node --test',
          expiresAt: new Date(0).toISOString(),
          revoked: true,
          usesRemaining: 0 as const,
        },
      ],
    };
    const fromCli = await observer.command({
      protocol: 1,
      key: createCommandKey(),
      actor: { id: 'native-journey-observer', kind: 'cli' },
      command: 'PrepareNativeRun',
      expectedRevision: nativeSnapshot.tasks.find((task) => task.id === nativeTask.id)
        ?.revision as number,
      payload: {
        taskId: nativeTask.id,
        profileId: nativeSnapshot.nativeProfiles[0].id,
        targetPath: 'net.mjs',
        creditPolicy: 'ordinary',
        policy: hiddenPolicy,
        consent: 'explicit',
      },
    });
    assert.equal(fromCli.outcome, 'applied');
    await enter(nativeDialog.getByRole('button', { name: 'Cancel', exact: true }));
    await enter(
      page.getByRole('button', { name: 'Review prepared proposal', exact: true }).first(),
    );
    await enter(nativeDialog.getByRole('button', { name: 'Edit proposal', exact: true }));
    await expect(trust).not.toBeChecked();
    await expect(consent).not.toBeChecked();
    await expect(credits).not.toBeChecked();
    await expect(
      nativeDialog.getByRole('button', { name: 'Prepare native proposal', exact: true }),
    ).toBeDisabled();
    await trust.check();
    await consent.check();
    await credits.check();
    await nativeDialog
      .getByRole('combobox', { name: 'Writer profile', exact: true })
      .selectOption('anthropic-file-v1');
    await expect(trust).not.toBeChecked();
    await expect(consent).not.toBeChecked();
    await expect(credits).toHaveCount(0);
    await expect(nativeDialog.getByText('Qualification pending', { exact: true })).toBeVisible();
    await expect(nativeDialog.getByText('Effective effort unknown', { exact: true })).toBeVisible();
    await expect(nativeDialog.getByText('Service tier unknown', { exact: true })).toBeVisible();
    const subscription = nativeDialog.getByLabel(
      'I confirm this native login uses my existing subscription',
      { exact: true },
    );
    const extraUsage = nativeDialog.getByLabel(
      'I confirm paid extra usage is disabled for this login',
      { exact: true },
    );
    await expect(subscription).not.toBeChecked();
    await expect(extraUsage).not.toBeChecked();
    await subscription.check();
    await trust.check();
    await consent.check();
    await expect(
      nativeDialog.getByRole('button', { name: 'Prepare native proposal', exact: true }),
    ).toBeDisabled();
    await extraUsage.check();
    await expect(trust).not.toBeChecked();
    await expect(consent).not.toBeChecked();
    await trust.check();
    await consent.check();
    await nativeDialog
      .getByRole('textbox', { name: 'Committed file path', exact: true })
      .fill('net.mjs ');
    await expect(subscription).not.toBeChecked();
    await expect(extraUsage).not.toBeChecked();
    await expect(trust).not.toBeChecked();
    await expect(consent).not.toBeChecked();
    await nativeDialog
      .getByRole('textbox', { name: 'Committed file path', exact: true })
      .fill('net.mjs');
    await subscription.check();
    await extraUsage.check();
    await trust.check();
    await consent.check();
    await page.screenshot({
      path: join(internal, 'anthropic-native-confirmations-light.png'),
      animations: 'disabled',
    });
    await enter(nativeDialog.getByRole('button', { name: 'Prepare native proposal', exact: true }));
    await expect(
      page.getByRole('dialog', { name: 'Review the native proposal', exact: true }),
    ).toBeVisible();
    await expect(nativeDialog.getByLabel('Prepared native target')).toContainText('user-attested');
    const renewed = await observer.snapshot();
    const renewedNative = renewed.nativeRuns.find(
      (value) => value.runId === renewed.tasks.find((task) => task.id === nativeTask.id)?.runId,
    );
    assert.equal(renewedNative?.profileId, 'anthropic-file-v1');
    assert.deepEqual(renewedNative?.billingAttestation, {
      source: 'user-attested',
      subscriptionLoginConfirmed: true,
      paidExtraUsageDisabled: true,
    });
    const renewedRun = renewed.runs.find(
      (run) => run.id === renewed.tasks.find((task) => task.id === nativeTask.id)?.runId,
    );
    assert(renewedRun);
    assert.deepEqual(
      renewedRun.policy.policy.effects.filter((grant) => grant.action !== 'write-scratch'),
      hiddenPolicy.effects.filter((grant) => grant.action !== 'write-scratch'),
    );
    await page.screenshot({
      path: join(internal, 'public-native-prepared-light.png'),
      animations: 'disabled',
    });
    await enter(nativeDialog.getByRole('button', { name: 'Start native proposal', exact: true }));
    await nativeEvents.wait(
      (event) => event.type === 'candidate.sealed' && event.payload.taskId === nativeTask.id,
    );
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Switch route', exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Checks and review', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Accept candidate', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('heading', { name: 'Accept or export', exact: true }),
    ).toBeVisible();
    await enter(page.getByRole('button', { name: 'Dismiss export notice', exact: true }));
    const nativeDestination = join(home, 'native.patch');
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, nativeDestination);
    await enter(page.getByRole('button', { name: 'Export patch', exact: true }));
    const nativeExport = await nativeEvents.wait(
      (event) => event.type === 'export.created' && event.taskId === nativeTask.id,
    );
    assert.equal(nativeExport.type, 'export.created');
    await expect(page.getByText(/Patch saved/).first()).toBeVisible();
    assert.equal(
      createHash('sha256').update(readFileSync(nativeDestination)).digest('hex'),
      nativeExport.payload.hash,
    );
    assert.deepEqual(
      cli(home, 'task', 'changes', nativeTask.id).data.files.map(
        (file: { path: string }) => file.path,
      ),
      ['net.mjs'],
    );
    assert.deepEqual(sourceIdentity(source), original);
    await page.getByRole('tab', { name: 'Changes', exact: true }).click();
    await enter(page.getByRole('button', { name: 'Switch to dark theme', exact: true }));
    await expect(page.getByText('net.mjs', { exact: true }).first()).toBeVisible();
    await page.screenshot({
      path: join(internal, 'public-native-retained-dark.png'),
      animations: 'disabled',
    });
    nativeSnapshot = await observer.snapshot();
    const retainedNative = nativeSnapshot.nativeRuns.find(
      (value) =>
        value.runId === nativeSnapshot.tasks.find((task) => task.id === nativeTask.id)?.runId,
    );
    assert.equal(retainedNative?.stage, 'retain-only');
    assert.equal(
      nativeSnapshot.evidence.filter((value) =>
        nativeSnapshot.candidates.some(
          (candidate) => candidate.id === value.candidateId && candidate.taskId === nativeTask.id,
        ),
      ).length,
      0,
    );
    await page.getByRole('tab', { name: 'Checks and review', exact: true }).click();
    const evaluationPanel = page.getByRole('region', { name: 'Candidate evaluation', exact: true });
    await expect(
      evaluationPanel.getByRole('button', { name: 'Prepare candidate evaluation', exact: true }),
    ).toBeDisabled();
    const reviewerProfile = evaluationPanel.getByRole('combobox', {
      name: 'Reviewer profile',
      exact: true,
    });
    await expect(reviewerProfile).toHaveValue('openai-file-v1');
    await expect(reviewerProfile.getByRole('option')).toHaveCount(1);
    await expect(reviewerProfile.getByRole('option')).toHaveText(
      'OpenAI scripted proposal fixture',
    );
    const reviewerCredits = evaluationPanel.getByLabel(
      'Allow existing credits for this review after included usage',
      { exact: true },
    );
    await expect(reviewerCredits).not.toBeChecked();
    const recipe = evaluationPanel.getByRole('combobox', { name: 'Test setup', exact: true });
    await expect(recipe).toHaveValue('node-tests-v1');
    const nativeTrust = evaluationPanel.getByLabel(
      'Trust the existing native client and login for the review',
      { exact: true },
    );
    await nativeTrust.check();
    await reviewerCredits.check();
    await recipe.selectOption('project-node-tests-v1');
    await expect(nativeTrust).not.toBeChecked();
    await expect(reviewerCredits).not.toBeChecked();
    const evaluationPermissions = [
      'Trust the existing native client and login for the review',
      'Share the original file, proposed change and task text with the reviewer',
      'Allow one local run of the selected project tests',
      'Allow one Keep it simple review',
    ];
    for (const label of evaluationPermissions)
      await evaluationPanel.getByLabel(label, { exact: true }).check();
    await reviewerCredits.check();
    await expect(
      evaluationPanel.getByRole('button', { name: 'Prepare candidate evaluation', exact: true }),
    ).toBeDisabled();
    const testFiles = evaluationPanel.getByRole('textbox', {
      name: 'Committed test files (one relative path per line)',
      exact: true,
    });
    await testFiles.fill('../outside.test.mjs');
    await expect(testFiles).toHaveAttribute('aria-invalid', 'true');
    await expect(evaluationPanel.getByRole('alert')).toContainText(
      'Enter 1 to 32 distinct relative file paths.',
    );
    await testFiles.fill('net.test.mjs');
    await expect(testFiles).toHaveAttribute('aria-invalid', 'false');
    for (const label of evaluationPermissions) {
      const permission = evaluationPanel.getByLabel(label, { exact: true });
      await expect(permission).not.toBeChecked();
      await permission.check();
    }
    await expect(reviewerCredits).not.toBeChecked();
    await expect(evaluationPanel).toContainText('Local code runs with your system permissions.');
    await expect(evaluationPanel).toContainText('Dependencies are not installed.');
    await testFiles.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(internal, 'project-node-tests-preparation-dark.png'),
      animations: 'disabled',
    });
    const beforeEvaluation = await observer.snapshot();
    await enter(
      evaluationPanel.getByRole('button', { name: 'Prepare candidate evaluation', exact: true }),
    );
    await expect(
      evaluationPanel.getByRole('button', { name: 'Start local checks', exact: true }),
    ).toBeEnabled();
    await expect(
      evaluationPanel.getByRole('button', { name: 'Start native review', exact: true }),
    ).toBeDisabled();
    const preparedEvaluation = await observer.snapshot();
    assert.equal(preparedEvaluation.attempts.length, beforeEvaluation.attempts.length);
    assert.equal(preparedEvaluation.candidateEvaluations[0].creditPolicy, 'ordinary');
    assert.equal(cli(home, 'task', 'show', nativeTask.id).evaluation.stage, 'prepared');
    const evaluation = preparedEvaluation.candidateEvaluations.find(
      (value) => value.taskId === nativeTask.id,
    );
    assert(evaluation);
    assert.equal(evaluation.recipe, 'project-node-tests-v1');
    const testFile = readFileSync(join(source, 'net.test.mjs'));
    assert.deepEqual(evaluation.testFiles, [
      {
        path: 'net.test.mjs',
        hash: createHash('sha256').update(testFile).digest('hex'),
        bytes: testFile.length,
        mode: '100644',
      },
    ]);
    await expect(evaluationPanel).toContainText('Project Node tests');
    await expect(evaluationPanel.getByText('net.test.mjs', { exact: true })).toBeVisible();
    const checkFrom = nativeEvents.rows.length;
    await enter(evaluationPanel.getByRole('button', { name: 'Start local checks', exact: true }));
    const checked = await nativeEvents.wait(
      (event) =>
        event.type === 'check.completed' &&
        event.taskId === nativeTask.id &&
        event.payload.candidateId === evaluation.candidateId &&
        event.payload.candidateHash === evaluation.candidateHash &&
        event.payload.definitionHash === evaluation.definitionHash,
      checkFrom,
    );
    assert.equal(checked.type, 'check.completed');
    assert.equal(checked.payload.passed, true);
    await expect(
      evaluationPanel.getByRole('button', { name: 'Start native review', exact: true }),
    ).toBeEnabled();
    await expect(evaluationPanel).toContainText('Local checks passed.');
    await expect(
      evaluationPanel.getByRole('button', { name: 'Start local checks', exact: true }),
    ).toBeDisabled();
    const reviewFrom = nativeEvents.rows.length;
    await enter(evaluationPanel.getByRole('button', { name: 'Start native review', exact: true }));
    const reviewed = await nativeEvents.wait(
      (event) =>
        event.type === 'review.completed' &&
        event.taskId === nativeTask.id &&
        event.payload.candidateId === evaluation.candidateId &&
        event.payload.candidateHash === evaluation.candidateHash &&
        event.payload.review?.job.scripted === false &&
        event.payload.review.job.runId === evaluation.runId &&
        event.payload.review.job.preparationId === evaluation.preparationId,
      reviewFrom,
    );
    assert.equal(reviewed.type, 'review.completed');
    assert.equal(reviewed.payload.passed, true);
    await expect(evaluationPanel).toContainText('Native review passed.');
    await expect(evaluationPanel).toContainText('separate process only');
    await expect(
      evaluationPanel.getByRole('button', { name: 'Start native review', exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Accept candidate', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
    const evaluated = await observer.snapshot();
    const nativeReview = evaluated.evidence.find(
      (value) => value.review && !value.review.job.scripted,
    );
    assert(nativeReview?.passed);
    assert.deepEqual(sourceIdentity(source), original);
    await page.screenshot({
      path: join(internal, 'candidate-evaluation-dark.png'),
      animations: 'disabled',
    });
    const acceptedRef = 'refs/heads/feat/native-checked';
    const priorBranch = git(source, ['rev-parse', 'refs/heads/feat/net-minor']);
    await page.getByLabel('Destination ref', { exact: true }).fill(acceptedRef);
    await enter(page.getByRole('button', { name: 'Accept candidate', exact: true }));
    await page.getByRole('tab', { name: 'Activity', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Pending approval' })).toContainText(acceptedRef);
    const pendingAcceptance = (await observer.snapshot()).approvals.find(
      (value) => value.taskId === nativeTask.id && value.status === 'pending',
    );
    assert(pendingAcceptance);
    const pendingReceipt = cli(home, 'task', 'accept', nativeTask.id, acceptedRef);
    assert.equal(pendingReceipt.result.outcome, 'already-applied');
    assert.equal(pendingReceipt.result.entity.id, nativeTask.id);
    assert.deepEqual(pendingReceipt.nextCommand, [
      'crewkite',
      'task',
      'approve',
      pendingAcceptance.approvalId,
      '--home',
      home,
      '--json',
    ]);
    await enter(page.getByRole('button', { name: 'Approve once', exact: true }));
    await nativeEvents.wait(
      (event) => event.type === 'candidate.accepted' && event.taskId === nativeTask.id,
    );
    const accepted = await observer.snapshot();
    const acceptedTask = accepted.tasks.find((value) => value.id === nativeTask.id);
    assert.equal(acceptedTask?.state, 'accepted');
    const acceptedRun = accepted.runs.find((value) => value.id === acceptedTask?.runId);
    assert(acceptedRun);
    const acceptedCommit = git(source, ['rev-parse', acceptedRef]).toString().trim();
    assert.equal(
      git(source, ['rev-parse', `${acceptedCommit}^`])
        .toString()
        .trim(),
      acceptedRun.source.base,
    );
    assert.deepEqual(
      git(source, ['show', `${acceptedRef}:net.mjs`]),
      readFileSync(join(home, 'scratch', acceptedRun.id, 'net.mjs')),
    );
    assert.deepEqual(git(source, ['rev-parse', 'refs/heads/feat/net-minor']), priorBranch);
    assert.deepEqual(sourceIdentity(source), original);
    const acceptedAgain = cli(home, 'task', 'accept', nativeTask.id, acceptedRef);
    assert.equal(acceptedAgain.result.outcome, 'applied');
    assert.equal(git(source, ['rev-parse', acceptedRef]).toString().trim(), acceptedCommit);
    assert.equal(
      cli(home, 'task', 'show', nativeTask.id).evaluation.localAcceptance.reason,
      'accepted',
    );
    await page.getByRole('tab', { name: 'Checks and review', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Accept candidate', exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
    await page
      .getByRole('button', { name: 'Accept candidate', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(internal, 'native-acceptance-dark.png'),
      animations: 'disabled',
    });
    nativeSnapshot = await observer.snapshot();
    assert.equal(nativeSnapshot.attempts.length, evaluated.attempts.length);
    observer.close();
    observer = undefined;
    await stop(controller);
    const nativeRestart = launchController(home, true);
    controller = nativeRestart.child;
    await nativeRestart.ready;
    observer = await connectController({
      ...readControllerEndpoint(home),
      actor: { id: 'native-reopened-observer', kind: 'cli' },
    });
    await enter(page.getByRole('button', { name: 'Reconnect controller', exact: true }));
    const reopenedNative = await observer.snapshot();
    assert.deepEqual(reopenedNative.nativeRuns, nativeSnapshot.nativeRuns);
    assert.deepEqual(reopenedNative.candidateEvaluations, nativeSnapshot.candidateEvaluations);
    assert.equal(reopenedNative.attempts.length, nativeSnapshot.attempts.length);
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
    assert.equal(
      reopenedNative.tasks.find((value) => value.id === nativeTask.id)?.state,
      'accepted',
    );
    assert.equal(git(source, ['rev-parse', acceptedRef]).toString().trim(), acceptedCommit);
    assert.deepEqual(sourceIdentity(source), original);

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
      application ? closeDesktop(application, desktop) : Promise.resolve(),
    ]);
    children.push(...(await Promise.allSettled([stop(controller)])));
    const workers = await Promise.allSettled([...groups].map(cleanupGroup));
    const failures = [...children, ...workers]
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason)
      .concat(discoveryFailures);
    assert.equal(failures.length, 0, `Owned process cleanup failed: ${failures.join('; ')}`);
  }
});
