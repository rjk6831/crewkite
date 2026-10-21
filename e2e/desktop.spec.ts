import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron, expect, type Locator, type Page, test } from '@playwright/test';
import {
  checkEnvironment,
  checkOwner,
  enrollCheckRoot,
  spawnCheckChild as spawn,
} from '../apps/controller/src/host/check-ownership.ts';
import { git } from '../apps/controller/src/host/source.ts';
import { groupAbsent } from '../apps/controller/src/host/worker.ts';
import { startController } from '../apps/controller/src/main.ts';
import { resolveAnthropicNativeProfile } from '../apps/controller/src/providers/anthropic/profile.ts';
import {
  unavailableNativeProfile,
  unavailableRepositoryProfile,
} from '../apps/controller/src/providers/openai/profile.ts';
import { CommandReceipts } from '../apps/desktop/src/main/receipts.ts';
import { encodeFrame, FrameDecoder } from '../packages/client/src/index.ts';
import {
  type ControllerClient,
  connectController,
  createCommandKey,
  readControllerEndpoint,
} from '../packages/client/src/node.ts';
import {
  AnthropicNativeProfileSchema,
  CONVERSATION_CONTEXT_MEDIA_TYPE,
  type Command,
  type CommandResult,
  CommandSchema,
  ConversationContextBundleSchema,
  type ConversationEntry,
  ConversationEntrySchema,
  canonicalJson,
  type Event,
  EventSchema,
  MAX_FRAME_BYTES,
  type Snapshot,
  SnapshotSchema,
  type TaskConversationState,
  TaskConversationStateSchema,
  TaskPageSchema,
  type TaskSummary,
} from '../packages/contracts/src/index.ts';
import { createDemoFixtures, createTestIds } from '../packages/testkit/src/fixtures.ts';

const root = resolve(import.meta.dirname, '..');
const internal =
  checkOwner()?.stateRoot ??
  (existsSync(join(root, 'internal/tools'))
    ? dirname(realpathSync(join(root, 'internal/tools')))
    : join(root, 'internal'));
const node = process.execPath;
const require = createRequire(join(root, 'apps/desktop/package.json'));
const environment = (home: string) => ({
  ...checkEnvironment(),
  PATH: process.env.PATH ?? '',
  LANG: 'en_US.UTF-8',
  HOME: home,
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
    import {spawnCheckChild as spawn} from ${JSON.stringify(join(root, 'apps/controller/src/host/check-ownership.ts'))};
    import {createHash} from 'node:crypto';
    import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {startController} from ${JSON.stringify(join(root, 'apps/controller/src/main.ts'))};
    import {unavailableNativeProfile,unavailableRepositoryProfile} from ${JSON.stringify(join(root, 'apps/controller/src/providers/openai/profile.ts'))};
    import {AnthropicNativeProfileSchema,GoogleNativeProfileSchema} from ${JSON.stringify(join(root, 'packages/contracts/src/index.ts'))};
    import {replacementFixture as anthropicFixture} from ${JSON.stringify(join(root, 'apps/controller/src/providers/anthropic/replacement-fixture.ts'))};
    import {replacementFixture as googleFixture} from ${JSON.stringify(join(root, 'apps/controller/src/providers/google/replacement-fixture.ts'))};
    import {fixture, fixtureContent, fixtureModel,repositoryFixture} from ${JSON.stringify(join(root, 'apps/controller/src/providers/openai/replacement-fixture.ts'))};
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
    const googleProfile={...profile,client:{...profile.client,version:'1.4.0'},facts:GoogleNativeProfileSchema.parse({...anthropicProfile.facts,clientVersion:'1.4.0',id:'google-file-v1',family:'google',displayName:'Google scripted proposal fixture',effort:'low',permissionModes:['request-review','strict','always-proceed','proceed-in-sandbox']}),locationHash:'3'.repeat(64)};
    const repositoryProfile={...profile,facts:{...unavailableRepositoryProfile().facts,model:fixtureModel,clientVersion:process.version,available:true,reason:'qualification-pending'},locationHash:'4'.repeat(64)};
    const runtime=await startController({home:process.env.CREWKITE_HOME,identity:{name:'CrewKite fixture',email:'fixture@example.invalid'},nativeProfiles:()=>[profile,anthropicProfile,googleProfile,repositoryProfile],googleUsageClient:()=>({available:false,reason:'client-unavailable'}),nativeSpawn:(executable,args,options)=>{
      const store=runtime.controller.store;
      const intent=store.intents().findLast(intent=>store.nativeProcesses(intent.attempt_id).some(row=>row.state==='intent'));
      const family=intent?store.get('route',intent.route_id)?.family:undefined;
      const content=readFileSync(join(proposal,'net.mjs'),'utf8');
      const repositoryWriter=family==='openai'&&!store.db.prepare('SELECT 1 FROM review_jobs WHERE attempt_id=?').get(intent.attempt_id);
      return family==='google'
        ?spawn(executable,['-e',googleFixture(args,{content,permissionMode:'strict'})],options)
        :args[0]==='auth'||args.includes('--print')
          ?spawn(executable,['-e',anthropicFixture(args,{content})],options)
          :spawn(executable,['-e',repositoryWriter?repositoryFixture([{path:'net.mjs',content}]):transcript,'success',args.at(-1)==='list'?'features':++phases%2===1?'prepare':'task'],options);
    }});
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
  await button.click();
}

function workspaceRead(snapshot: Snapshot, command: Command): CommandResult | null {
  const stamp = {
    epoch: '1'.repeat(32),
    revision: createHash('sha256')
      .update(
        canonicalJson({
          projects: snapshot.projects.map(({ id, name }) => ({ id, name })),
          tasks: snapshot.tasks.map(({ id, projectId, title, outcome, criteria }) => ({
            id,
            projectId,
            title,
            outcome,
            criteria,
          })),
        }),
      )
      .digest('hex')
      .slice(0, 12),
  };
  stamp.revision = BigInt(`0x${stamp.revision}`).toString();
  if (command.command === 'GetWorkspaceState') {
    const {
      protocol,
      cursor,
      routes,
      usage,
      usageReaders,
      nativeProfiles,
      googleAcpSetup,
      googleAcpInstall,
      nativeConnections,
      localSetup,
    } = snapshot;
    return {
      outcome: 'applied',
      data: {
        kind: 'workspace-state',
        version: 1,
        stamp,
        protocol,
        cursor,
        routes,
        usage,
        usageReaders,
        nativeProfiles,
        googleAcpSetup,
        googleAcpInstall,
        nativeConnections,
        localSetup,
      },
    };
  }
  if (command.command === 'GetProjectPage')
    return {
      outcome: 'applied',
      data: {
        kind: 'project-page',
        version: 1,
        stamp,
        cursor: snapshot.cursor,
        complete: true,
        next: null,
        projects: snapshot.projects.map((project) => ({
          ...project,
          taskCount: snapshot.tasks.filter((task) => task.projectId === project.id).length,
        })),
      },
    };
  if (command.command !== 'GetTaskPage') return null;
  const request = command.payload;
  const filtered = snapshot.tasks
    .filter(
      (task) =>
        (!request.projectId || task.projectId === request.projectId) &&
        (!request.taskId || task.id === request.taskId),
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const rows = filtered
    .filter((task) => !request.after?.afterId || task.id > request.after.afterId)
    .slice(0, request.limit);
  const tasks: TaskSummary[] = rows.map(
    ({ id, projectId, title, state, waitingReason, revision, runId, next }) => ({
      id,
      projectId,
      title,
      state,
      waitingReason,
      revision,
      runId,
      next,
    }),
  );
  const last = rows.at(-1);
  const complete = !last || !filtered.some((task) => task.id > last.id);
  return {
    outcome: 'applied',
    data: {
      kind: 'task-page',
      version: 1,
      stamp,
      cursor: snapshot.cursor,
      tasks,
      scanned: rows.length,
      complete,
      next: complete
        ? null
        : {
            version: 1,
            stamp,
            section: 'tasks',
            selectionHash: '0'.repeat(64),
            afterId: last?.id ?? null,
          },
    },
  };
}

async function pauseRenderer(
  application: Awaited<ReturnType<typeof _electron.launch>>,
  page: Page,
) {
  const url = page.url();
  // Unload the prior fixture before replacing its window's IPC handlers.
  await application.evaluate(async ({ BrowserWindow }) => {
    await BrowserWindow.getAllWindows()[0].loadURL('about:blank');
  });
  return () =>
    application.evaluate(async ({ BrowserWindow }, url) => {
      await BrowserWindow.getAllWindows()[0].loadURL(url);
    }, url);
}

async function desktopSnapshot(page: Page, taskId?: string) {
  try {
    return SnapshotSchema.parse(
      await page.evaluate(
        (selected) => window.crewkite?.getSnapshot(selected ? { taskId: selected } : undefined),
        taskId,
      ),
    );
  } catch (failure) {
    if (
      failure instanceof Error &&
      /(?:Controller is offline\.|The controller is offline\.|Snapshot unavailable: connection-lost\.)/u.test(
        failure.message,
      )
    )
      return null;
    throw failure;
  }
}

async function quotaReadBridge(
  application: Awaited<ReturnType<typeof _electron.launch>>,
  page: Page,
) {
  const home = mkdtempSync(join(internal, 'quota-bridge-'));
  const socketPath = join(home, 'control.sock');
  const snapshot = SnapshotSchema.parse({
    protocol: 1,
    cursor: '0',
    projects: [],
    tasks: [],
    runs: [],
    attempts: [],
    routes: [],
    artifacts: [],
    evidence: [],
    approvals: [],
    usage: [],
    candidates: [],
    usageReaders: [
      {
        id: 'google-usage-v1',
        family: 'google',
        clientVersion: '1.4.0',
        available: false,
        reason: 'client-unavailable',
        lastAttemptAt: null,
        lastObservedAt: null,
      },
    ],
  });
  let failNextSnapshot = false;
  let conversationState: TaskConversationState | null = null;
  const pending: Array<{ command: Command; socket: Socket }> = [];
  const sockets = new Set<Socket>();
  let waiting: ((value: { command: Command; socket: Socket }) => void) | null = null;
  const next = () => {
    const request = pending.shift();
    return request
      ? Promise.resolve(request)
      : new Promise<{ command: Command; socket: Socket }>((resolve) => {
          waiting = resolve;
        });
  };
  const reply = (request: { command: Command; socket: Socket }, result: CommandResult) =>
    request.socket.write(encodeFrame({ type: 'result', key: request.command.key, result }));
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const decoder = new FrameDecoder();
    socket.on('data', (bytes) => {
      for (const message of decoder.push(bytes)) {
        if (message.type === 'hello')
          socket.write(encodeFrame({ type: 'welcome', protocol: 1, cursor: '0' }));
        if (message.type !== 'command') continue;
        const request = { command: message.command, socket };
        const workspace = workspaceRead(snapshot, message.command);
        if (
          failNextSnapshot &&
          (message.command.command === 'GetWorkspaceState' ||
            message.command.command === 'GetSnapshot')
        ) {
          failNextSnapshot = false;
          reply(request, { outcome: 'blocked', reason: 'fixture-refresh-failed' });
        } else if (workspace) reply(request, workspace);
        else if (message.command.command === 'GetSnapshot')
          reply(request, { outcome: 'applied', data: { kind: 'snapshot', snapshot } });
        else if (message.command.command === 'Subscribe') reply(request, { outcome: 'applied' });
        else if (message.command.command === 'GetTaskConversationState')
          reply(
            request,
            conversationState
              ? {
                  outcome: 'applied',
                  data: { kind: 'conversation-state', state: conversationState },
                }
              : { outcome: 'blocked', reason: 'not-configured' },
          );
        else if (message.command.command === 'GetTaskConversation')
          reply(request, {
            outcome: 'applied',
            data: {
              kind: 'conversation',
              taskId: message.command.payload.taskId,
              entries: [],
              nextBeforeCursor: null,
            },
          });
        else if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve(request);
        } else pending.push(request);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try {
    const restoreRenderer = await pauseRenderer(application, page);
    await application.evaluate(
      async ({ BrowserWindow }, options) => {
        const load = process.mainModule?.require.bind(process.mainModule);
        if (!load) throw new Error('The desktop fixture module loader is unavailable.');
        const { installBridge } = load(
          options.bridge,
        ) as typeof import('../apps/desktop/src/main/bridge.ts');
        const { connectController } = load(
          options.client,
        ) as typeof import('../packages/client/src/node.ts');
        const { desktopActor } = load(
          options.runtime,
        ) as typeof import('../apps/desktop/src/main/runtime.ts');
        const client = await connectController({
          socketPath: options.socketPath,
          token: 'a'.repeat(64),
          actor: desktopActor,
          reconnectDelaysMs: [],
        });
        const window = BrowserWindow.getAllWindows()[0];
        window.once('closed', () => client.close());
        await installBridge(window, {
          paths: { home: options.home, profile: options.home },
          connect: async () => client,
          resetClient: () => client.close(),
        } as never);
      },
      {
        bridge: join(root, 'apps/desktop/src/main/bridge.ts'),
        client: join(root, 'packages/client/src/node.ts'),
        runtime: join(root, 'apps/desktop/src/main/runtime.ts'),
        socketPath,
        home,
      },
    );
    await restoreRenderer();
    await expect(page.getByText('Controller connected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Usage and capacity', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Google client status', exact: true });
    const refresh = panel.getByRole('button', { name: 'Refresh Google quota', exact: true });
    await expect(panel.getByRole('checkbox')).toHaveCount(0);
    await expect(refresh).toBeDisabled();
    await expect(panel).toContainText('client-unavailable');
    assert.equal(pending.length, 0, pending.map(({ command }) => command.command).join(','));
    snapshot.usageReaders[0].available = true;
    snapshot.usageReaders[0].reason = 'available';
    await page.reload();
    await page.getByRole('button', { name: 'Usage and capacity', exact: true }).click();
    await expect(refresh).toBeEnabled();
    assert.equal(pending.length, 0);
    await refresh.click();
    const read = await next();
    assert.equal(read.command.command, 'ObserveUsage');
    assert.deepEqual(read.command.payload, { family: 'google' });
    await expect(refresh).toBeDisabled();
    await expect(
      page.getByRole('status').filter({ hasText: /Quota|fixture-uncertain|usage-reader-cooldown/ }),
    ).toContainText('Quota read in progress');
    const rejectCommand = (input: unknown) =>
      page.evaluate(async (value) => {
        try {
          await window.crewkite?.command(value as never);
          return '';
        } catch (failure) {
          return String(failure);
        }
      }, input);
    const refreshCommand = {
      command: 'ObserveUsage',
      expectedRevision: 0,
      payload: { family: 'google' },
    };
    for (const consent of [true, false])
      assert.match(
        await rejectCommand({ ...refreshCommand, payload: { family: 'google', consent } }),
        /Unrecognized key/u,
      );
    const health = page.evaluate(() =>
      window.crewkite?.command({ command: 'GetHealth', payload: {} }),
    );
    const healthRequest = await next();
    assert.equal(healthRequest.command.command, 'GetHealth');
    reply(healthRequest, { outcome: 'applied' });
    await health;
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await page.getByRole('button', { name: 'Add project', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Add project', exact: true })).toBeEnabled();
    reply(read, { outcome: 'outcome-unknown', reason: 'fixture-uncertain' });
    await expect(page.getByRole('status').filter({ hasText: 'fixture-uncertain' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Retry exact command', exact: true }),
    ).toHaveCount(0);
    await expect(refresh).toBeEnabled();
    await refresh.click();
    const repeatedRead = await next();
    assert.notEqual(repeatedRead.command.key, read.command.key);
    snapshot.usageReaders[0].lastAttemptAt = new Date().toISOString();
    failNextSnapshot = true;
    reply(repeatedRead, { outcome: 'applied', data: { kind: 'usage', windows: [] } });
    await expect(
      page.getByRole('status').filter({ hasText: 'Quota read successful' }),
    ).toBeVisible();
    await expect(page.getByText(/Workspace refresh failed:/u)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add project', exact: true })).toBeEnabled();
    await expect(
      page.getByRole('button', { name: 'Retry exact command', exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await page.getByRole('button', { name: 'Usage and capacity', exact: true }).click();
    await expect(panel).toContainText(/Refresh available in \d+s/u);
    await expect(refresh).toBeDisabled();
    assert.equal(pending.length, 0);
    snapshot.nativeProfiles.push(
      AnthropicNativeProfileSchema.parse({
        ...unavailableNativeProfile().facts,
        id: 'anthropic-file-v1',
        family: 'anthropic',
        model: resolveAnthropicNativeProfile({}).facts.model,
        effort: 'medium',
        effectiveEffort: 'unknown',
        accountClass: 'unknown',
        serviceTier: 'unknown',
        billingBasis: 'requires-user-attestation',
        qualifiedAt: null,
        creditPolicies: ['ordinary'],
        available: true,
        reason: 'qualification-pending',
      }),
    );
    await page.reload();
    await page.getByRole('button', { name: 'Usage and capacity', exact: true }).click();
    const anthropicPanel = page.getByRole('region', {
      name: 'Anthropic client status',
      exact: true,
    });
    await anthropicPanel
      .getByRole('button', { name: 'Check Anthropic sign-in', exact: true })
      .click();
    const authCheck = await next();
    assert.equal(authCheck.command.command, 'CheckNativeConnection');
    assert.deepEqual(authCheck.command.payload, { family: 'anthropic', consent: 'explicit' });
    await expect(page.getByRole('button', { name: 'Add project', exact: true })).toBeEnabled();
    snapshot.nativeConnections = [
      {
        family: 'anthropic',
        profileId: 'anthropic-file-v1',
        state: 'signed-in',
        authMethod: 'subscription',
        observedAt: new Date().toISOString(),
        reason: null,
        next: 'Sign-in observed. Billing and task qualification remain unknown.',
        billing: 'unknown',
        qualified: false,
        quota: 'unknown',
      },
    ];
    reply(authCheck, { outcome: 'applied' });
    await expect(anthropicPanel).toContainText('Signed in with Anthropic account');
    await expect(anthropicPanel).toContainText('Billing and task qualification remain unknown');
    await expect(
      page.getByRole('button', { name: 'Retry exact command', exact: true }),
    ).toHaveCount(0);
    const usageReader: Snapshot['usageReaders'][number] = {
      id: 'anthropic-usage-v1',
      family: 'anthropic',
      clientVersion: 'fixture',
      available: true,
      reason: 'available',
      lastObservedAt: null,
      lastAttemptAt: null,
      readState: 'idle',
      reading: null,
      readingScopeHash: null,
      trust: {
        scopeHash: 'b'.repeat(64),
        clientSha256: 'c'.repeat(64),
        command: '/usage',
        generationRequest: false,
        policyHooks: 'covered-by-native-client-trust',
        accepted: false,
      },
    };
    snapshot.usageReaders.push(usageReader);
    await page.reload();
    await page.getByRole('button', { name: 'Usage and capacity', exact: true }).click();
    const quotaRefresh = anthropicPanel.getByRole('button', {
      name: 'Refresh Anthropic quota',
      exact: true,
    });
    await quotaRefresh.click();
    const nativeTrust = page.getByRole('dialog', {
      name: 'Trust the native usage command',
      exact: true,
    });
    await expect(nativeTrust).toContainText('sends no generation request');
    await expect(nativeTrust).toContainText('administrator policy hooks');
    assert.equal(pending.length, 0, 'opening native trust starts no read');
    await nativeTrust.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(pending.length, 0);
    await quotaRefresh.click();
    await nativeTrust.getByRole('button', { name: 'Trust and refresh quota', exact: true }).click();
    const usageRefresh = await next();
    assert.equal(usageRefresh.command.command, 'RefreshAnthropicUsage');
    assert.deepEqual(usageRefresh.command.payload, {
      trust: { nativeTrust: 'accepted', scopeHash: 'b'.repeat(64) },
    });
    assert(usageReader.trust);
    usageReader.trust.accepted = true;
    usageReader.readState = 'quiescent';
    usageReader.readReason = 'reported';
    usageReader.readingScopeHash = usageReader.trust.scopeHash;
    usageReader.reading = {
      status: 'reported',
      source: 'native-local-command',
      receivedAt: new Date().toISOString(),
      observedAt: null,
      freshness: 'unknown',
      windows: [
        {
          kind: 'session',
          group: 'session',
          percent: 37,
          resets_at: '2030-01-01T00:00:00.000Z',
          severity: 'normal',
          is_active: true,
        },
      ],
      extraUsage: null,
      modelTurns: 0,
      qualified: false,
    };
    reply(usageRefresh, { outcome: 'applied' });
    const nativeAllowance = page.getByRole('article', {
      name: 'Anthropic native quota',
      exact: true,
    });
    await expect(nativeAllowance).toBeVisible();
    await expect(nativeAllowance).toContainText('Last retained report received');
    await expect(nativeAllowance).toContainText('Observation time and cache age unknown');
    await expect(nativeAllowance.locator('.usage-gauge-value')).toContainText('63%');
    await expect(nativeAllowance.locator('.usage-gauge-caption')).toHaveText('reported remaining');
    await expect(
      nativeAllowance.locator('time[datetime="2030-01-01T00:00:00.000Z"]').first(),
    ).toBeVisible();
    await expect(anthropicPanel.locator('progress')).toHaveCount(0);
    await expect(anthropicPanel).not.toContainText('Reader ready, not read');
    await quotaRefresh.click();
    const rememberedRefresh = await next();
    assert.equal(rememberedRefresh.command.command, 'RefreshAnthropicUsage');
    assert.deepEqual(rememberedRefresh.command.payload, {});
    await expect(nativeTrust).toHaveCount(0);
    reply(rememberedRefresh, { outcome: 'blocked', reason: 'usage-reader-cooldown' });
    snapshot.nativeConnections[0] = {
      ...snapshot.nativeConnections[0],
      state: 'signed-out',
      authMethod: 'none',
    };
    await page.reload();
    await page.getByRole('button', { name: 'Connect providers', exact: true }).click();
    await application.evaluate(({ shell, dialog }) => {
      const fixture = shell as typeof shell & {
        fixtureUrls: string[];
        fixtureErrors: string[];
        fixtureReject: boolean;
        fixtureRestore: () => void;
      };
      const open = shell.openExternal;
      const error = dialog.showErrorBox;
      fixture.fixtureUrls = [];
      fixture.fixtureErrors = [];
      fixture.fixtureReject = false;
      fixture.fixtureRestore = () => {
        shell.openExternal = open;
        dialog.showErrorBox = error;
      };
      shell.openExternal = async (url) => {
        fixture.fixtureUrls.push(url);
        if (fixture.fixtureReject) throw new Error('fixture-browser-unavailable');
      };
      dialog.showErrorBox = (title, content) => {
        fixture.fixtureErrors.push(`${title}: ${content}`);
      };
    });
    const instructions =
      'https://github.com/rjk6831/crewkite/blob/main/docs/providers.md#anthropic-writer-preparation';
    await page
      .getByRole('link', { name: 'native client sign-in instructions', exact: true })
      .click();
    await expect
      .poll(() =>
        application.evaluate(
          ({ shell }) => (shell as typeof shell & { fixtureUrls: string[] }).fixtureUrls,
        ),
      )
      .toEqual([instructions]);
    for (const url of [
      'https://example.com/',
      `${instructions}?token=untrusted`,
      instructions.replace('#anthropic-writer-preparation', '#other'),
      'file:///tmp/instructions',
    ])
      await page.evaluate((value) => {
        window.open(value, '_blank');
      }, url);
    assert.equal(
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      1,
    );
    assert.deepEqual(
      await application.evaluate(
        ({ shell }) => (shell as typeof shell & { fixtureUrls: string[] }).fixtureUrls,
      ),
      [instructions],
    );
    await application.evaluate(({ shell }) => {
      (shell as typeof shell & { fixtureReject: boolean }).fixtureReject = true;
    });
    await page
      .getByRole('link', { name: 'native client sign-in instructions', exact: true })
      .click();
    await expect
      .poll(() =>
        application.evaluate(
          ({ shell }) => (shell as typeof shell & { fixtureErrors: string[] }).fixtureErrors,
        ),
      )
      .toEqual([
        `Sign-in instructions could not be opened: Open this address in your browser: ${instructions}`,
      ]);
    await application.evaluate(({ shell }) =>
      (shell as typeof shell & { fixtureRestore: () => void }).fixtureRestore(),
    );

    const setupPanel = page.getByRole('region', { name: 'Google ACP setup', exact: true });
    const connectGoogle = setupPanel.getByRole('button', {
      name: 'Connect Google',
      exact: true,
    });
    await connectGoogle.click();
    const installation = await next();
    assert.equal(installation.command.command, 'InstallGoogleAcp');
    assert.deepEqual(installation.command.payload, {
      profileId: 'google-acp-v1',
      consent: 'explicit',
    });
    snapshot.googleAcpInstall = {
      profileId: 'google-acp-v1',
      state: 'installing',
      operationId: installation.command.key,
      observedAt: new Date().toISOString(),
      reason: null,
      next: 'Installation in progress.',
    };
    await expect(page.getByRole('button', { name: 'Add project', exact: true })).toBeEnabled();
    await setupPanel.getByRole('button', { name: 'Cancel', exact: true }).click();
    const installStop = await next();
    assert.equal(installStop.command.command, 'StopGoogleAcpInstall');
    assert.deepEqual(installStop.command.payload, {
      profileId: 'google-acp-v1',
      operationId: installation.command.key,
    });
    snapshot.googleAcpInstall = {
      ...snapshot.googleAcpInstall,
      state: 'blocked',
      operationId: null,
      reason: 'google-install-stopped',
      next: 'Start a new installation.',
    };
    reply(installStop, {
      outcome: 'applied',
      data: { kind: 'google-acp-install', install: snapshot.googleAcpInstall },
    });
    reply(installation, {
      outcome: 'blocked',
      reason: 'google-install-stopped',
      data: { kind: 'google-acp-install', install: snapshot.googleAcpInstall },
    });
    await expect(setupPanel.getByRole('status').last()).toContainText(
      'Cancellation requested for the active operation.',
    );
    snapshot.googleAcpInstall = {
      ...snapshot.googleAcpInstall,
      state: 'installed',
      operationId: null,
      reason: null,
      next: 'Initialize the installed client.',
    };
    snapshot.googleAcpSetup = {
      profileId: 'google-acp-v1',
      revision: 1,
      state: 'uninitialized',
      operationId: null,
      proofId: null,
      client: null,
      auth: { method: null, status: 'unknown' },
      reason: null,
    };
    await page.reload();
    await page.getByRole('button', { name: 'Connect providers', exact: true }).click();
    await connectGoogle.click();
    const setupRead = await next();
    assert.equal(setupRead.command.command, 'InitializeGoogleAcp');
    snapshot.googleAcpSetup = {
      ...snapshot.googleAcpSetup,
      state: 'initializing',
      operationId: setupRead.command.key,
    };
    await setupPanel.getByRole('button', { name: 'Cancel', exact: true }).click();
    const setupStop = await next();
    assert.equal(setupStop.command.command, 'StopGoogleAcpSetup');
    assert.equal(setupStop.command.expectedRevision, 1);
    assert.deepEqual(setupStop.command.payload, {
      profileId: 'google-acp-v1',
      operationId: setupRead.command.key,
    });
    snapshot.googleAcpSetup = {
      ...snapshot.googleAcpSetup,
      revision: 2,
      state: 'blocked',
      operationId: null,
    };
    reply(setupStop, {
      outcome: 'applied',
      data: { kind: 'google-acp-setup', setup: snapshot.googleAcpSetup },
    });
    reply(setupRead, {
      outcome: 'blocked',
      reason: 'fixture-client-missing',
      data: { kind: 'google-acp-setup', setup: snapshot.googleAcpSetup },
    });
    await expect(setupPanel.getByRole('status').last()).toContainText(
      'Cancellation requested for the active operation.',
    );
    await expect(
      page.getByRole('button', { name: 'Retry exact command', exact: true }),
    ).toHaveCount(0);
    snapshot.googleAcpInstall = {
      ...snapshot.googleAcpInstall,
      state: 'idle',
      operationId: null,
      reason: null,
      next: 'Install the official client.',
    };
    snapshot.googleAcpSetup = {
      profileId: 'google-acp-v1',
      revision: 0,
      state: 'uninitialized',
      operationId: null,
      proofId: null,
      client: null,
      auth: { method: null, status: 'unknown' },
      reason: null,
    };
    await page.reload();
    await page.getByRole('button', { name: 'Connect providers', exact: true }).click();
    await connectGoogle.click();
    const installed = await next();
    assert.equal(installed.command.command, 'InstallGoogleAcp');
    snapshot.googleAcpInstall = {
      ...snapshot.googleAcpInstall,
      state: 'installed',
      reason: null,
      next: 'Initialize the installed client.',
    };
    reply(installed, {
      outcome: 'applied',
      data: { kind: 'google-acp-install', install: snapshot.googleAcpInstall },
    });
    const initialization = await next();
    assert.equal(initialization.command.command, 'InitializeGoogleAcp');
    assert.equal(initialization.command.expectedRevision, 0);
    assert.deepEqual(initialization.command.payload, {
      profileId: 'google-acp-v1',
      consent: 'explicit',
    });
    snapshot.googleAcpSetup = {
      ...snapshot.googleAcpSetup,
      revision: 1,
      state: 'authentication-required',
      proofId: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      client: { version: '1.4.0', sha256: 'a'.repeat(64), signerTeamId: 'fixture-team' },
      auth: { method: 'oauth-personal', status: 'required' },
    };
    reply(initialization, {
      outcome: 'applied',
      data: { kind: 'google-acp-setup', setup: snapshot.googleAcpSetup },
    });
    const authenticate = await next();
    assert.equal(authenticate.command.command, 'AuthenticateGoogleAcp');
    assert.equal(authenticate.command.expectedRevision, 1);
    assert.deepEqual(authenticate.command.payload, {
      profileId: 'google-acp-v1',
      proofId: snapshot.googleAcpSetup.proofId,
      method: 'oauth-personal',
      consent: 'explicit',
    });
    snapshot.googleAcpSetup = {
      ...snapshot.googleAcpSetup,
      revision: 2,
      state: 'discovery-required',
      auth: { method: 'oauth-personal', status: 'authenticated' },
    };
    reply(authenticate, {
      outcome: 'applied',
      data: { kind: 'google-acp-setup', setup: snapshot.googleAcpSetup },
    });
    const discovery = await next();
    assert.equal(discovery.command.command, 'DiscoverGoogleAcp');
    assert.equal(discovery.command.expectedRevision, 2);
    assert.deepEqual(discovery.command.payload, {
      profileId: 'google-acp-v1',
      proofId: snapshot.googleAcpSetup.proofId,
      consent: 'explicit',
    });
    snapshot.googleAcpSetup = { ...snapshot.googleAcpSetup, revision: 3, state: 'ready' };
    reply(discovery, {
      outcome: 'applied',
      data: { kind: 'google-acp-setup', setup: snapshot.googleAcpSetup },
    });
    await expect(setupPanel.getByRole('status').last()).toContainText(
      'Google coding setup is ready.',
    );
    await expect(
      page.getByRole('button', { name: 'Retry exact command', exact: true }),
    ).toHaveCount(0);
    const fixture = createDemoFixtures('2026-10-17T10:00:00.000Z');
    const preparedTask = { ...fixture.task, revision: 3, runId: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV' };
    const preparedRun = {
      id: preparedTask.runId,
      taskId: preparedTask.id,
      source: {
        projectId: preparedTask.projectId,
        base: 'a'.repeat(40),
        branch: 'main',
        dirtyCount: 0,
        untrackedCount: 0,
      },
      policy: { policy: fixture.policy, hash: 'b'.repeat(64) },
      roles: fixture.roles,
      decision: {
        chosen: fixture.roles[0].routeId,
        rejected: [],
        rule: 'manual' as const,
        inputsHash: 'c'.repeat(64),
      },
      revision: 0,
    };
    snapshot.projects = fixture.snapshot.projects;
    snapshot.tasks = [preparedTask];
    snapshot.runs = [preparedRun];
    snapshot.routes = fixture.snapshot.routes;
    snapshot.nativeProfiles = [
      { ...unavailableNativeProfile().facts, available: true, reason: 'available' },
    ];
    snapshot.nativeRuns = [
      {
        runId: preparedRun.id,
        profileId: 'openai-file-v1',
        stage: 'prepared',
        expiresAt: '2099-01-01T00:00:00.000Z',
        target: { path: 'net.mjs', baseHash: 'd'.repeat(64), bytes: 42 },
      },
    ];
    conversationState = TaskConversationStateSchema.parse({
      taskId: preparedTask.id,
      revision: preparedTask.revision,
      contractStatus: 'confirmed',
      purpose: 'execution',
      phase: 'idle',
      configuration: null,
      currentRunId: preparedRun.id,
      activeAttempt: null,
      budget: null,
      queuedInputCount: 0,
      pendingQuestions: [],
      proposal: null,
      adoptedProposal: null,
      send: { available: false, reason: 'not-configured', disposition: null },
      adopt: { available: false, reason: 'proposal-missing' },
    });
    SnapshotSchema.parse(snapshot);
    {
      snapshot.usageReaders[0].lastAttemptAt = '2026-10-17T00:00:00.000Z';
      await page.reload();
      await page.getByRole('button', { name: 'Usage and capacity', exact: true }).click();
      await refresh.click();
      const heldMetadata = await next();
      assert.equal(heldMetadata.command.command, 'ObserveUsage');
      await page.getByRole('button', { name: preparedTask.title, exact: true }).click();
      await page.getByRole('button', { name: 'Review prepared proposal', exact: true }).click();
      const proposal = page.getByRole('dialog', {
        name: 'Review the native proposal',
        exact: true,
      });
      await proposal.getByRole('button', { name: 'Start native proposal', exact: true }).click();
      const starting = await next();
      assert.equal(starting.command.command, 'StartRun');
      assert.deepEqual(starting.command.payload, {
        taskId: preparedTask.id,
        runId: preparedRun.id,
      });
      await proposal.getByRole('button', { name: 'Cancel', exact: true }).click();
      const stop = {
        command: 'StopRun',
        expectedRevision: preparedTask.revision,
        payload: { taskId: preparedTask.id, runId: preparedRun.id },
      };
      for (const payload of [
        { ...stop.payload, runId: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
        { ...stop.payload, taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
      ])
        assert.match(await rejectCommand({ ...stop, payload }), /pending desktop command/u);
      assert.match(
        await rejectCommand({ command: 'GetHealth', payload: {} }),
        /pending desktop command/u,
      );
      const stopButton = page.getByRole('button', { name: 'Stop', exact: true });
      await expect(stopButton).toBeEnabled();
      await stopButton.click();
      const cancelled = await next();
      assert.equal(cancelled.command.command, 'StopRun');
      assert.equal(cancelled.command.expectedRevision, preparedTask.revision);
      assert.deepEqual(cancelled.command.payload, stop.payload);
      await expect(stopButton).toBeDisabled();
      const independentMetadata = page.evaluate(
        (value) => window.crewkite?.command(value),
        refreshCommand as never,
      );
      const duringStop = await next();
      assert.equal(duringStop.command.command, 'ObserveUsage');
      reply(duringStop, { outcome: 'blocked', reason: 'usage-reader-cooldown' });
      assert.equal((await independentMetadata)?.outcome, 'blocked');
      for (const input of [
        { command: 'RefreshAnthropicUsage', expectedRevision: 0, payload: {} },
        {
          command: 'StopAnthropicUsage',
          expectedRevision: 0,
          payload: { operationId: starting.command.key },
        },
      ]) {
        const independentUsage = page.evaluate(
          (value) => window.crewkite?.command(value),
          input as never,
        );
        const pendingUsage = await next();
        assert.equal(pendingUsage.command.command, input.command);
        reply(pendingUsage, { outcome: 'blocked', reason: 'fixture-native-usage' });
        assert.equal((await independentUsage)?.reason, 'fixture-native-usage');
      }

      reply(cancelled, { outcome: 'outcome-unknown', reason: 'fixture-stop-unknown' });
      // Cancellation completion cannot release the original Start command's busy owner.
      await expect(page.getByRole('alert')).toContainText('fixture-stop-unknown');
      assert.match(
        await rejectCommand({ command: 'GetHealth', payload: {} }),
        /pending desktop command/u,
      );
      reply(starting, { outcome: 'blocked', reason: 'fixture-start-stop' });
      await expect(page.getByRole('alert')).toContainText('fixture-start-stop');
      assert.match(await rejectCommand(stop), /existing uncertain stop/u);
      const retryStop = page.evaluate(() => window.crewkite?.retryCommand?.());
      const repeatedStop = await next();
      assert.deepEqual(repeatedStop.command, cancelled.command);
      reply(repeatedStop, { outcome: 'applied' });
      assert.equal((await retryStop)?.outcome, 'applied');
      reply(heldMetadata, { outcome: 'blocked', reason: 'fixture-metadata-failed' });
      await expect(
        page.getByRole('button', { name: 'Retry exact command', exact: true }),
      ).toHaveCount(0);
    }
    const capacity = await application.evaluate(
      (_electron, options) => {
        const load = process.mainModule?.require.bind(process.mainModule);
        if (!load) throw new Error('The desktop fixture module loader is unavailable.');
        const { CommandReceipts } = load(
          options.receipts,
        ) as typeof import('../apps/desktop/src/main/receipts.ts');
        const { createCommandKey } = load(
          options.client,
        ) as typeof import('../packages/client/src/node.ts');
        const { desktopActor } = load(
          options.runtime,
        ) as typeof import('../apps/desktop/src/main/runtime.ts');
        const receipts = new CommandReceipts(options.home, `${options.home}/capacity`);
        const operation = {
          protocol: 1 as const,
          key: createCommandKey(),
          actor: desktopActor,
          expectedRevision: 0,
          command: 'InitializeGoogleAcp' as const,
          payload: { profileId: 'google-acp-v1' as const, consent: 'explicit' as const },
        };
        for (let index = 0; index < 32; index++)
          receipts.retain({ ...operation, key: createCommandKey() }, true);
        let refused = false;
        try {
          receipts.retain(operation, true);
        } catch {
          refused = true;
        }
        const stop = {
          ...operation,
          command: 'StopGoogleAcpSetup' as const,
          payload: { profileId: 'google-acp-v1' as const, operationId: operation.key },
        };
        receipts.retain(stop, true);
        receipts.load();
        return {
          refused,
          count: receipts.commands.length,
          last: receipts.commands.at(-1)?.command,
        };
      },
      {
        home,
        receipts: join(root, 'apps/desktop/src/main/receipts.ts'),
        client: join(root, 'packages/client/src/node.ts'),
        runtime: join(root, 'apps/desktop/src/main/runtime.ts'),
      },
    );
    assert.deepEqual(capacity, { refused: true, count: 33, last: 'StopGoogleAcpSetup' });
    assert.equal(pending.length, 0);
    await page.screenshot({
      path: join(internal, 'google-quota-controls.png'),
      animations: 'disabled',
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function conversationBridge(
  application: Awaited<ReturnType<typeof _electron.launch>>,
  page: Page,
) {
  const home = mkdtempSync(join(internal, 'chat-bridge-'));
  const socketPath = join(home, 'control.sock');
  const fixtures = createDemoFixtures();
  const id = createTestIds('2026-10-17T12:00:00.000Z', 9000n);
  const messageId = () => id('art').replace('art_', 'msg_');
  const profile = {
    ...unavailableNativeProfile().facts,
    model: 'fixture-model',
    available: true,
    reason: 'available',
  };
  const repositoryProfile = {
    ...unavailableRepositoryProfile().facts,
    available: true,
    reason: 'qualification-pending',
  };
  const route = { ...fixtures.snapshot.routes[0], model: 'fixture-model', fake: true };
  const snapshot = SnapshotSchema.parse({
    ...fixtures.snapshot,
    projects: [fixtures.snapshot.projects[0]],
    tasks: [],
    runs: [],
    attempts: [],
    approvals: [],
    routes: [route],
    nativeProfiles: [profile, repositoryProfile],
    nativeRuns: [],
    candidates: [],
    artifacts: [],
    evidence: [],
  });
  let state: TaskConversationState | null = null;
  const entries: ConversationEntry[] = [];
  let cursor = 0n;
  const received: Command[] = [];
  const receipts = new Map<string, CommandResult>();
  const sockets = new Set<Socket>();
  let questionId = '';
  let configureAttempts = 0;
  let heldNativeKey: Command['key'] | null = null;
  let workerPreparationKey: Command['key'] | null = null;
  let conversationStateReads = 0;
  let refuseWorkerAdoption = false;
  const modelObservation = { artifactId: id('art'), hash: 'c'.repeat(64) };
  const modelCatalog = [
    { model: 'fixture-model', efforts: ['low'], defaultEffort: 'low' },
    { model: 'fixture-next', efforts: ['low', 'high'], defaultEffort: 'high' },
  ];
  let refuseContextSend = true;
  let uncertainCapture = false;
  let holdContextRead = false;
  const heldContextReads: (() => void)[] = [];
  const captured = new Map<
    string,
    { artifact: { id: string; hash: string; bytes: number; mediaType: string }; content: Buffer }
  >();
  let runId = id('run');
  const attemptId = id('att');
  const at = '2026-10-17T12:00:00.000Z';
  const binding = () => ({
    taskId: snapshot.tasks[0].id,
    runId,
    attemptId,
    generation: 0,
    routeId: state?.configuration?.routeId ?? route.id,
    role: 'lead' as const,
    taskRevision: snapshot.tasks[0].revision,
    conversationRevision: 0,
    scopeHash: 'a'.repeat(64),
    limitMinutes: 5,
  });
  const append = (value: Record<string, unknown>) => {
    cursor += 1n;
    const entry = ConversationEntrySchema.parse({
      id: messageId(),
      taskId: snapshot.tasks[0].id,
      revision: snapshot.tasks[0].revision,
      cursor: cursor.toString(),
      at,
      ...value,
    });
    entries.push(entry);
    snapshot.cursor = cursor.toString();
    return entry;
  };
  const bump = () => {
    snapshot.tasks[0].revision += 1;
    if (state) state.revision = snapshot.tasks[0].revision;
  };
  let holdTaskPage = false;
  const heldTaskPages: (() => void)[] = [];
  const detailReads: Command[] = [];
  const response = (command: Command): CommandResult => {
    if (command.command === 'GetSnapshot') detailReads.push(command);
    const workspace = workspaceRead(snapshot, command);
    if (workspace) return workspace;
    if (command.command === 'GetSnapshot')
      return { outcome: 'applied', data: { kind: 'snapshot', snapshot } };
    if (command.command === 'Subscribe') return { outcome: 'applied' };
    if (command.command === 'GetArtifact') {
      const context = captured.get(command.payload.artifactId);
      assert(context);
      const offset = command.payload.offset;
      const chunk = context.content.subarray(offset, offset + command.payload.limit);
      return {
        outcome: 'applied',
        data: {
          kind: 'artifact',
          artifact: context.artifact,
          offset,
          content: chunk.toString('base64'),
          encoding: 'base64',
          eof: offset + chunk.length === context.content.length,
        },
      };
    }
    if (command.command === 'GetTaskConversationState') {
      conversationStateReads += 1;
      const observed = TaskConversationStateSchema.parse(state);
      if (refuseWorkerAdoption && observed.proposal)
        observed.proposal = { ...observed.proposal, id: messageId(), hash: 'd'.repeat(64) };
      return {
        outcome: 'applied',
        data: { kind: 'conversation-state', state: TaskConversationStateSchema.parse(observed) },
      };
    }
    if (command.command === 'GetTaskConversation') {
      const eligible = entries.filter(
        (entry) =>
          !command.payload.beforeCursor ||
          BigInt(entry.cursor) < BigInt(command.payload.beforeCursor),
      );
      const page = eligible.slice(-2);
      return {
        outcome: 'applied',
        data: {
          kind: 'conversation',
          taskId: command.payload.taskId,
          entries: page,
          nextBeforeCursor: eligible.length > page.length ? page[0].cursor : null,
        },
      };
    }
    if (command.command === 'InspectSource')
      return {
        outcome: 'applied',
        data: {
          kind: 'source',
          source: {
            projectId: fixtures.snapshot.projects[0].id,
            base: 'a'.repeat(40),
            branch: 'main',
            dirtyCount: 0,
            untrackedCount: 0,
          },
        },
      };
    if (command.command === 'GetChanges')
      return {
        outcome: 'applied',
        data: {
          kind: 'changes',
          taskId: command.payload.taskId,
          candidateId: null,
          artifactId: id('art'),
          files: [],
          diff: '',
          truncated: false,
        },
      };
    if (receipts.has(command.key)) {
      assert.deepEqual(
        command,
        received.find((prior) => prior.key === command.key),
      );
      if (command.command === 'ConfigureTaskConversation') received.push(command);
      return receipts.get(command.key) as CommandResult;
    }
    received.push(command);
    if (command.command === 'PrepareNativeRun') {
      if (command.payload.profileId === 'openai-repository-v1' && workerPreparationKey === null) {
        assert.equal(command.expectedRevision, snapshot.tasks[0].revision);
        assert.equal(command.payload.taskId, snapshot.tasks[0].id);
        workerPreparationKey = command.key;
        const result: CommandResult = {
          outcome: 'blocked',
          reason: 'Fixture repository preparation was not saved.',
          next: 'Fixture repository preparation was not saved.',
        };
        receipts.set(command.key, result);
        return result;
      }
      assert.equal(heldNativeKey, null);
      assert.equal(command.expectedRevision, snapshot.tasks[0].revision);
      assert.equal(command.payload.taskId, snapshot.tasks[0].id);
      heldNativeKey = command.key;
      receipts.set(command.key, {
        outcome: 'blocked',
        reason: 'Fixture preparation was not saved.',
      });
      return { outcome: 'outcome-unknown', reason: 'Fixture preparation reply is uncertain.' };
    }
    if (command.command === 'CaptureConversationContext') {
      assert.equal(command.expectedRevision, snapshot.projects[0].revision);
      assert.equal(command.payload.projectId, snapshot.projects[0].id);
      assert.equal(command.payload.base, 'a'.repeat(40));
      const selection = command.payload.selections[0];
      assert(selection.path.startsWith('/registered/project/'));
      const text = `Captured ${selection.kind} text.\n`;
      const bundle = ConversationContextBundleSchema.parse({
        version: 1,
        projectId: command.payload.projectId,
        base: command.payload.base,
        files: [
          {
            kind: selection.kind === 'log-file' ? 'log' : 'source',
            path:
              selection.kind === 'log-file'
                ? 'logs/project.log'
                : selection.kind === 'source-folder'
                  ? 'src/captured.ts'
                  : 'README.md',
            mode: '100644',
            hash: createHash('sha256').update(text).digest('hex'),
            bytes: Buffer.byteLength(text),
            text,
          },
        ],
      });
      const content = Buffer.from(canonicalJson(bundle));
      const artifact = {
        id: id('art'),
        hash: createHash('sha256').update(content).digest('hex'),
        bytes: content.length,
        mediaType: CONVERSATION_CONTEXT_MEDIA_TYPE,
      };
      captured.set(artifact.id, { artifact, content });
      snapshot.artifacts.push(artifact);
      const result: CommandResult = { outcome: 'applied', entity: artifact };
      receipts.set(command.key, result);
      if (uncertainCapture) {
        uncertainCapture = false;
        return {
          outcome: 'outcome-unknown',
          reason: 'The fixture saved context before its response was lost.',
        };
      }
      return result;
    }
    if (command.command === 'CreateTaskDiscussion') {
      assert.equal(command.expectedRevision, 0);
      assert.deepEqual(command.payload.planning.limits, {
        attempts: 4,
        minutes: 15,
        concurrency: 1,
      });
      assert.equal(command.payload.planning.creditPolicy, 'ordinary');
      assert.equal(command.payload.planning.modelRequest, undefined);
      const task = {
        ...fixtures.task,
        id: id('tsk'),
        title: 'Filtered invoice export',
        outcome: command.payload.text,
        criteria: ['Provisional discussion'],
        projectId: command.payload.projectId,
        revision: 1,
        runId,
      };
      snapshot.tasks = [task];
      const author = {
        kind: 'agent' as const,
        role: 'lead' as const,
        attemptId,
        routeId: state?.configuration?.routeId ?? route.id,
      };
      append({
        kind: 'user-message',
        author: { kind: 'user' },
        text: command.payload.text,
        ...(command.payload.context ? { context: command.payload.context } : {}),
      });
      const question = append({
        kind: 'question',
        author,
        binding: binding(),
        text: 'Should the CSV include a header row when no invoices match?',
      });
      questionId = question.id;
      const proposal = append({
        kind: 'plan-proposal',
        author,
        binding: binding(),
        text: 'The proposed invoice export stays within the selected scope.',
        proposal: {
          summary: 'Export the filtered invoices',
          criteria: ['Export only the visible filtered rows.'],
          slices: [
            {
              id: 'csv',
              title: 'Add the CSV action',
              role: 'coder',
              scope: ['src/invoices.ts'],
              dependsOn: [],
            },
          ],
          checks: ['Invoice export tests'],
        },
      });
      append({
        kind: 'agent-message',
        author,
        binding: binding(),
        text: 'Answer the scope question before adopting the plan.',
      });
      assert(proposal.kind === 'plan-proposal');
      state = TaskConversationStateSchema.parse({
        taskId: task.id,
        revision: task.revision,
        contractStatus: 'provisional',
        purpose: 'conversation',
        phase: 'discussion',
        configuration: {
          revision: 0,
          selection: command.payload.planning,
          routeId: state?.configuration?.routeId ?? route.id,
          requestedModel: 'fixture-model',
          effectiveModel: 'fixture-model',
          requestedEffort: 'low',
          effectiveEffort: 'low',
        },
        modelChoices: {
          status: 'last-observed',
          observation: modelObservation,
          observedAt: at,
          models: modelCatalog,
          reason: 'available',
        },
        currentRunId: runId,
        activeAttempt: null,
        budget: {
          limits: command.payload.planning.limits,
          remaining: command.payload.planning.limits,
        },
        queuedInputCount: 0,
        pendingQuestions: [{ id: question.id, cursor: question.cursor }],
        proposal: {
          id: proposal.id,
          hash: createHash('sha256').update(canonicalJson(proposal.proposal)).digest('hex'),
          runId,
          revision: task.revision,
        },
        adoptedProposal: null,
        send: { available: false, reason: 'pending-question', disposition: null },
        adopt: { available: false, reason: 'pending-question' },
      });
      receipts.set(command.key, { outcome: 'applied', entity: task });
      return { outcome: 'outcome-unknown' };
    }
    assert(state);
    assert('expectedRevision' in command);
    assert.equal(command.expectedRevision, snapshot.tasks[0].revision);
    if (command.command === 'AnswerTaskQuestion') {
      assert.equal(command.payload.questionId, questionId);
      bump();
      const answer = append({
        kind: 'answer',
        author: { kind: 'user' },
        replyTo: questionId,
        text: command.payload.text,
      });
      append({
        kind: 'input-delivery',
        author: { kind: 'controller' },
        replyTo: answer.id,
        binding: binding(),
        text: 'Included in input.',
      });
      state.pendingQuestions = [];
      state.phase = 'planned';
      state.send = { available: true, reason: 'available', disposition: 'turn' };
      state.adopt = { available: true, reason: 'available' };
    } else if (command.command === 'AdoptTaskPlan') {
      assert.equal(command.payload.proposalId, state.proposal?.id);
      assert.equal(command.payload.proposalHash, state.proposal?.hash);
      bump();
      state.contractStatus = 'confirmed';
      state.adoptedProposal = state.proposal;
      state.adopt = { available: true, reason: 'available' };
      snapshot.tasks[0].criteria = ['Export only the visible filtered rows.'];
    } else if (command.command === 'ConfigureTaskConversation') {
      configureAttempts += 1;
      if (configureAttempts === 1)
        return { outcome: 'blocked', reason: 'The fixture refused these settings.' };
      bump();
      assert(state.configuration);
      const requested = command.payload.planning.modelRequest;
      const nextRoute = {
        ...route,
        id: id('rte'),
        model: requested?.model ?? profile.model,
        effort: { requested: requested?.effort ?? 'low', effective: 'unknown', supported: [] },
      };
      snapshot.routes.push(nextRoute);
      runId = id('run');
      snapshot.tasks[0].runId = runId;
      snapshot.tasks[0].state = 'draft';
      state.currentRunId = runId;
      state.contractStatus = 'provisional';
      state.phase = 'discussion';
      state.proposal = null;
      state.adopt = { available: false, reason: 'proposal-missing' };
      state.configuration = {
        ...state.configuration,
        revision: state.configuration.revision + 1,
        selection: command.payload.planning,
        routeId: nextRoute.id,
        requestedModel: nextRoute.model,
        requestedEffort: nextRoute.effort.requested,
        effectiveModel: null,
        effectiveEffort: null,
      };
      const result: CommandResult = { outcome: 'applied', entity: snapshot.tasks[0] };
      receipts.set(command.key, result);
      return configureAttempts === 2
        ? {
            outcome: 'outcome-unknown',
            reason: 'The fixture saved settings before its response was lost.',
          }
        : result;
    } else if (command.command === 'SendTaskMessage') {
      if (command.payload.context?.length && refuseContextSend) {
        refuseContextSend = false;
        return { outcome: 'stale-revision', reason: 'The fixture refused a stale context send.' };
      }
      bump();
      append({
        kind: 'user-message',
        author: { kind: 'user' },
        text: command.payload.text,
        ...(command.payload.context ? { context: command.payload.context } : {}),
      });
      state.phase = 'planning';
      state.activeAttempt = {
        id: attemptId,
        runId,
        routeId: state?.configuration?.routeId ?? route.id,
        generation: 0,
        state: 'running',
        revision: 0,
      };
      state.send = { available: true, reason: 'queued-at-boundary', disposition: 'queue' };
      snapshot.tasks[0].state = 'running';
      const result: CommandResult = { outcome: 'applied', entity: snapshot.tasks[0] };
      receipts.set(command.key, result);
      return {
        outcome: 'outcome-unknown',
        reason: 'The fixture saved the input before its response was lost.',
      };
    } else if (command.command === 'QueueTaskGuidance') {
      bump();
      append({
        kind: 'guidance',
        author: { kind: 'user' },
        text: command.payload.text,
        ...(command.payload.context ? { context: command.payload.context } : {}),
      });
      state.queuedInputCount += 1;
    } else if (command.command === 'StopRun') {
      assert.equal(command.payload.runId, runId);
      bump();
      state.phase = 'stopped';
      state.activeAttempt = null;
      state.send = { available: true, reason: 'available', disposition: 'turn' };
      snapshot.tasks[0].state = 'stopped';
    } else throw new Error(`Unexpected conversation fixture command ${command.command}`);
    TaskConversationStateSchema.parse(state);
    const result: CommandResult = { outcome: 'applied', entity: snapshot.tasks[0] };
    receipts.set(command.key, result);
    return result;
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const decoder = new FrameDecoder();
    socket.on('data', (bytes) => {
      for (const message of decoder.push(bytes)) {
        if (message.type === 'hello')
          socket.write(encodeFrame({ type: 'welcome', protocol: 1, cursor: snapshot.cursor }));
        if (message.type === 'command') {
          const reply = () =>
            socket.write(
              encodeFrame({
                type: 'result',
                key: message.command.key,
                result: response(message.command),
              }),
            );
          if (
            holdTaskPage &&
            message.command.command === 'GetTaskPage' &&
            message.command.payload.after
          )
            heldTaskPages.push(reply);
          else if (holdContextRead && message.command.command === 'GetArtifact')
            heldContextReads.push(reply);
          else reply();
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try {
    const restoreRenderer = await pauseRenderer(application, page);
    await application.evaluate(
      async ({ BrowserWindow }, options) => {
        const load = process.mainModule?.require.bind(process.mainModule);
        if (!load) throw new Error('The desktop fixture module loader is unavailable.');
        const { installBridge } = load(
          options.bridge,
        ) as typeof import('../apps/desktop/src/main/bridge.ts');
        const { connectController } = load(
          options.client,
        ) as typeof import('../packages/client/src/node.ts');
        const { desktopActor } = load(
          options.runtime,
        ) as typeof import('../apps/desktop/src/main/runtime.ts');
        const client = await connectController({
          socketPath: options.socketPath,
          token: 'a'.repeat(64),
          actor: desktopActor,
          reconnectDelaysMs: [],
        });
        const window = BrowserWindow.getAllWindows()[0];
        window.once('closed', () => client.close());
        await installBridge(window, {
          paths: { home: options.home, profile: options.home },
          connect: async () => client,
          resetClient: () => client.close(),
        } as never);
      },
      {
        bridge: join(root, 'apps/desktop/src/main/bridge.ts'),
        client: join(root, 'packages/client/src/node.ts'),
        runtime: join(root, 'apps/desktop/src/main/runtime.ts'),
        socketPath,
        home,
      },
    );
    await restoreRenderer();
    if ((await page.locator('html').getAttribute('data-theme')) !== 'dark')
      await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message the primary role', exact: true });
    const nativeChoice = (paths: string[]) =>
      application.evaluate(({ dialog }, filePaths) => {
        const original = dialog.showOpenDialog;
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original;
          return { canceled: filePaths.length === 0, filePaths };
        };
      }, paths);
    const chooseContext = async (
      kind: 'Source file' | 'Source folder' | 'Project log',
      path: string,
    ) => {
      await page.getByRole('button', { name: 'Add context', exact: true }).click();
      await nativeChoice([path]);
      await page.getByRole('menuitem', { name: kind, exact: true }).click();
      await expect(
        page.getByRole('dialog', { name: 'Captured context', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('dialog')).toContainText('Selected planning recipient');
      await page.keyboard.press('Escape');
    };

    const expandNavigation = page.getByRole('button', { name: 'Expand sidebar', exact: true });
    if (await expandNavigation.isVisible()) await expandNavigation.click();
    await page.getByRole('button', { name: 'Plan with AI', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New goal', exact: true })).toBeVisible();
    const toolbar = page.getByRole('group', { name: 'Composer controls', exact: true });
    const modelControl = toolbar.getByRole('button', { name: /^Architect model:/ });
    await expect(modelControl).toHaveAttribute('aria-disabled', 'true');
    await expect(modelControl).not.toHaveAttribute('aria-label', /awaiting confirmation/);
    await modelControl.press('Enter');
    await expect(page.getByRole('tooltip')).toContainText(
      'Requested model fixture-model; effective model unknown.',
    );
    await page.keyboard.press('Escape');
    await toolbar
      .getByRole('button', { name: 'Planning permissions: Read-only conversation', exact: true })
      .press('Enter');
    await expect(page.getByRole('tooltip')).toContainText(
      'Execution permissions are set when preparing a run.',
    );
    await page.keyboard.press('Escape');
    assert.equal(
      received.some((command) => command.command === 'ConfigureTaskConversation'),
      false,
    );
    const contextMeter = page.getByRole('button', { name: /^Context window, usage unknown/ });
    await expect(contextMeter).toHaveAttribute('aria-label', 'Context window, usage unknown');
    await contextMeter.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(page.locator('.context-gauge-popover:popover-open')).toContainText(
      'Goal not sent.',
    );
    await page.keyboard.press('Escape');
    await composer.fill('Export the currently filtered invoices as CSV.');
    await page.getByRole('button', { name: 'Add context', exact: true }).click();
    await nativeChoice([]);
    await page.getByRole('menuitem', { name: 'Source file', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.equal(
      received.filter((command) => command.command === 'CaptureConversationContext').length,
      0,
    );
    await page.keyboard.press('Escape');
    await chooseContext('Source file', '/registered/project/README.md');
    await expect(page.getByRole('button', { name: /^Context 1 · 1 file ·/ })).toBeVisible();
    await page.getByRole('button', { name: /^Remove Context 1/ }).click();
    assert.equal(captured.size, 1);
    await chooseContext('Source folder', '/registered/project/src');
    await chooseContext('Project log', '/registered/project/logs/project.log');
    await expect(page.getByRole('button', { name: /^Remove Context/ })).toHaveCount(2);
    await page.reload();
    await page.getByRole('button', { name: 'Plan with AI', exact: true }).click();
    await expect(composer).toHaveValue('Export the currently filtered invoices as CSV.');
    await expect(page.getByRole('button', { name: /^Remove Context/ })).toHaveCount(2);

    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await page.getByRole('checkbox', { name: /^Allow bounded planning ·/ }).check();
    await composer.press('Enter');
    const firstReview = page.getByRole('dialog', {
      name: 'Review message and context',
      exact: true,
    });
    await expect(firstReview).toContainText('Captured source-folder text.');
    await expect(firstReview).toContainText('Captured log-file text.');
    await expect(firstReview).toContainText('Requested model fixture-model');
    assert.equal(
      received.filter((command) => command.command === 'CreateTaskDiscussion').length,
      0,
    );
    await firstReview.getByRole('button', { name: 'Send reviewed message', exact: true }).click();
    const createdWithContext = received.find(
      (command) => command.command === 'CreateTaskDiscussion',
    );
    assert(createdWithContext && createdWithContext.command === 'CreateTaskDiscussion');
    assert.equal(createdWithContext.payload.context?.length, 2);
    for (const ref of createdWithContext.payload.context ?? [])
      assert.equal(captured.get(ref.artifactId)?.artifact.hash, ref.hash);

    await expect(
      page.getByRole('button', { name: 'Retry exact command', exact: true }),
    ).toBeVisible();
    const pendingGoalDrafts = await page.evaluate(() =>
      localStorage.getItem('crewkite-context-drafts-v1'),
    );
    assert(pendingGoalDrafts);
    await page.evaluate((stored) => {
      const drafts = JSON.parse(stored);
      for (const draft of Object.values(drafts) as {
        sendReceipt?: { command: { payload: { text: string } } };
      }[])
        if (draft.sendReceipt) draft.sendReceipt.command.payload.text = 'A different goal.';
      localStorage.setItem('crewkite-context-drafts-v1', JSON.stringify(drafts));
    }, pendingGoalDrafts);
    await page.reload();
    await page.getByRole('button', { name: 'Plan with AI', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New goal', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Retry exact command', exact: true }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'does not match this draft' }).first(),
    ).toBeVisible();
    await expect(composer).toHaveValue('Export the currently filtered invoices as CSV.');
    assert.equal(
      received.filter((command) => command.command === 'CreateTaskDiscussion').length,
      1,
    );
    await page.evaluate(
      (stored) => localStorage.setItem('crewkite-context-drafts-v1', stored),
      pendingGoalDrafts,
    );
    await page.reload();
    await page.getByRole('button', { name: 'Plan with AI', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New goal', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Retry exact command', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New goal', exact: true })).toHaveCount(0);
    assert.equal(
      received.filter((command) => command.command === 'CreateTaskDiscussion').length,
      1,
    );
    assert.equal(await page.evaluate(() => localStorage.getItem('crewkite-goal-draft-v1')), '');
    const completedGoalDrafts = await page.evaluate(() =>
      localStorage.getItem('crewkite-context-drafts-v1'),
    );
    assert(
      !completedGoalDrafts || !JSON.parse(completedGoalDrafts)[`goal:${snapshot.projects[0].id}`],
    );

    await expect(page.getByRole('tab', { name: 'Conversation', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const publishTask = () => {
      cursor += 1n;
      snapshot.cursor = cursor.toString();
      const event = EventSchema.parse({
        protocol: 1,
        id: id('evt'),
        cursor: snapshot.cursor,
        at,
        taskId: snapshot.tasks[0].id,
        revision: snapshot.tasks[0].revision,
        type: 'task.updated',
        payload: snapshot.tasks[0],
      });
      for (const socket of sockets) socket.write(encodeFrame({ type: 'event', event }));
    };
    await page.getByRole('tab', { name: 'Plan', exact: true }).click();
    state = TaskConversationStateSchema.parse(state);
    bump();
    state.phase = 'planning';
    state.activeAttempt = {
      id: attemptId,
      runId,
      routeId: state?.configuration?.routeId ?? route.id,
      generation: 0,
      state: 'running',
      revision: 0,
    };
    publishTask();
    await expect(
      page.getByRole('heading', { name: 'Provisional task contract', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await expect(page.getByRole('log')).toHaveCount(0);
    await expect(contextMeter).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Plan', exact: true })).toBeFocused();
    await page.getByRole('tab', { name: 'Changes', exact: true }).click();
    bump();
    state.phase = 'discussion';
    state.activeAttempt = null;
    publishTask();
    await expect(
      page.getByRole('heading', { name: 'No retained changes to show', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
    await expect(page.getByRole('tab', { name: 'Changes', exact: true })).toBeFocused();
    await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Show pending question', exact: true }).click();
    await expect(page.locator(`#conversation-message-${questionId}`)).toBeFocused();
    const answer = page.getByRole('textbox', { name: 'Answer for Architect', exact: true });
    await answer.fill('Include the header row even for empty results.');
    const sendAnswer = page.getByRole('button', { name: 'Send answer', exact: true });
    await expect(sendAnswer).toBeEnabled();
    await page.getByRole('button', { name: 'Add context', exact: true }).click();
    await nativeChoice(['/registered/project/README.md']);
    holdContextRead = true;
    await page.getByRole('menuitem', { name: 'Source file', exact: true }).click();
    await expect.poll(() => heldContextReads.length).toBe(1);
    await expect(page.locator('.conversation-answer button[type="submit"]')).toBeDisabled();
    holdContextRead = false;
    for (const reply of heldContextReads.splice(0)) reply();
    await expect(page.getByRole('dialog', { name: 'Captured context', exact: true })).toContainText(
      'Captured source-file text.',
    );
    await page.keyboard.press('Escape');
    await expect(sendAnswer).toBeEnabled();
    await page.getByRole('button', { name: /^Remove Context/ }).click();

    await page.getByRole('tab', { name: 'Plan', exact: true }).click();
    await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Show pending question', exact: true }).click();
    await expect(answer).toHaveValue('Include the header row even for empty results.');
    await page.reload();
    await page.getByRole('button', { name: 'Show pending question', exact: true }).click();
    await expect(page.locator(`#conversation-message-${questionId}`)).toBeFocused();
    await expect(answer).toHaveValue('Include the header row even for empty results.');
    await page.getByRole('button', { name: 'Send answer', exact: true }).click();
    await expect(page.getByText('Included in input', { exact: true })).toBeVisible();
    const loadEarlier = page.getByRole('button', { name: 'Load earlier messages', exact: true });
    await expect(loadEarlier).toBeEnabled();
    await loadEarlier.scrollIntoViewIfNeeded();
    const anchor = await page.getByRole('log').evaluate((element) => {
      const row = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (row) => row.getBoundingClientRect().bottom > element.getBoundingClientRect().top,
      );
      if (!row) throw new Error('No visible history anchor.');
      return { id: row.dataset.messageId, top: row.getBoundingClientRect().top };
    });
    await loadEarlier.click();
    await expect(
      page.getByText('The proposed invoice export stays within the selected scope.', {
        exact: true,
      }),
    ).toHaveCount(1);
    await expect
      .poll(() =>
        page
          .locator(`[data-message-id="${anchor.id}"]`)
          .evaluate((row) => row.getBoundingClientRect().top),
      )
      .toBeCloseTo(anchor.top, 0);
    await expect(
      page
        .getByRole('region', { name: 'Task summary', exact: true })
        .getByText('Export the currently filtered invoices as CSV.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Adopt plan', exact: true })).toBeEnabled();
    assert.equal(
      received.some((command) =>
        ['PrepareRun', 'StartRun', 'PrepareNativeRun'].includes(command.command),
      ),
      false,
    );
    await page.getByRole('button', { name: 'Adopt plan', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'Choose execution provider', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    const beforePolicySelection = TaskConversationStateSchema.parse(state).configuration?.selection;
    const policyControl = toolbar.getByRole('button', {
      name: 'Future execution policy: Not prepared',
      exact: true,
    });
    const choosePolicy = async (authority: 'Guided' | 'Balanced' | 'Autopilot') => {
      await policyControl.click();
      await page.getByRole('menuitemradio', { name: authority, exact: true }).click();
      const chooser = page.getByRole('dialog', { name: 'Choose execution provider', exact: true });
      await expect(chooser).toBeVisible();
      await expect(
        chooser.getByRole('combobox', { name: 'Execution authority', exact: true }),
      ).toHaveValue(authority.toLowerCase());
      await expect(chooser.getByRole('combobox', { name: 'Provider', exact: true })).toHaveValue(
        'openai',
      );
      await expect(chooser.getByRole('combobox', { name: 'Scope', exact: true })).toHaveValue(
        'repository',
      );
      await expect(
        chooser.getByRole('combobox', { name: 'Scope', exact: true }).locator('option'),
      ).toHaveText(['Project']);
      await expect(chooser.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
        'fixture-model',
      );
      await expect(
        chooser.getByRole('combobox', { name: 'Model', exact: true }).locator('option'),
      ).toHaveText(['fixture-model', 'fixture-next']);
      return chooser;
    };
    await choosePolicy('Balanced');
    await page.keyboard.press('Escape');
    await choosePolicy('Guided');
    await page.keyboard.press('Escape');
    const staleChooser = await choosePolicy('Autopilot');
    state = TaskConversationStateSchema.parse(state);
    assert(state.configuration);
    state.configuration.revision += 1;
    bump();
    publishTask();
    await expect(staleChooser).toHaveCount(0);
    await expect(
      page.getByText(
        'The task or planning configuration changed. The execution draft was discarded. Review the current task before preparing again.',
        { exact: true },
      ),
    ).toBeVisible();
    await choosePolicy('Balanced');
    await page.keyboard.press('Escape');
    assert.equal(
      received.some((command) =>
        [
          'PrepareRun',
          'PrepareNativeRun',
          'PrepareCombinedRun',
          'StartRun',
          'ResolveApproval',
        ].includes(command.command),
      ),
      false,
    );
    assert.deepEqual(
      TaskConversationStateSchema.parse(state).configuration?.selection,
      beforePolicySelection,
    );
    const refusedWorkerChooser = await choosePolicy('Balanced');
    const readsBeforeRefusal = conversationStateReads;
    await refusedWorkerChooser.getByText('Use the adopted project plan', { exact: true }).click();
    refuseWorkerAdoption = true;
    await refusedWorkerChooser
      .getByRole('button', { name: 'Prepare adopted project plan', exact: true })
      .click();
    await expect.poll(() => conversationStateReads).toBeGreaterThan(readsBeforeRefusal);
    await expect(
      page.getByText(
        'The adopted plan changed. Review and adopt the current plan before preparing.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Repository work', exact: true })).toHaveCount(0);
    assert.equal(
      received.some((command) => command.command === 'PrepareNativeRun'),
      false,
    );
    refuseWorkerAdoption = false;
    await page.keyboard.press('Escape');
    const workerChooser = await choosePolicy('Balanced');
    await workerChooser
      .getByRole('combobox', { name: 'Model', exact: true })
      .selectOption('fixture-next');
    await workerChooser.getByRole('combobox', { name: 'Effort', exact: true }).selectOption('high');
    const adoptedState = TaskConversationStateSchema.parse(state);
    assert.equal(adoptedState.contractStatus, 'confirmed');
    assert(adoptedState.adoptedProposal);
    assert.deepEqual(adoptedState.adoptedProposal, adoptedState.proposal);
    assert.equal(adoptedState.adoptedProposal.runId, snapshot.tasks[0].runId);
    const adoptedCriteria = [...snapshot.tasks[0].criteria];
    const readsBeforeWorkerChoice = conversationStateReads;
    await workerChooser.getByText('Use the adopted project plan', { exact: true }).click();
    await workerChooser
      .getByRole('button', { name: 'Prepare adopted project plan', exact: true })
      .click();
    await expect.poll(() => conversationStateReads).toBeGreaterThan(readsBeforeWorkerChoice);
    const workerNative = page.getByRole('dialog', { name: 'Repository work', exact: true });
    await expect(workerNative).toBeVisible();
    await expect(workerNative.getByText('OpenAI', { exact: true })).toBeVisible();
    await expect(
      workerNative.getByRole('combobox', { name: 'Execution authority', exact: true }),
    ).toHaveValue('balanced');
    await expect(
      workerNative.getByRole('textbox', { name: 'File to edit', exact: true }),
    ).toHaveCount(0);
    const prepareWorker = workerNative.getByRole('button', {
      name: 'Review task',
      exact: true,
    });
    const workerPermission = workerNative.getByRole('checkbox', {
      name: 'Allow OpenAI to read this project, edit a separate working copy, and run local commands using my signed-in client',
      exact: true,
    });
    await expect(workerPermission).not.toBeChecked();
    await expect(
      workerNative.getByRole('checkbox', {
        name: 'Trust the existing native client and login',
        exact: true,
      }),
    ).toHaveCount(0);
    await workerNative.getByText('Details', { exact: true }).click();
    await expect(
      workerNative.getByRole('checkbox', {
        name: 'Allow local commands for this run',
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      workerNative.getByRole('checkbox', {
        name: 'Allow existing credits after included usage',
        exact: true,
      }),
    ).not.toBeChecked();
    await expect(prepareWorker).toBeDisabled();
    await workerPermission.check();
    await expect(prepareWorker).toBeEnabled();
    assert.equal(
      received.some((command) =>
        ['PrepareRun', 'PrepareNativeRun', 'PrepareCombinedRun', 'StartRun'].includes(
          command.command,
        ),
      ),
      false,
    );
    const workerRevision = snapshot.tasks[0].revision;
    await prepareWorker.click();
    await expect(
      workerNative.getByText('Fixture repository preparation was not saved.', { exact: true }),
    ).toBeVisible();
    assert(workerPreparationKey);
    const workerPreparation = received.find((command) => command.key === workerPreparationKey);
    assert(workerPreparation?.command === 'PrepareNativeRun');
    assert.equal(workerPreparation.expectedRevision, workerRevision);
    assert.equal(workerPreparation.payload.taskId, adoptedState.taskId);
    assert.equal(workerPreparation.payload.profileId, 'openai-repository-v1');
    assert.equal(workerPreparation.payload.policy.authority, 'balanced');
    assert.equal(workerPreparation.payload.policy.quality, 'quick');
    assert.deepEqual(workerPreparation.payload.policy.methods, [
      { id: 'keep-it-simple', cycles: 1, reviewerRole: 'reviewer' },
    ]);
    assert(
      workerPreparation.payload.policy.effects.some(
        (grant) => grant.action === 'write-scratch' && grant.usesRemaining === 1,
      ),
    );
    assert(
      workerPreparation.payload.policy.effects.some(
        (grant) => grant.action === 'run-native-tools' && grant.usesRemaining === 1,
      ),
    );
    assert.deepEqual(workerPreparation.payload.policy.limits, {
      attempts: 3,
      minutes: 5,
      concurrency: 1,
    });
    assert.equal(workerPreparation.payload.consent, 'explicit');
    assert.equal(workerPreparation.payload.creditPolicy, 'ordinary');
    assert('modelRequest' in workerPreparation.payload);
    assert.deepEqual(workerPreparation.payload.modelRequest, {
      version: 1,
      observation: modelObservation,
      model: 'fixture-next',
      effort: 'high',
    });
    assert.deepEqual(Object.keys(workerPreparation.payload).sort(), [
      'consent',
      'creditPolicy',
      'modelRequest',
      'policy',
      'profileId',
      'taskId',
    ]);
    assert.deepEqual(
      workerPreparation.payload.policy.effects.map(({ action, target, taskId }) => ({
        action,
        target,
        taskId,
      })),
      [
        { action: 'write-scratch', target: snapshot.projects[0].name, taskId: adoptedState.taskId },
        { action: 'export-patch', target: adoptedState.taskId, taskId: adoptedState.taskId },
        {
          action: 'run-native-tools',
          target: snapshot.projects[0].name,
          taskId: adoptedState.taskId,
        },
      ],
    );
    assert.deepEqual(snapshot.tasks[0].criteria, adoptedCriteria);
    assert.deepEqual(
      TaskConversationStateSchema.parse(state).adoptedProposal,
      adoptedState.adoptedProposal,
    );
    assert.equal(snapshot.attempts.length, 0);
    assert.equal(
      received.some((command) => command.command === 'StartRun'),
      false,
    );
    await workerNative.getByRole('button', { name: 'Cancel', exact: true }).click();
    if (await page.getByRole('button', { name: 'Dismiss error', exact: true }).count())
      await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    const pendingChooser = await choosePolicy('Balanced');
    await pendingChooser.getByRole('button', { name: 'Start task', exact: true }).click();
    const seededNative = page.getByRole('dialog', { name: 'Repository work', exact: true });
    await expect(
      seededNative.getByRole('combobox', { name: 'Execution authority', exact: true }),
    ).toHaveValue('balanced');
    await expect(
      seededNative.getByRole('textbox', { name: 'File to edit', exact: true }),
    ).toHaveCount(0);
    await seededNative
      .getByRole('checkbox', {
        name: 'Allow OpenAI to read this project, edit a separate working copy, and run local commands using my signed-in client',
        exact: true,
      })
      .check();
    await seededNative.getByRole('button', { name: 'Review task', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Retry exact command', exact: true }).first(),
    ).toBeVisible();
    assert(heldNativeKey);
    const explicitPreparation = received.find((command) => command.key === heldNativeKey);
    assert(explicitPreparation?.command === 'PrepareNativeRun');
    assert.equal(explicitPreparation.payload.policy.authority, 'balanced');
    assert.equal(explicitPreparation.payload.consent, 'explicit');
    assert.equal(explicitPreparation.payload.profileId, 'openai-repository-v1');
    assert.equal('targetPath' in explicitPreparation.payload, false);
    await seededNative.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page
      .locator('.task-actions')
      .getByRole('button', { name: 'Prepare run', exact: true })
      .click();
    await expect(pendingChooser).toBeVisible();
    await expect(
      pendingChooser.getByRole('combobox', { name: 'Execution authority', exact: true }),
    ).toHaveValue('balanced');
    assert.equal(received.filter((command) => command.key === heldNativeKey).length, 1);
    assert.equal(received.filter((command) => command.command === 'PrepareNativeRun').length, 2);
    await pendingChooser.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Retry exact command', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Retry exact command', exact: true }),
    ).toHaveCount(0);
    await page
      .locator('.task-actions')
      .getByRole('button', { name: 'Prepare run', exact: true })
      .click();
    await expect(pendingChooser).toBeVisible();
    await expect(
      pendingChooser.getByRole('combobox', { name: 'Execution authority', exact: true }),
    ).toHaveValue('guided');
    await pendingChooser.getByRole('button', { name: 'Cancel', exact: true }).click();
    if (await page.getByRole('button', { name: 'Dismiss error', exact: true }).count())
      await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();

    const beforeModel = TaskConversationStateSchema.parse(state);
    assert(beforeModel.configuration);
    const originalSelection = beforeModel.configuration.selection;
    const originalBudget = beforeModel.budget;
    const originalTaskRevision = snapshot.tasks[0].revision;
    // Earlier saved history appears with the settings refresh.
    for (const text of [
      'Scope checked.',
      'Limits checked.',
      'The next planning turn uses the saved limits.',
    ])
      append({
        kind: 'agent-message',
        author: {
          kind: 'agent',
          role: 'lead',
          attemptId,
          routeId: state?.configuration?.routeId ?? route.id,
        },
        binding: binding(),
        text,
      });
    await toolbar
      .getByRole('button', { name: 'Architect model: fixture-model', exact: true })
      .click();
    await page.getByRole('menuitemradio', { name: 'fixture-next', exact: true }).click();
    const session = page.getByRole('dialog', { name: 'Session settings', exact: true });
    await expect(
      session.getByRole('combobox', { name: 'Planning model', exact: true }),
    ).toHaveValue('fixture-next');
    await expect(
      session.getByRole('combobox', { name: 'Planning effort', exact: true }),
    ).toHaveValue('high');
    await session
      .getByRole('combobox', { name: 'Planning model', exact: true })
      .selectOption('fixture-model');
    await expect(
      session.getByRole('combobox', { name: 'Planning effort', exact: true }),
    ).toHaveValue('low');
    await session
      .getByRole('combobox', { name: 'Planning model', exact: true })
      .selectOption('fixture-next');
    await expect(
      session.getByRole('combobox', { name: 'Planning effort', exact: true }),
    ).toHaveValue('high');
    await session
      .getByRole('combobox', { name: 'Planning effort', exact: true })
      .selectOption('low');
    assert.equal(configureAttempts, 0);
    assert.equal(snapshot.tasks[0].revision, originalTaskRevision);
    await page
      .getByRole('dialog')
      .getByRole('checkbox', {
        name: 'Allow bounded planning with this profile and these limits',
        exact: true,
      })
      .check();
    await page.getByRole('button', { name: 'Save planning settings', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText(
      'The fixture refused these settings.',
    );
    await expect(
      page.getByRole('dialog').getByRole('checkbox', {
        name: 'Allow bounded planning with this profile and these limits',
        exact: true,
      }),
    ).toBeChecked();
    await page.getByRole('button', { name: 'Save planning settings', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText(
      'The fixture saved settings before its response was lost.',
    );
    await page.getByRole('button', { name: 'Retry exact settings command', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.equal(configureAttempts, 2);
    const savedCommands = received.filter(
      (command) => command.command === 'ConfigureTaskConversation',
    );
    assert.equal(savedCommands.length, 3);
    assert.deepEqual(savedCommands[2], savedCommands[1]);
    assert.equal(savedCommands[1].expectedRevision, originalTaskRevision);
    assert.deepEqual(savedCommands[1].payload, {
      taskId: snapshot.tasks[0].id,
      planning: {
        ...originalSelection,
        consent: 'explicit',
        modelRequest: {
          version: 1,
          observation: modelObservation,
          model: 'fixture-next',
          effort: 'low',
        },
      },
    });
    const savedModel = TaskConversationStateSchema.parse(state);
    assert.equal(savedModel.configuration?.requestedModel, 'fixture-next');
    assert.equal(savedModel.configuration?.requestedEffort, 'low');
    assert.equal(savedModel.configuration?.effectiveModel, null);
    assert.equal(savedModel.configuration?.effectiveEffort, null);
    assert.notEqual(savedModel.currentRunId, beforeModel.currentRunId);
    assert.deepEqual(savedModel.modelChoices, beforeModel.modelChoices);
    assert.deepEqual(savedModel.budget, originalBudget);
    await toolbar
      .getByRole('button', { name: 'Architect effort: low (requested)', exact: true })
      .click();
    await page.getByRole('menuitemradio', { name: 'high', exact: true }).click();
    await expect(
      session.getByRole('combobox', { name: 'Planning model', exact: true }),
    ).toHaveValue('fixture-next');
    await expect(
      session.getByRole('combobox', { name: 'Planning effort', exact: true }),
    ).toHaveValue('high');
    await expect(
      session.getByRole('button', { name: 'Save planning settings', exact: true }),
    ).toBeDisabled();
    await session
      .getByRole('checkbox', {
        name: 'Allow bounded planning with this profile and these limits',
        exact: true,
      })
      .check();
    await session.getByRole('button', { name: 'Save planning settings', exact: true }).click();
    await expect(session).toHaveCount(0);
    assert.equal(configureAttempts, 3);
    const savedEffort = TaskConversationStateSchema.parse(state);
    assert.deepEqual(savedEffort.configuration?.selection.modelRequest, {
      version: 1,
      observation: modelObservation,
      model: 'fixture-next',
      effort: 'high',
    });
    assert.equal(savedEffort.configuration?.effectiveModel, null);
    assert.equal(savedEffort.configuration?.effectiveEffort, null);
    assert.equal(savedEffort.contractStatus, 'provisional');
    assert.equal(savedEffort.phase, 'discussion');
    assert.equal(savedEffort.proposal, null);
    assert.deepEqual(savedEffort.adopt, { available: false, reason: 'proposal-missing' });
    await expect(policyControl).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('button', { name: 'Prepare run', exact: true })).toHaveCount(0);
    await page.getByText('Task details', { exact: true }).click();
    await expect(
      page.getByText(
        'Newer saved messages were loaded. Load earlier messages to restore the previous history.',
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByText('Task details', { exact: true }).click();
    await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
    await expect(page.getByText('Scope checked.', { exact: true })).toBeAttached();
    uncertainCapture = true;
    await page.getByRole('button', { name: 'Add context', exact: true }).click();
    await nativeChoice(['/registered/project/README.md']);
    await page.getByRole('menuitem', { name: 'Source file', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
      'capture outcome is uncertain',
    );
    const pendingCapture = received.findLast(
      (command) => command.command === 'CaptureConversationContext',
    );
    assert(pendingCapture && pendingCapture.command === 'CaptureConversationContext');
    const beforeWrongRetry = received.length;
    assert.match(
      await page.evaluate(
        async (input) => {
          try {
            await window.crewkite?.retryConversationContext?.(input);
            return '';
          } catch (failure) {
            return String(failure);
          }
        },
        { receiptId: pendingCapture.key, projectId: snapshot.projects[0].id, base: 'b'.repeat(40) },
      ),
      /does not match this draft/,
    );
    assert.match(
      await page.evaluate(async () => {
        try {
          await window.crewkite?.retryCommand?.({ command: 'GetHealth', payload: {} });
          return '';
        } catch (failure) {
          return String(failure);
        }
      }),
      /does not match this draft/,
    );
    assert.match(
      await page.evaluate(
        async (input) => {
          try {
            await window.crewkite?.command({
              command: 'CaptureConversationContext',
              expectedRevision: 0,
              payload: {
                projectId: input.projectId,
                base: input.base,
                selections: [{ kind: 'source-file', path: '/forged' }],
              },
            });
            return '';
          } catch (failure) {
            return String(failure);
          }
        },
        { projectId: snapshot.projects[0].id, base: 'a'.repeat(40) },
      ),
      /native-only action/,
    );
    assert.equal(received.length, beforeWrongRetry);
    await page.reload();
    await page.getByText('Task details', { exact: true }).click();
    await page.getByRole('button', { name: 'Retry exact command', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Captured context', exact: true })).toContainText(
      'Captured source-file text.',
    );
    await page.keyboard.press('Escape');
    assert.equal(received.filter((command) => command.key === pendingCapture.key).length, 1);
    uncertainCapture = true;
    await page.getByRole('button', { name: 'Add context', exact: true }).click();
    await nativeChoice(['/registered/project/README.md']);
    await page.getByRole('menuitem', { name: 'Source file', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
      'capture outcome is uncertain',
    );
    await page.evaluate(async () => {
      await window.crewkite?.retryCommand?.();
    });
    await page.reload();
    await page.getByText('Task details', { exact: true }).click();
    await page.getByRole('button', { name: 'Choose context again', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Retry exact context capture', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Remove Context/ })).toHaveCount(1);
    await composer.fill('Keep the execution permissions unchanged.');
    await composer.press('Enter');
    bump();
    publishTask();
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Send reviewed message', exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole('dialog')).toContainText(
      'The recipient, draft context or task changed.',
    );
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(composer).toHaveValue('Keep the execution permissions unchanged.');
    await expect(page.getByRole('button', { name: /^Remove Context/ })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await composer.press('Enter');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Send reviewed message', exact: true })
      .click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
      'The fixture refused a stale context send.',
    );
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /^Remove Context/ })).toHaveCount(1);
    await composer.press('Enter');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Send reviewed message', exact: true })
      .click();

    await expect(
      page.getByRole('button', { name: 'Retry exact command', exact: true }),
    ).toBeVisible();
    await expect(composer).toHaveValue('Keep the execution permissions unchanged.');
    const originalSend = received.find(
      (command) => command.command === 'SendTaskMessage' && receipts.has(command.key),
    );
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Retry exact command', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(composer).toHaveValue('');
    await expect(page.getByRole('button', { name: /^Remove Context/ })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Retry exact command', exact: true }),
    ).toHaveCount(0);
    assert(originalSend && receipts.has(originalSend.key));
    assert.equal(received.filter((command) => command.command === 'SendTaskMessage').length, 2);
    await expect(contextMeter).toHaveAttribute(
      'aria-label',
      'Context window, usage unknown, updating',
    );
    await contextMeter.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(page.locator('.context-gauge-popover:popover-open')).toContainText(
      'The primary role is planning.',
    );
    await page.keyboard.press('Escape');
    await page.reload();
    const savedContext = page.getByRole('button', { name: /^Captured context 1 ·/ }).last();
    await savedContext.click();
    await expect(page.getByRole('dialog')).toContainText('Captured source-file text.');
    await expect(page.getByRole('dialog')).not.toContainText('Selected planning recipient');
    await page.keyboard.press('Escape');
    await chooseContext('Project log', '/registered/project/logs/project.log');
    await composer.fill('Do not add a new provider.');
    await composer.press('Enter');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Send reviewed message', exact: true })
      .click();
    const queuedContext = received.find((command) => command.command === 'QueueTaskGuidance');
    assert(
      queuedContext &&
        queuedContext.command === 'QueueTaskGuidance' &&
        queuedContext.payload.context?.length === 1,
    );
    await expect(
      page.getByText('Queued for the next planning turn', { exact: true }).last(),
    ).toBeVisible();
    for (let index = 0; index < 51; index++)
      snapshot.tasks.push({
        ...snapshot.tasks[0],
        id: id('tsk'),
        title: `Retained navigation ${index}`,
      });
    publishTask();
    const moreTasks = page.getByRole('button', { name: 'Load more tasks', exact: true });
    await expect(moreTasks).toBeVisible();
    holdTaskPage = true;
    await moreTasks.click();
    await expect.poll(() => heldTaskPages.length).toBe(1);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
    await expect(page.getByText('Stopped', { exact: true }).last()).toBeVisible();
    holdTaskPage = false;
    for (const release of heldTaskPages.splice(0)) release();
    await expect(moreTasks).toHaveCount(0);
    await expect(
      page.locator('.task-link').filter({ hasText: 'Retained navigation 50' }),
    ).toBeVisible();

    await expect(contextMeter).toHaveAttribute('aria-label', 'Context window, usage unknown');
    await chooseContext('Source folder', '/registered/project/src');
    await composer.fill('Keep this unsent draft.');
    await page.getByRole('tab', { name: 'Plan', exact: true }).click();
    await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
    await expect(composer).toHaveValue('Keep this unsent draft.');
    assert(detailReads.length > 0);
    assert(
      detailReads.every(
        (command) => command.command === 'GetSnapshot' && 'taskId' in command.payload,
      ),
    );
    const mutations = received.length;
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Conversation', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByText('Do not add a new provider.', { exact: true })).toBeVisible();
    await expect(composer).toHaveValue('Keep this unsent draft.');
    await expect(page.getByRole('button', { name: /^Remove Context/ })).toHaveCount(1);
    assert.equal(received.length, mutations);
    assert.equal(
      received.some(
        (command) =>
          ['PrepareRun', 'StartRun', 'AcceptCandidate'].includes(command.command) ||
          (command.command === 'PrepareNativeRun' &&
            command.key !== heldNativeKey &&
            command.key !== workerPreparationKey),
      ),
      false,
    );
    state = TaskConversationStateSchema.parse(state);
    assert(state.configuration?.selection.modelRequest);
    assert(state.modelChoices);
    const beforeDefaultSelection = structuredClone(state.configuration.selection);
    const beforeDefaultBudget = structuredClone(state.budget);
    const beforeDefaultAttempts = snapshot.attempts.length;
    const beforeDefaultPreparations = received.filter(
      (command) => command.command === 'PrepareNativeRun',
    ).length;
    state.modelChoices.status = 'client-changed';
    state.modelChoices.reason = 'client-changed';
    bump();
    publishTask();
    await expect(modelControl).toHaveAttribute('aria-disabled', 'true');
    await page.getByRole('button', { name: 'Open session settings', exact: true }).click();
    await expect(session).toContainText('The installed client changed.');
    await session.getByRole('button', { name: 'Use profile default', exact: true }).click();
    await expect(
      session.getByRole('checkbox', {
        name: 'Allow bounded planning with this profile and these limits',
        exact: true,
      }),
    ).not.toBeChecked();
    await session
      .getByRole('checkbox', {
        name: 'Allow bounded planning with this profile and these limits',
        exact: true,
      })
      .check();
    await session.getByRole('button', { name: 'Save planning settings', exact: true }).click();
    await expect(session).toHaveCount(0);
    const defaultCommand = received.findLast(
      (command) => command.command === 'ConfigureTaskConversation',
    );
    assert(defaultCommand?.command === 'ConfigureTaskConversation');
    const { modelRequest: omittedRequest, ...defaultSelection } = beforeDefaultSelection;
    assert(omittedRequest);
    assert.deepEqual(defaultCommand.payload.planning, defaultSelection);
    assert.equal('modelRequest' in defaultCommand.payload.planning, false);
    assert.deepEqual(state.budget, beforeDefaultBudget);
    await expect(composer).toHaveValue('Keep this unsent draft.');
    await expect(page.getByRole('button', { name: /^Remove Context/ })).toHaveCount(1);
    assert.equal(snapshot.attempts.length, beforeDefaultAttempts);
    assert.equal(
      received.filter((command) => command.command === 'PrepareNativeRun').length,
      beforeDefaultPreparations,
    );

    state = TaskConversationStateSchema.parse(state);
    bump();
    state.phase = 'discussion';
    state.send = { available: false, reason: 'pending-question', disposition: null };
    const manyQuestions = Array.from({ length: 100 }, (_, index) =>
      append({
        kind: 'question',
        author: {
          kind: 'agent',
          role: 'lead',
          attemptId,
          routeId: state?.configuration?.routeId ?? route.id,
        },
        binding: binding(),
        text: `Saved question ${index + 1}`,
      }),
    );
    state.pendingQuestions = manyQuestions.map(({ id, cursor }) => ({ id, cursor }));
    publishTask();
    await page.setViewportSize({ width: 1440, height: 700 });
    const questionSelect = page.getByRole('combobox', { name: 'Pending question', exact: true });
    await expect(questionSelect.locator('option')).toHaveCount(100);
    await expect(questionSelect).toBeEnabled();
    await expect(
      page.getByRole('button', { name: 'Show pending question', exact: true }),
    ).toHaveCount(1);
    const questionBounds = await questionSelect.boundingBox();
    assert(
      questionBounds &&
        questionBounds.height < 80 &&
        questionBounds.y + questionBounds.height < 700,
    );
    assert(await page.getByRole('log').evaluate((element) => element.clientHeight > 0));
    await questionSelect.selectOption(manyQuestions[99].id);
    bump();
    publishTask();
    await expect(questionSelect).toBeEnabled();
    await expect(questionSelect).toHaveValue(manyQuestions[99].id);
    await page.getByRole('button', { name: 'Show pending question', exact: true }).click();
    await expect(page.locator(`#conversation-message-${manyQuestions[99].id}`)).toBeFocused();
    bump();
    state.pendingQuestions = state.pendingQuestions.slice(0, 99);
    publishTask();
    await expect(questionSelect).toHaveValue(manyQuestions[0].id);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: join(internal, 'conversation-bridge-dark.png'),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
    await page.screenshot({
      path: join(internal, 'conversation-bridge-light.png'),
      animations: 'disabled',
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function taskActivityHistory(
  application: Awaited<ReturnType<typeof _electron.launch>>,
  page: Page,
) {
  const home = mkdtempSync(join(internal, 'activity-history-'));
  const at = '2026-10-18T00:00:00.000Z';
  const id = createTestIds(at, 1000n);
  const fixture = createDemoFixtures(at);
  const invalidProject = join(home, 'invalid-project-choice');
  const validProject = join(home, 'recovery-project');
  mkdirSync(invalidProject);
  mkdirSync(validProject);
  git(validProject, ['init', '--quiet']);
  const legacyRegistration = CommandSchema.parse({
    protocol: 1,
    key: createCommandKey(),
    actor: { id: 'desktop', kind: 'desktop' },
    command: 'RegisterProject',
    expectedRevision: 0,
    payload: { path: invalidProject },
  });
  const retainedRegistration = new CommandReceipts(home, home);
  retainedRegistration.retain(legacyRegistration, true);
  const registrationRequests: Command[] = [];

  const task = { ...fixture.task, id: id('tsk'), title: 'Read retained task activity' };
  const other = { ...task, id: id('tsk'), title: 'Inspect a different history' };
  const empty = { ...task, id: id('tsk'), title: 'Inspect an empty history' };
  const blocked = { ...task, id: id('tsk'), title: 'Inspect a blocked history' };
  const retainedTasks = [
    task,
    other,
    empty,
    blocked,
    ...Array.from({ length: 300 }, (_, index) => ({
      ...task,
      id: id('tsk'),
      title: `Retained workspace task ${String(index).padStart(3, '0')}`,
      outcome: 'x'.repeat(4096),
    })),
  ];
  const lastRetainedTask = retainedTasks.at(-1);
  assert(lastRetainedTask);
  const options = {
    home,
    now: () => at,
    id,
    nativeProfiles: () => [],
    googleUsageClient: () => ({ available: false as const, reason: 'client-unavailable' as const }),
    registerGoogleAcp: false,
    localInputHelper: undefined,
  };
  let runtime = await startController(options);
  let heldRange:
    | {
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  let startupDetail:
    | {
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  const startupConversation = Promise.withResolvers<void>();
  let rangeReads = 0;
  let failNextRange = false;
  const requests: Array<Extract<Command, { command: 'GetTaskActivityPage' }>> = [];
  let held:
    | {
        taskId: string;
        older: boolean;
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  const instrument = () => {
    const execute = runtime.controller.execute.bind(runtime.controller);
    runtime.controller.execute = async (input, principal) => {
      const command = CommandSchema.parse(input);
      if (command.command === 'RegisterProject') registrationRequests.push(command);
      if (command.command === 'GetSnapshot')
        assert(
          'taskId' in command.payload,
          'Large workspace clients must read selected task detail only.',
        );
      if (command.command === 'GetTaskConversationState' && startupDetail)
        startupConversation.resolve();
      const result = await execute(command, principal);
      if (command.command === 'GetSnapshot' && startupDetail) {
        startupDetail.entered.resolve();
        await startupDetail.release.promise;
      }
      if (command.command === 'GetArtifactRange') {
        rangeReads++;
        if (failNextRange) {
          failNextRange = false;
          return { outcome: 'blocked', reason: 'fixture-output-range-failed' };
        }
        const waiting = heldRange;
        if (waiting) {
          heldRange = undefined;
          waiting.entered.resolve();
          await waiting.release.promise;
        }
      }
      if (command.command === 'GetTaskActivityPage') {
        requests.push(command);
        const waiting = held;
        if (
          waiting &&
          command.payload.taskId === waiting.taskId &&
          Boolean(command.payload.beforeCursor) === waiting.older
        ) {
          held = undefined;
          waiting.entered.resolve();
          await waiting.release.promise;
        }
      }
      return result;
    };
  };
  instrument();
  const controllerReceipt = () => runtime.controller.store.receipt(legacyRegistration.key);
  const append = (taskId: string | null, text: string) =>
    runtime.controller.store.transaction(() =>
      runtime.controller.store.append({
        protocol: 1,
        id: id('evt'),
        taskId,
        at,
        revision: 0,
        type: 'attempt.output',
        payload: { attemptId: id('att'), generation: 1, channel: 'stdout', text },
      }),
    );
  const marker = (index: number) => `Retained activity ${String(index).padStart(4, '0')}`;
  const original: Event[] = [];
  runtime.controller.store.transaction(() => {
    const project = fixture.snapshot.projects[0];
    runtime.controller.store.put('project', project.id, project.revision, project);
    for (const value of retainedTasks)
      runtime.controller.store.put('task', value.id, value.revision, value);
  });
  for (let index = 0; index < 360; index++) {
    original.push(append(task.id, marker(index)));
    append(other.id, `Other task output ${index}`);
    if (index % 10 === 0) append(null, `Global output ${index}`);
  }
  const oversized = runtime.controller.store.transaction(() =>
    runtime.controller.store.append({
      protocol: 1,
      id: id('evt'),
      taskId: blocked.id,
      at,
      revision: 0,
      type: 'task.updated',
      payload: { ...blocked, criteria: Array.from({ length: 100 }, () => '界'.repeat(4096)) },
    }),
  );
  const afterBoundary = append(blocked.id, 'Retained output above the blocked boundary.');
  assert(afterBoundary.type === 'attempt.output');
  const legacyBytes = Buffer.byteLength(
    JSON.stringify({
      type: 'result',
      key: createCommandKey(),
      result: {
        outcome: 'applied',
        data: { kind: 'snapshot', snapshot: runtime.controller.snapshot() },
      },
    }),
  );
  assert(
    legacyBytes > MAX_FRAME_BYTES,
    'The retained workspace must exceed the legacy full snapshot frame.',
  );
  const activity = page.locator('.activity-section');
  const outputs = () => activity.locator('.worker-output').allTextContents();
  const seen = new Set<string>();
  const inspectWindow = async () => {
    const text = (await outputs()).map((value) => value.trim());
    assert(text.length <= 100, 'Rendered history retains only one bounded page.');
    assert(text.every((value) => !value.startsWith('Other task') && !value.startsWith('Global')));
    assert.equal(
      new Set(text).size,
      text.length,
      'Overlapping live and page rows must not repeat.',
    );
    const retained = text.filter((value) => value.startsWith('Retained activity '));
    assert.deepEqual(retained, [...retained].sort(), 'Same-time events must keep cursor order.');
    for (const value of retained) seen.add(value);
  };
  const older = () =>
    activity.getByRole('button', { name: /load (?:earlier|older)(?: activity)?/i });
  const openTask = async (title: string) => {
    await page.getByRole('button', { name: title, exact: true }).click();
    await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  };
  const hold = (taskId: string, older: boolean) => {
    assert.equal(held, undefined);
    const waiting = {
      taskId,
      older,
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    held = waiting;
    return waiting;
  };
  let outstanding: ReturnType<typeof hold> | undefined;
  try {
    const prerequisite = await runtime.controller.execute(
      CommandSchema.parse({
        protocol: 1,
        key: createCommandKey(),
        actor: { id: 'activity-grader', kind: 'cli' },
        command: 'GetTaskActivity',
        payload: { taskId: task.id },
      }),
      'local-owner',
    );
    assert.equal(prerequisite.outcome, 'applied', 'The retained activity API must be installed.');
    const listing = spawn(
      node,
      [join(root, 'apps/cli/src/main.ts'), 'task', 'list', '--pages', '--json', '--home', home],
      {
        cwd: root,
        env: environment(home),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let listed = '';
    let listingError = '';
    listing.stdout?.on('data', (bytes: Buffer) => {
      listed += bytes.toString();
    });
    listing.stderr?.on('data', (bytes: Buffer) => {
      listingError += bytes.toString();
    });
    try {
      const code = await bounded(
        new Promise<number | null>((resolve, reject) => {
          listing.once('error', reject);
          listing.once('close', resolve);
        }),
        10000,
        'Large workspace CLI page traversal',
      );
      assert.equal(code, 0, listingError);
      const pages = listed
        .trim()
        .split('\n')
        .map((line) => TaskPageSchema.parse(JSON.parse(line)));
      const listedIds = pages.flatMap((part) => part.tasks.map((row) => row.id));
      assert.equal(pages.at(-1)?.complete, true);
      assert.equal(listedIds.length, retainedTasks.length);
      assert.equal(new Set(listedIds).size, retainedTasks.length);
      assert.deepEqual(listedIds, retainedTasks.map((row) => row.id).sort());
      assert.equal(listedIds.at(-1), lastRetainedTask.id);
    } finally {
      await stop(listing);
    }

    await application.evaluate(
      async ({ BrowserWindow }, options) => {
        const load = process.mainModule?.require.bind(process.mainModule);
        if (!load) throw new Error('The desktop fixture module loader is unavailable.');
        const { installBridge } = load(
          options.bridge,
        ) as typeof import('../apps/desktop/src/main/bridge.ts');
        const { connectController } = load(
          options.client,
        ) as typeof import('../packages/client/src/node.ts');
        const { desktopActor } = load(
          options.runtime,
        ) as typeof import('../apps/desktop/src/main/runtime.ts');
        const client = await connectController({ ...options.endpoint, actor: desktopActor });
        const state = globalThis as unknown as { activityGraderClient?: ControllerClient };
        state.activityGraderClient = client;
        const window = BrowserWindow.getAllWindows()[0];
        window.once('closed', () => client.close());
        await installBridge(window, {
          paths: { home: options.home, profile: options.home },
          connect: async () => client,
          resetClient: () => client.close(),
        } as never);
      },
      {
        bridge: join(root, 'apps/desktop/src/main/bridge.ts'),
        client: join(root, 'packages/client/src/node.ts'),
        runtime: join(root, 'apps/desktop/src/main/runtime.ts'),
        home,
        endpoint: readControllerEndpoint(home),
      },
    );
    await page.reload();
    await expect(page.getByText('Controller connected', { exact: true })).toBeVisible();
    const retryRegistration = page.getByRole('button', {
      name: 'Retry exact command',
      exact: true,
    });
    await expect(retryRegistration).toBeVisible();
    startupDetail = {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    await page.reload();
    await bounded(startupDetail.entered.promise, 5000, 'Delayed initial task detail');
    await expect(retryRegistration).toBeVisible();
    assert.equal(controllerReceipt(), undefined);
    await page.getByRole('button', { name: 'Add project', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Resolve the pending desktop command first.',
    );
    startupDetail.release.resolve();
    await bounded(
      startupConversation.promise,
      5000,
      'Automatic conversation read after task detail',
    );
    await expect(page.getByRole('alert')).toContainText(
      'Resolve the pending desktop command first.',
    );
    startupDetail = undefined;
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await retryRegistration.click();
    await expect(page.getByRole('alert')).toContainText('Choose a readable Git repository root.');
    await expect(retryRegistration).toHaveCount(0);
    assert.deepEqual(registrationRequests, [legacyRegistration]);
    assert.equal(controllerReceipt()?.result.outcome, 'blocked');
    retainedRegistration.load();
    assert.deepEqual(retainedRegistration.commands, []);
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();

    await expect(page.getByRole('button', { name: task.title, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
    await expect(page.locator('.project-group .count')).toHaveText(String(retainedTasks.length));
    const moreTasks = page.getByRole('button', { name: 'Load more tasks', exact: true });
    const retainedButtons = page.getByRole('button', { name: /^Retained workspace task / });
    for (let pageIndex = 1; pageIndex < Math.ceil(retainedTasks.length / 50); pageIndex++) {
      await moreTasks.click();
      await expect(retainedButtons).toHaveCount(
        Math.min((pageIndex + 1) * 50, retainedTasks.length) - 4,
      );
    }
    await expect(moreTasks).toHaveCount(0);
    await page.getByRole('button', { name: lastRetainedTask.title, exact: true }).click();
    await expect(
      page.getByRole('heading', { name: lastRetainedTask.title, exact: true }),
    ).toBeVisible();
    console.log(
      `Retained workspace: ${retainedTasks.length} tasks, legacy snapshot ${legacyBytes} bytes; desktop last-task selection and CLI pages complete.`,
    );
    const pickProjectFolder = async (path: string) => {
      await application.evaluate(({ dialog }, filePath) => {
        const original = dialog.showOpenDialog;
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original;
          return { canceled: false, filePaths: [filePath] };
        };
      }, path);
      await page.getByRole('button', { name: 'Add project', exact: true }).click();
    };
    await pickProjectFolder(invalidProject);
    await expect(page.getByRole('alert')).toContainText('Choose a readable Git repository root.');
    await expect(
      page.getByRole('button', { name: 'Retry exact command', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Add project', exact: true })).toBeEnabled();
    await pickProjectFolder(validProject);
    await expect(
      page.locator('.project-name').filter({ hasText: 'recovery-project' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Retry exact command', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add project', exact: true })).toBeEnabled();
    await openTask(task.title);
    await expect(
      activity.getByText(marker(359), { exact: true }),
      'Opening Activity must read retained task output, even when no live event has arrived.',
    ).toBeVisible();
    await inspectWindow();
    const oldestBefore = Math.min(...[...seen].map((value) => Number(value.slice(-4))));
    outstanding = hold(task.id, true);
    await older().press('Enter');
    await bounded(outstanding.entered.promise, 5000, 'Older activity read');
    const previousWindow = await outputs();
    outstanding.release.resolve();
    outstanding = undefined;
    await expect
      .poll(async () => {
        await inspectWindow();
        return Math.min(...[...seen].map((value) => Number(value.slice(-4))));
      })
      .toBeLessThan(oldestBefore);
    assert((await outputs()).length <= 100, 'Only one bounded activity page may be retained.');
    await expect(activity.getByText(marker(359), { exact: true })).toHaveCount(0);
    await activity.getByRole('button', { name: 'Load newer activity', exact: true }).click();
    await expect(activity.getByText(marker(359), { exact: true })).toBeVisible();
    assert.deepEqual(
      await outputs(),
      previousWindow,
      'Cursor return navigation restores the newer page.',
    );
    await older().press('Enter');
    await expect(activity.getByText(marker(359), { exact: true })).toHaveCount(0);
    await inspectWindow();
    for (let pageIndex = 0; pageIndex < original.length && !seen.has(marker(0)); pageIndex++) {
      const before = seen.size;
      await older().press('Enter');
      await expect
        .poll(async () => {
          await inspectWindow();
          return seen.size;
        })
        .toBeGreaterThan(before);
    }
    assert.deepEqual(
      [...seen].sort(),
      original.map((_event, index) => marker(index)),
    );
    await expect(
      activity.getByText(
        /beginning of (?:the )?(?:task )?activity|no (?:earlier|older) (?:activity|events)/i,
      ),
    ).toBeVisible();
    const reading = activity.getByText(marker(50), { exact: true });
    await reading.scrollIntoViewIfNeeded();
    const position = await reading.boundingBox();
    assert(position);
    const live = append(task.id, marker(360));
    await expect
      .poll(
        async () =>
          (await activity.getByText(marker(360), { exact: true }).count()) > 0 ||
          (await activity
            .getByRole('status')
            .filter({ hasText: /new (?:activity|events?)/i })
            .count()) > 0,
      )
      .toBe(true);
    const afterLive = await reading.boundingBox();
    assert(
      afterLive && Math.abs(afterLive.y - position.y) < 3,
      'Live output must keep the reading anchor.',
    );
    await inspectWindow();
    await activity
      .getByRole('button', { name: /(?:jump|show|load|return).*latest|new activity/i })
      .click();
    await expect(activity.getByText(marker(360), { exact: true })).toBeVisible();
    await inspectWindow();
    outstanding = hold(other.id, false);
    await openTask(other.title);
    await bounded(outstanding.entered.promise, 5000, 'Other task activity read');
    await openTask(task.title);
    outstanding.release.resolve();
    outstanding = undefined;
    await desktopSnapshot(page, task.id);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await expect(activity.getByText(marker(360), { exact: true })).toBeVisible();
    await expect(activity.getByText(/Other task output/)).toHaveCount(0);
    await openTask(empty.title);
    await expect(
      activity.getByText(/no (?:retained )?(?:activity|events)|no activity has been recorded/i),
    ).toBeVisible();
    await expect(older()).toHaveCount(0);
    await openTask(blocked.title);
    await expect(activity.getByText(afterBoundary.payload.text, { exact: true })).toBeVisible();
    const output = activity.getByRole('region', { name: /^Output / });
    await expect(output).toHaveCount(1);
    const originalBody = canonicalJson(oversized);
    assert(Buffer.byteLength(originalBody) > MAX_FRAME_BYTES);
    await output.getByRole('button', { name: 'Read output', exact: true }).click();
    await expect(output.getByText(/Bytes 0-65536 of/)).toBeVisible();
    const chunks = [(await output.locator('pre').textContent()) ?? ''];
    let outputPageIndex = 1;
    while (
      await output.getByRole('button', { name: 'Next output page', exact: true }).isEnabled()
    ) {
      await output.getByRole('button', { name: 'Next output page', exact: true }).click();
      await expect(
        output
          .getByRole('status')
          .filter({ hasText: new RegExp(`^Bytes ${outputPageIndex * 65536}-`) }),
      ).toBeVisible();
      outputPageIndex++;
      chunks.push((await output.locator('pre').textContent()) ?? '');
    }
    assert.equal(
      chunks.join(''),
      originalBody,
      'Sequential output pages preserve UTF-8 seams and all bytes.',
    );
    await expect(output.getByText(/End of retained output/)).toBeVisible();
    failNextRange = true;
    await output.getByRole('button', { name: 'Restart output', exact: true }).click();
    await expect(output.getByRole('alert')).toContainText('fixture-output-range-failed');
    await output.getByRole('button', { name: 'Retry output page', exact: true }).click();
    await expect(output.getByText(/Bytes 0-65536 of/)).toBeVisible();
    assert.equal(
      await output.locator('pre').textContent(),
      chunks[0],
      'A failed restart retries byte zero with a fresh UTF-8 decoder.',
    );
    const waitingRange = {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    heldRange = waitingRange;
    const beforeVerificationReads = rangeReads;
    await output.getByRole('button', { name: 'Verify complete output', exact: true }).click();
    try {
      await bounded(waitingRange.entered.promise, 5000, 'Held output verification range');
      await expect(page.getByRole('button', { name: 'Add project', exact: true })).toBeEnabled();
      const health = await bounded(
        page.evaluate(() => window.crewkite?.command({ command: 'GetHealth', payload: {} })),
        5000,
        'Health while output verification is held',
      );
      assert.equal(health?.outcome, 'applied');
      await output.getByRole('button', { name: 'Cancel verification', exact: true }).click();
    } finally {
      waitingRange.release.resolve();
    }
    await expect(output.getByRole('status').last()).toContainText(/abort|cancel/i);
    assert.equal(
      rangeReads,
      beforeVerificationReads + 1,
      'Cancellation must not fetch a second range.',
    );
    await output.getByRole('button', { name: 'Verify complete output', exact: true }).click();
    await expect(output.getByRole('status').last()).toHaveText(
      'Complete output checksum verified.',
    );
    await expect(page.getByRole('button', { name: 'Add project', exact: true })).toBeEnabled();
    await expect(activity.getByText(afterBoundary.payload.text, { exact: true })).toBeVisible();
    const corrupt = append(other.id, 'Retained output after a repaired history.');
    assert(corrupt.type === 'attempt.output');
    runtime.controller.store.db
      .prepare('UPDATE events SET body=? WHERE event_id=?')
      .run(JSON.stringify({ ...corrupt, cursor: '0' }), corrupt.id);
    await page.reload();
    await expect(page.getByText('Controller connected', { exact: true })).toBeVisible();
    await openTask(other.title);
    await expect(activity.getByRole('alert')).toContainText(
      /unavailable|could not|activity-history-unavailable/i,
    );
    runtime.controller.store.db
      .prepare('UPDATE events SET body=? WHERE event_id=?')
      .run(JSON.stringify(corrupt), corrupt.id);
    await activity
      .getByRole('button', { name: /retry.*activity|refresh.*activity|try again/i })
      .press('Enter');
    await expect(activity.getByText(corrupt.payload.text, { exact: true })).toBeVisible();
    await openTask(task.title);
    await runtime.close();
    await expect(page.getByText('Controller offline', { exact: true })).toBeVisible();
    runtime = await startController(options);
    instrument();
    runtime.controller.store.transaction(() => {
      for (let index = 0; index < 1005; index++)
        runtime.controller.store.append({
          protocol: 1,
          id: id('evt'),
          taskId: null,
          at,
          revision: 0,
          type: 'attempt.output',
          payload: {
            attemptId: id('att'),
            generation: 1,
            channel: 'stdout',
            text: `Disconnected global output ${index}`,
          },
        });
    });
    const reconnected = append(task.id, marker(361));
    await expect(page.getByText('Controller connected', { exact: true })).toBeVisible();
    await expect(activity.getByText(marker(361), { exact: true })).toBeVisible();
    await inspectWindow();
    assert(BigInt(reconnected.cursor) > BigInt(live.cursor));
    await runtime.close();
    await expect(page.getByText('Controller offline', { exact: true })).toBeVisible();
    const restored = new DatabaseSync(join(home, 'state.sqlite'));
    try {
      restored.exec(
        "DELETE FROM activity_output; DELETE FROM events; DELETE FROM sqlite_sequence WHERE name='events'",
      );
    } finally {
      restored.close();
    }
    runtime = await startController(options);
    instrument();
    runtime.controller.store.transaction(() => {
      const replacement = {
        ...task,
        title: 'Inspect restored task detail',
        revision: task.revision + 1,
      };
      runtime.controller.store.put('task', task.id, replacement.revision, replacement);
    });
    const restoredEvent = append(task.id, 'Restored home activity');
    assert(BigInt(restoredEvent.cursor) < BigInt(reconnected.cursor));
    await expect(
      page.getByRole('heading', { name: 'Inspect restored task detail', exact: true }),
    ).toBeVisible();
    await expect(activity.getByText('Restored home activity', { exact: true })).toBeVisible();
    append(task.id, 'Restored live activity');
    await expect(
      activity.getByRole('status').filter({ hasText: 'New activity is available' }),
    ).toBeVisible();
    await activity.getByRole('button', { name: 'Jump to latest', exact: true }).click();
    await expect(activity.getByText('Restored live activity', { exact: true })).toBeVisible();
    await expect(activity.getByText(marker(361), { exact: true })).toHaveCount(0);

    assert.equal(
      runtime.controller.snapshot().attempts.length,
      0,
      'Activity reads must start no work.',
    );
  } finally {
    held?.release.resolve();
    startupDetail?.release.resolve();
    outstanding?.release.resolve();
    await application.evaluate(() => {
      const state = globalThis as unknown as { activityGraderClient?: ControllerClient };
      state.activityGraderClient?.close();
      delete state.activityGraderClient;
    });
    await runtime.close();
  }
}

async function projectOperationsJourney(
  application: Awaited<ReturnType<typeof _electron.launch>>,
  page: Page,
) {
  const home = mkdtempSync(join(internal, 'operations-ui-'));
  const source = join(home, 'source');
  mkdirSync(source);
  git(source, ['init', '--quiet']);
  const script =
    "import {writeFileSync,existsSync} from 'node:fs'; console.log('Committed operation output; excluded=' + existsSync('excluded.txt')); writeFileSync('operation-started','ready'); setInterval(() => {}, 1000);\n";
  writeFileSync(join(source, 'run.mjs'), script);
  git(source, ['add', 'run.mjs']);
  git(source, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'Add disposable operation fixture',
  ]);
  const head = git(source, ['rev-parse', 'HEAD']).toString().trim();
  writeFileSync(
    join(source, 'run.mjs'),
    script.replace('Committed operation', 'Uncommitted operation'),
  );
  writeFileSync(join(source, 'excluded.txt'), 'not copied');
  const original = sourceIdentity(source);
  const at = new Date().toISOString();
  const fixture = createDemoFixtures(at);
  const id = createTestIds(at, 16000n);
  const task = { ...fixture.task, id: id('tsk'), title: 'Review and stop a project command' };
  const project = fixture.snapshot.projects[0];
  const options = {
    home,
    id,
    nativeProfiles: () => [],
    googleUsageClient: () => ({ available: false as const, reason: 'client-unavailable' as const }),
    registerGoogleAcp: false,
    localInputHelper: undefined,
  };
  let runtime = await startController(options);
  const stopEntered = Promise.withResolvers<void>();
  const stopRelease = Promise.withResolvers<void>();
  let startSettled = false;
  let operationId: string | undefined;
  let scratch: string | undefined;
  let pageReads = 0;
  let failFirstPage = true;
  let execute = runtime.controller.execute.bind(runtime.controller);
  const instrument = () => {
    execute = runtime.controller.execute.bind(runtime.controller);
    runtime.controller.execute = async (input, principal) => {
      const command = CommandSchema.parse(input);
      if (command.command === 'GetTaskOperations') {
        pageReads++;
        if (failFirstPage) {
          failFirstPage = false;
          return { outcome: 'blocked', reason: 'fixture-operation-history-unavailable' };
        }
      }
      if (command.command === 'StopProjectOperation') {
        stopEntered.resolve();
        await stopRelease.promise;
      }
      const result = await execute(command, principal);
      if (
        command.command === 'PrepareProjectCommand' &&
        result.data?.kind === 'project-operation'
      ) {
        operationId = result.data.operation.id;
        scratch = result.data.definition?.scratchRoot;
        assert.equal(result.data.definition?.source.dirtyCount, 1);
        assert.equal(result.data.definition?.source.untrackedCount, 1);
      }
      if (command.command === 'StartProjectCommand') startSettled = true;
      return result;
    };
  };
  instrument();
  runtime.controller.store.transaction(() => {
    runtime.controller.store.put('project', project.id, project.revision, project);
    runtime.controller.store.put('task', task.id, task.revision, task);
    runtime.controller.store.db
      .prepare('INSERT INTO project_paths(project_id,path) VALUES (?,?)')
      .run(project.id, source);
  });
  try {
    await application.evaluate(
      async ({ BrowserWindow }, options) => {
        const load = process.mainModule?.require.bind(process.mainModule);
        if (!load) throw Error('The desktop fixture module loader is unavailable.');
        const { installBridge } = load(
          options.bridge,
        ) as typeof import('../apps/desktop/src/main/bridge.ts');
        const { connectController } = load(
          options.client,
        ) as typeof import('../packages/client/src/node.ts');
        const { desktopActor } = load(
          options.runtime,
        ) as typeof import('../apps/desktop/src/main/runtime.ts');
        const client = await connectController({ ...options.endpoint, actor: desktopActor });
        (globalThis as unknown as { operationsClient?: ControllerClient }).operationsClient =
          client;
        await installBridge(BrowserWindow.getAllWindows()[0], {
          paths: { home: options.home, profile: options.home },
          connect: async () => client,
          resetClient: () => client.close(),
        } as never);
      },
      {
        bridge: join(root, 'apps/desktop/src/main/bridge.ts'),
        client: join(root, 'packages/client/src/node.ts'),
        runtime: join(root, 'apps/desktop/src/main/runtime.ts'),
        endpoint: readControllerEndpoint(home),
        home,
      },
    );
    await page.reload();
    await expect(page.getByText('Controller connected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: task.title, exact: true }).click();
    await page.getByRole('tab', { name: 'Operations', exact: true }).click();
    const operations = page.getByRole('region', { name: 'Task operations', exact: true });
    await expect(operations.getByRole('alert')).toContainText(
      'fixture-operation-history-unavailable',
    );
    await expect(
      operations.getByText('No project operations are retained for this task.', { exact: true }),
    ).toHaveCount(0);
    await operations.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(
      operations.getByText('No project operations are retained for this task.', { exact: true }),
    ).toBeVisible();
    await operations.getByLabel('Executable path', { exact: true }).fill(node);
    await operations
      .getByLabel('Arguments, one exact value per line', { exact: true })
      .fill('run.mjs');
    await operations.getByRole('button', { name: 'Prepare exact definition', exact: true }).click();
    const card = operations.getByRole('article');
    await expect(card.getByText('Prepared for review', { exact: true })).toBeVisible();
    await expect(card.getByText(head, { exact: true })).toBeVisible();
    await expect(
      card.locator('.fact').filter({ hasText: 'Changed files excluded' }).locator('strong'),
    ).toHaveText('1');
    await expect(
      card.locator('.fact').filter({ hasText: 'Untracked files excluded' }).locator('strong'),
    ).toHaveText('1');
    await expect(
      card.getByText(
        'Only committed source at this head is copied when you Start. Local changes and untracked files are excluded.',
        { exact: true },
      ),
    ).toBeVisible();
    const start = card.getByRole('button', { name: 'Start exact definition', exact: true });
    await expect(start).toBeDisabled();
    await card.getByRole('checkbox').check();
    await start.click();
    await expect(card.getByText('Running', { exact: true })).toBeVisible();
    await expect.poll(() => scratch && existsSync(join(scratch, 'operation-started'))).toBe(true);
    assert.equal(startSettled, false, 'Start remains pending while the actual owned process runs.');
    assert.equal(
      new CommandReceipts(home, home).commands.length,
      0,
      'Owned operations must not create a global unknown receipt.',
    );
    await expect(page.getByRole('button', { name: 'Add project', exact: true })).toBeEnabled();
    await card.getByRole('button', { name: 'Stop', exact: true }).click();
    await bounded(
      stopEntered.promise,
      5000,
      'Stop alongside held Start on the same desktop connection',
    );
    assert.equal(startSettled, false, 'Stop must reach the controller before Start returns.');
    stopRelease.resolve();
    await expect(card.getByText('Cancelled', { exact: true })).toBeVisible();
    assert(operationId);
    const detail = await execute(
      CommandSchema.parse({
        protocol: 1,
        key: createCommandKey(),
        actor: { id: 'operation-observer', kind: 'cli' },
        command: 'GetProjectOperation',
        payload: { taskId: task.id, operationId },
      }),
      'local-owner',
    );
    assert.equal(detail.data?.kind, 'project-operation');
    assert(detail.data?.kind === 'project-operation' && detail.data.operation.stdout);
    const output = card.getByRole('region', {
      name: `Output ${detail.data.operation.stdout.id}`,
      exact: true,
    });
    await output.getByRole('button', { name: 'Read output', exact: true }).click();
    await expect(output.locator('pre')).toHaveText('Committed operation output; excluded=false\n');
    assert.deepEqual(
      sourceIdentity(source),
      original,
      'Project execution must preserve dirty source/index files.',
    );
    assert.equal(new CommandReceipts(home, home).commands.length, 0);
    await expect(
      page.getByRole('button', { name: 'Retry exact command', exact: true }),
    ).toHaveCount(0);
    await runtime.close();
    await expect(page.getByText('Controller offline', { exact: true })).toBeVisible();
    const readsBeforeReconnect = pageReads;
    runtime = await startController(options);
    instrument();
    await expect(page.getByText('Controller connected', { exact: true })).toBeVisible();
    await expect.poll(() => pageReads).toBeGreaterThan(readsBeforeReconnect);
    await expect(card.getByText('Cancelled', { exact: true })).toBeVisible();
  } finally {
    stopRelease.resolve();
    await application.evaluate(() => {
      const state = globalThis as unknown as { operationsClient?: ControllerClient };
      state.operationsClient?.close();
      delete state.operationsClient;
    });
    await runtime.close();
  }
}

test('desktop and CLI retain one checked task through handoff and restart', async () => {
  test.setTimeout(120000);
  mkdirSync(internal, { recursive: true });
  const home = mkdtempSync(join(internal, 'journey-'));
  if (checkOwner() && Buffer.byteLength(join(home, 'control.sock')) > 100)
    throw Error('The verification journey socket path exceeds its bound.');
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
    const electronRoot = enrollCheckRoot('electron', true);
    application = await _electron.launch({
      executablePath: checkOwner()?.electronExecutable ?? require('electron'),
      chromiumSandbox: true,
      args: [join(root, 'apps/desktop')],
      env: {
        ...environment(home),
        ...electronRoot.environment,
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
    electronRoot.acknowledge(child);
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
    const manualTask = createDemoFixtures().task;
    await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Outcome', { exact: true })).toHaveValue('');
    await expect(page.getByLabel(/^Acceptance criteria/)).toHaveValue('');
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Create task', exact: true }),
    ).toBeDisabled();
    await page.getByLabel('Task title', { exact: true }).fill(manualTask.title);
    await page.getByLabel('Outcome', { exact: true }).fill(manualTask.outcome);
    await page.getByLabel(/^Acceptance criteria/).fill(manualTask.criteria.join('\n'));
    await enter(page.getByRole('dialog').getByRole('button', { name: 'Create task', exact: true }));
    const created = await timeline.wait((event) => event.type === 'task.created');
    assert.equal(created.type, 'task.created');
    const taskId = created.payload.id;
    await expect(page.getByRole('heading', { name: manualTask.title, exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Conversation', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByRole('tab', { name: 'Plan', exact: true }).click();
    await page
      .getByRole('tabpanel', { name: 'Plan', exact: true })
      .getByRole('button', { name: 'Prepare run', exact: true })
      .click();
    await enter(
      page
        .getByRole('dialog', { name: 'Choose execution provider', exact: true })
        .getByRole('button', { name: 'Scripted demo', exact: true }),
    );
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
    await page.getByRole('tab', { name: 'Activity', exact: true }).click();
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
    const replacementProfiles = (await observer.snapshot()).nativeProfiles;
    assert.equal(replacementProfiles[0]?.displayName, 'OpenAI scripted proposal fixture');
    await expect
      .poll(async () => (await desktopSnapshot(page))?.nativeProfiles ?? null)
      .toEqual(replacementProfiles);
    await expect(page.getByText('Controller connected', { exact: true })).toBeVisible();
    await enter(page.getByRole('button', { name: 'New task', exact: true }).first());
    await page.getByLabel('Task title', { exact: true }).fill('Retain one native file proposal');
    await page.getByLabel('Outcome', { exact: true }).fill(manualTask.outcome);
    await page.getByLabel(/^Acceptance criteria/).fill(manualTask.criteria.join('\n'));
    await enter(page.getByRole('dialog').getByRole('button', { name: 'Create task', exact: true }));
    await expect(
      page.getByRole('heading', { name: 'Retain one native file proposal', exact: true }),
    ).toBeVisible();
    await page.getByRole('tab', { name: 'Plan', exact: true }).click();
    await page
      .getByRole('tabpanel', { name: 'Plan', exact: true })
      .getByRole('button', { name: 'Prepare run', exact: true })
      .click();
    const nativeFileProfile = replacementProfiles.find(
      (profile) => profile.id === 'openai-file-v1',
    );
    assert(nativeFileProfile);
    const projectChooser = page.getByRole('dialog', {
      name: 'Choose execution provider',
      exact: true,
    });
    await expect(
      projectChooser.getByRole('combobox', { name: 'Provider', exact: true }),
    ).toHaveValue('openai');
    await expect(projectChooser.getByRole('combobox', { name: 'Scope', exact: true })).toHaveValue(
      'repository',
    );
    await expect(
      projectChooser.getByRole('combobox', { name: 'Scope', exact: true }).locator('option'),
    ).toHaveText(['Project']);
    await enter(projectChooser.getByRole('button', { name: 'Start task', exact: true }));
    const nativeDialog = page.getByRole('dialog');
    await expect(nativeDialog).toHaveAccessibleName('Repository work');
    await expect(nativeDialog.getByText('Requires Pro', { exact: true })).toHaveCount(0);
    await expect(nativeDialog.getByLabel('File to edit', { exact: true })).toHaveCount(0);
    await nativeDialog.getByText('Details', { exact: true }).click();
    const credits = nativeDialog.getByLabel('Allow existing credits after included usage', {
      exact: true,
    });
    await expect(credits).not.toBeChecked();
    const trust = nativeDialog.getByLabel('Trust the existing native client and login', {
      exact: true,
    });
    const projectPermission = nativeDialog.getByLabel(
      'Allow OpenAI to read this project, edit a separate working copy, and run local commands using my signed-in client',
      { exact: true },
    );
    await expect(projectPermission).not.toBeChecked();
    await expect(trust).toHaveCount(0);
    await expect(
      nativeDialog.getByLabel(
        'Send this committed repository and task text; allow edits in independent scratch',
        { exact: true },
      ),
    ).toHaveCount(0);
    await expect(
      nativeDialog.getByLabel('Allow local commands for this run', { exact: true }),
    ).toHaveCount(0);
    await expect(nativeDialog).toContainText('Subscription only');
    await projectPermission.check();
    await expect(credits).not.toBeChecked();
    await enter(nativeDialog.getByRole('button', { name: 'Review task', exact: true }));
    await expect(
      page.getByRole('dialog', { name: 'Review the native proposal', exact: true }),
    ).toBeVisible();
    await expect(nativeDialog.getByLabel('Prepared native target')).toContainText(
      'Saved repository',
    );
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
    const consent = nativeDialog.getByLabel(
      'Send this committed file and task text; allow its replacement in independent scratch',
      { exact: true },
    );
    await expect(trust).not.toBeChecked();
    await expect(consent).not.toBeChecked();
    await expect(credits).not.toBeChecked();
    await expect(
      nativeDialog.getByRole('button', { name: 'Prepare OpenAI work', exact: true }),
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
    await nativeDialog.getByText('Provider details', { exact: true }).click();
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
      nativeDialog.getByRole('button', { name: 'Prepare Anthropic work', exact: true }),
    ).toBeDisabled();
    await extraUsage.check();
    await expect(trust).not.toBeChecked();
    await expect(consent).not.toBeChecked();
    await trust.check();
    await consent.check();
    await nativeDialog.getByRole('textbox', { name: 'File to edit', exact: true }).fill('net.mjs ');
    await expect(subscription).not.toBeChecked();
    await expect(extraUsage).not.toBeChecked();
    await expect(trust).not.toBeChecked();
    await expect(consent).not.toBeChecked();
    await nativeDialog.getByRole('textbox', { name: 'File to edit', exact: true }).fill('net.mjs');
    await subscription.check();
    await extraUsage.check();
    await trust.check();
    await consent.check();
    await page.screenshot({
      path: join(internal, 'anthropic-native-confirmations-light.png'),
      animations: 'disabled',
    });
    await enter(nativeDialog.getByRole('button', { name: 'Prepare Anthropic work', exact: true }));
    await expect(
      page.getByRole('dialog', { name: 'Review the native proposal', exact: true }),
    ).toBeVisible();
    await expect(nativeDialog.getByLabel('Prepared native target')).toContainText('user-attested');
    const attestedSnapshot = await observer.snapshot();
    const attestedRun = attestedSnapshot.nativeRuns.find(
      (value) =>
        value.runId === attestedSnapshot.tasks.find((task) => task.id === nativeTask.id)?.runId,
    );
    assert.equal(attestedRun?.profileId, 'anthropic-file-v1');
    assert.deepEqual(attestedRun?.billingAttestation, {
      source: 'user-attested',
      subscriptionLoginConfirmed: true,
      paidExtraUsageDisabled: true,
    });
    const attestedPolicyRun = attestedSnapshot.runs.find(
      (run) => run.id === attestedSnapshot.tasks.find((task) => task.id === nativeTask.id)?.runId,
    );
    assert(attestedPolicyRun);
    assert.deepEqual(
      attestedPolicyRun.policy.policy.effects.filter((grant) => grant.action !== 'write-scratch'),
      hiddenPolicy.effects.filter((grant) => grant.action !== 'write-scratch'),
    );
    await enter(nativeDialog.getByRole('button', { name: 'Edit proposal', exact: true }));
    const legacyWriter = nativeDialog.getByRole('combobox', {
      name: 'Writer profile',
      exact: true,
    });
    await expect(legacyWriter.locator('option[value="google-file-v1"]')).toHaveCount(0);
    await expect(legacyWriter.locator('option[value="anthropic-file-compact-v1"]')).toHaveCount(0);
    await page.screenshot({
      path: join(internal, 'public-native-prepared-light.png'),
      animations: 'disabled',
    });
    await enter(nativeDialog.getByRole('button', { name: 'Provider choices', exact: true }));
    const repositoryProfile = replacementProfiles.find(
      (profile) => profile.id === 'openai-repository-v1',
    );
    assert(repositoryProfile);
    await enter(
      page
        .getByRole('dialog', { name: 'Choose execution provider', exact: true })
        .getByRole('button', { name: 'Start task', exact: true }),
    );
    await expect(nativeDialog.getByLabel('File to edit', { exact: true })).toHaveCount(0);
    await expect(
      nativeDialog.getByRole('combobox', { name: 'Writer profile', exact: true }),
    ).toHaveCount(0);
    const nextProjectPermission = nativeDialog.getByLabel(
      'Allow OpenAI to read this project, edit a separate working copy, and run local commands using my signed-in client',
      { exact: true },
    );
    await expect(nextProjectPermission).not.toBeChecked();
    await expect(credits).not.toBeChecked();
    await expect(
      nativeDialog.getByRole('button', { name: 'Review task', exact: true }),
    ).toBeDisabled();
    await nextProjectPermission.check();
    await expect(credits).not.toBeChecked();
    await expect(
      nativeDialog.getByRole('button', { name: 'Review task', exact: true }),
    ).toBeEnabled();
    await enter(nativeDialog.getByRole('button', { name: 'Review task', exact: true }));
    const repositoryPrepared = await observer.snapshot();
    const repositoryTask = repositoryPrepared.tasks.find((value) => value.id === nativeTask.id);
    const repositoryNative = repositoryPrepared.nativeRuns.find(
      (value) => value.runId === repositoryTask?.runId,
    );
    const repositoryRun = repositoryPrepared.runs.find(
      (value) => value.id === repositoryTask?.runId,
    );
    assert(repositoryNative?.repository && repositoryRun);
    assert.equal(repositoryNative.profileId, 'openai-repository-v1');
    assert.equal(repositoryNative.target, undefined);
    assert.deepEqual(repositoryNative.execution, {
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      networkAccess: false,
    });
    assert.equal(repositoryNative.repository.sourceBase, repositoryRun.source.base);
    assert(repositoryNative.repository.files > 0);
    assert(repositoryNative.repository.bytes > 0);
    const toolsGrant = repositoryRun.policy.policy.effects.find(
      (grant) => grant.action === 'run-native-tools',
    );
    assert.deepEqual(toolsGrant, {
      taskId: nativeTask.id,
      action: 'run-native-tools',
      target: repositoryPrepared.projects.find((value) => value.id === nativeTask.projectId)?.name,
      revoked: false,
      usesRemaining: 1,
      expiresAt: repositoryNative.expiresAt,
    });
    const writeGrant = repositoryRun.policy.policy.effects.find(
      (grant) => grant.action === 'write-scratch',
    );
    assert.equal(writeGrant?.taskId, nativeTask.id);
    assert.equal(writeGrant?.target, toolsGrant.target);
    assert.equal(writeGrant?.revoked, false);
    assert.equal(writeGrant?.usesRemaining, 1);
    assert.equal(writeGrant?.expiresAt, repositoryNative.expiresAt);
    assert.equal(
      repositoryPrepared.attempts.filter((value) => value.runId === repositoryRun.id).length,
      0,
    );
    assert.deepEqual(
      cli(home, 'task', 'show', nativeTask.id).nativeRun.repository,
      repositoryNative.repository,
    );
    await expect(nativeDialog.getByLabel('Prepared native target')).toContainText(
      'Saved repository',
    );
    await expect(nativeDialog).toContainText('Native approval requests refused');
    await page.screenshot({
      path: join(internal, 'repository-native-prepared-light.png'),
      animations: 'disabled',
    });
    await enter(nativeDialog.getByRole('button', { name: 'Start task', exact: true }));
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
    await recipe.selectOption('crewkite-verify-v1');
    await expect(nativeTrust).not.toBeChecked();
    await expect(reviewerCredits).not.toBeChecked();
    await expect(evaluationPanel).toContainText('Local Node and Git are verified.');
    await expect(evaluationPanel).toContainText(
      'Staging, checks and cleanup share a ten-minute limit.',
    );
    const verificationPermission = evaluationPanel.getByLabel(
      'Allow one full local verification run',
      { exact: true },
    );
    await expect(verificationPermission).not.toBeChecked();
    await recipe.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(internal, 'crewkite-verification-preparation-dark.png'),
      animations: 'disabled',
    });
    await nativeTrust.check();
    await reviewerCredits.check();
    await verificationPermission.check();
    await recipe.selectOption('project-node-tests-v1');
    await expect(
      evaluationPanel.getByLabel('Allow one local run of the selected project tests', {
        exact: true,
      }),
    ).not.toBeChecked();
    await expect(nativeTrust).not.toBeChecked();
    await expect(reviewerCredits).not.toBeChecked();
    const evaluationPermissions = [
      'Trust the existing native client and login for the review',
      'Share the committed source, candidate changes and task text with the reviewer',
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
    assert.deepEqual(evaluation.repository, repositoryNative.repository);
    assert.equal(evaluation.target, undefined);
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
    await expect
      .poll(() =>
        evaluationPanel
          .getByRole('button', { name: 'Start local checks', exact: true })
          .evaluateAll(
            (buttons) =>
              buttons.length === 0 || (buttons.length === 1 && buttons[0].matches(':disabled')),
          ),
      )
      .toBe(true);
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
    await expect
      .poll(() =>
        evaluationPanel
          .getByRole('button', { name: 'Start native review', exact: true })
          .evaluateAll(
            (buttons) =>
              buttons.length === 0 || (buttons.length === 1 && buttons[0].matches(':disabled')),
          ),
      )
      .toBe(true);
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
    const reopenedNative = await observer.snapshot();
    await expect.poll(() => desktopSnapshot(page)).toEqual(reopenedNative);
    await expect(page.getByText('Controller connected', { exact: true })).toBeVisible();
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

    const sidebarSource = join(home, 'sidebar-project');
    mkdirSync(sidebarSource);
    git(sidebarSource, ['init', '--quiet']);
    const sidebarProject = cli(home, 'project', 'add', sidebarSource);
    assert.equal(sidebarProject.result.outcome, 'applied');
    const sidebarProjectId = sidebarProject.result.entity.id;
    await page.reload();
    await expect(page.getByText('Controller connected', { exact: true })).toBeVisible();
    const projectGroup = page.locator('.project-group').filter({
      has: page.getByText('sidebar-project', { exact: true }),
    });
    await expect(projectGroup.locator('.count')).toHaveText('0');
    await expect(projectGroup.getByText('No tasks yet', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    const definitionDialog = page.getByRole('dialog', { name: 'New task', exact: true });
    await expect(definitionDialog.getByLabel('Task title', { exact: true })).toHaveValue('');
    await expect(
      definitionDialog.getByRole('combobox', { name: 'Project', exact: true }),
    ).toHaveValue(nativeTask.projectId);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
    await projectGroup
      .getByRole('button', { name: 'New task in sidebar-project', exact: true })
      .click();
    await expect(
      definitionDialog.getByRole('combobox', { name: 'Project', exact: true }),
    ).toHaveValue(sidebarProjectId);
    await expect(projectGroup.locator('.count')).toHaveText('0');
    await page.keyboard.press('Escape');
    await expect(projectGroup.getByText('No tasks yet', { exact: true })).toBeVisible();
    await projectGroup
      .getByRole('button', { name: 'Create first task in sidebar-project', exact: true })
      .click();
    await expect(
      definitionDialog.getByRole('combobox', { name: 'Project', exact: true }),
    ).toHaveValue(sidebarProjectId);
    const sidebarTaskTitle = 'Retain a manually defined task in its chosen project';
    await definitionDialog.getByLabel('Task title', { exact: true }).fill(sidebarTaskTitle);
    await definitionDialog
      .getByLabel('Outcome', { exact: true })
      .fill('Save the reviewed task definition in the selected project.');
    await definitionDialog
      .getByLabel(/^Acceptance criteria/)
      .fill('The saved task belongs to sidebar-project.');
    await definitionDialog.getByRole('button', { name: 'Create task', exact: true }).click();
    await expect(definitionDialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: sidebarTaskTitle, exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Conversation', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(projectGroup.locator('.count')).toHaveText('1');
    await expect(
      projectGroup.getByRole('button', { name: sidebarTaskTitle, exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(projectGroup.getByText('No tasks yet', { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('dialog', { name: 'Choose execution provider', exact: true }),
    ).toHaveCount(0);
    const savedSidebarTask = (await observer.snapshot()).tasks.find(
      (task) => task.title === sidebarTaskTitle,
    );
    assert(savedSidebarTask);
    assert.equal(savedSidebarTask.projectId, sidebarProjectId);
    assert.equal(savedSidebarTask.state, 'draft');

    await taskActivityHistory(application, page);
    await projectOperationsJourney(application, page);
    await quotaReadBridge(application, page);
    await conversationBridge(application, page);
    const isolatedUsage = new DatabaseSync(join(home, 'state.sqlite'), { readOnly: true });
    try {
      assert.equal(
        isolatedUsage
          .prepare("SELECT COUNT(*) AS n FROM receipts WHERE command_key='usage-reader:openai'")
          .get()?.n,
        0,
        'Scripted desktop checks must not start the real native account metadata reader.',
      );
    } finally {
      isolatedUsage.close();
    }
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
