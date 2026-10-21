import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  type GitHubReadRequest,
  type OwnedProjectCommandExecution,
  type OwnedProjectCommandLifecycle,
  type OwnedProjectCommandRequest,
  type OwnedProjectCommandRunner,
  type OwnedProjectCommandTerminal,
  startGitHubRead,
} from './read.ts';

const repository = { host: 'github.com', owner: 'crew-kite', name: 'daily-work' } as const;
const headSha = '1'.repeat(40);
const client = {
  path: '/usr/local/bin/gh',
  sha256: '2'.repeat(64),
  cwd: '/project',
  environment: { HOME: '/home/example', PATH: '/usr/bin:/bin' },
} as const;

type Script = Readonly<{
  stdout?: readonly Uint8Array[];
  stderr?: readonly Uint8Array[];
  terminal?: Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
    quiescent: boolean;
    reason: 'exit' | 'stopped' | 'deadline' | 'launch' | 'ownership';
  }>;
  hold?: boolean;
  streamFailure?: 'stdout' | 'stderr';
}>;

function bytes(value: unknown) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
}

function runBody(
  status: string,
  conclusion: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 77,
    run_attempt: 2,
    head_sha: headSha,
    status,
    conclusion,
    name: 'CI',
    html_url: 'https://github.com/crew-kite/daily-work/actions/runs/77',
    ...overrides,
  };
}

function jobBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 88,
    run_id: 77,
    run_attempt: 2,
    head_sha: headSha,
    status: 'completed',
    conclusion: 'failure',
    html_url: 'https://github.com/crew-kite/daily-work/actions/runs/77/job/88',
    ...overrides,
  };
}

class FixtureRunner implements OwnedProjectCommandRunner {
  readonly launches: OwnedProjectCommandRequest[] = [];
  readonly scripts: Script[];
  constructor(scripts: Script[]) {
    this.scripts = [...scripts];
  }

  launch(request: OwnedProjectCommandRequest, lifecycle: OwnedProjectCommandLifecycle) {
    const script = this.scripts.shift();
    if (!script) throw new Error('Unexpected fixture launch.');
    this.launches.push(request);
    lifecycle.intent(request);
    lifecycle.owned(this.launches.length);
    let finish!: (value: Awaited<OwnedProjectCommandExecution['terminal']>) => void;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const terminal: Promise<OwnedProjectCommandTerminal> = script.hold
      ? new Promise<OwnedProjectCommandTerminal>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(
          script.terminal ?? {
            code: 0,
            signal: null,
            quiescent: true,
            reason: 'exit' as const,
          },
        );
    if (!script.hold) lifecycle.quiescent(this.launches.length);
    let stopped = false;
    const stream = (channel: 'stdout' | 'stderr', chunks: readonly Uint8Array[] = []) =>
      (async function* () {
        if (script.streamFailure === channel) throw new Error('fixture stream failure');
        if (script.hold) await released;
        for (const chunk of chunks) yield chunk;
      })();
    return {
      stdout: stream('stdout', script.stdout),
      stderr: stream('stderr', script.stderr),
      terminal,
      stop: () => {
        if (!script.hold || stopped) return;
        stopped = true;
        release();
        lifecycle.quiescent(this.launches.length);
        finish({ code: null, signal: 'SIGTERM', quiescent: true, reason: 'stopped' });
      },
    } satisfies OwnedProjectCommandExecution;
  }
}

const workflowRequest = (
  overrides: Partial<Extract<GitHubReadRequest, { kind: 'workflow-run' }>> = {},
): GitHubReadRequest =>
  ({
    kind: 'workflow-run',
    repository,
    headSha,
    runId: '77',
    attempt: 2,
    ...overrides,
  }) satisfies Extract<GitHubReadRequest, { kind: 'workflow-run' }>;

test('GitHub reads bind status and complete logs to owned GET operations', async () => {
  const ansi = Buffer.from('\u001b[31mfailed step\u001b[0m\n');
  const largePrefix = Buffer.alloc(1024 * 1024 + 31, 120);
  const logChunks = [
    ansi,
    largePrefix,
    Buffer.from('\nGITHUB_'),
    Buffer.from('TOKEN=github_pat_secret-value\nlast-byte'),
  ];
  const cases: Array<{
    name: string;
    request: GitHubReadRequest;
    scripts: Script[];
    stop?: 'metadata' | 'content';
    publishFailure?: 'synchronous';
    publishWaitForAbort?: boolean;
    expected: (result: Awaited<ReturnType<typeof startGitHubRead>['result']>) => void;
  }> = [
    {
      name: 'pending',
      request: workflowRequest(),
      scripts: [{ stdout: [bytes(runBody('in_progress', null))] }],
      expected: (result) => {
        assert.equal(result.state, 'complete');
        if (result.state === 'complete' && result.kind === 'workflow-run')
          assert.equal(result.status, 'pending');
      },
    },
    {
      name: 'passed',
      request: workflowRequest(),
      scripts: [{ stdout: [bytes(runBody('completed', 'success'))] }],
      expected: (result) => {
        assert.equal(result.state, 'complete');
        if (result.state === 'complete' && result.kind === 'workflow-run')
          assert.equal(result.status, 'passed');
      },
    },
    {
      name: 'failed',
      request: workflowRequest(),
      scripts: [{ stdout: [bytes(runBody('completed', 'failure'))] }],
      expected: (result) => {
        assert.equal(result.state, 'complete');
        if (result.state === 'complete' && result.kind === 'workflow-run')
          assert.equal(result.status, 'failed');
      },
    },
    {
      name: 'cancelled remote run',
      request: workflowRequest(),
      scripts: [{ stdout: [bytes(runBody('completed', 'cancelled'))] }],
      expected: (result) => {
        assert.equal(result.state, 'complete');
        if (result.state === 'complete' && result.kind === 'workflow-run')
          assert.equal(result.status, 'cancelled');
      },
    },
    {
      name: 'rerun cannot reuse an earlier attempt',
      request: workflowRequest(),
      scripts: [{ stdout: [bytes(runBody('completed', 'success', { run_attempt: 1 }))] }],
      expected: (result) => {
        assert.equal(result.state, 'unavailable');
        if (result.state === 'unavailable') assert.equal(result.reason, 'binding-changed');
      },
    },
    {
      name: 'new head cannot inherit an old green run',
      request: workflowRequest(),
      scripts: [{ stdout: [bytes(runBody('completed', 'success', { head_sha: '3'.repeat(40) }))] }],
      expected: (result) => {
        assert.equal(result.state, 'unavailable');
        if (result.state === 'unavailable') assert.equal(result.reason, 'binding-changed');
      },
    },
    {
      name: 'full log exceeds one frame and redacts across chunks',
      request: {
        kind: 'job-log',
        repository,
        headSha,
        runId: '77',
        attempt: 2,
        jobId: '88',
      },
      scripts: [{ stdout: [bytes(jobBody())] }, { stdout: logChunks }],
      expected: (result) => {
        assert.equal(result.state, 'complete');
        if (result.state !== 'complete' || result.kind !== 'job-log') return;
        assert.equal(result.complete, true);
        assert(result.artifact.bytes > 1024 * 1024);
      },
    },
    {
      name: 'missing authentication stays unavailable',
      request: workflowRequest(),
      scripts: [
        {
          stderr: [bytes('HTTP 401: authentication required; GH_TOKEN=private\n')],
          terminal: { code: 1, signal: null, quiescent: true, reason: 'exit' },
        },
      ],
      expected: (result) => {
        assert.equal(result.state, 'unavailable');
        if (result.state !== 'unavailable') return;
        assert.equal(result.reason, 'missing-authentication');
        assert(!result.diagnostic?.includes('private'));
      },
    },
    {
      name: 'Stop waits for owned closure',
      request: {
        kind: 'job-log',
        repository,
        headSha,
        runId: '77',
        attempt: 2,
        jobId: '88',
      },
      scripts: [{ stdout: [bytes(jobBody())] }, { hold: true }],
      stop: 'content',
      publishWaitForAbort: true,
      expected: (result) => {
        assert.equal(result.state, 'cancelled');
        if (result.state === 'cancelled') assert.equal(result.reason, 'stopped');
      },
    },
    {
      name: 'stream failure stops and closes the owned process',
      request: workflowRequest(),
      scripts: [{ hold: true, streamFailure: 'stdout' }],
      expected: (result) => {
        assert.equal(result.state, 'unavailable');
        if (result.state === 'unavailable') assert.equal(result.reason, 'unavailable');
      },
    },
    {
      name: 'publication setup failure stops and closes the owned process',
      request: {
        kind: 'job-log',
        repository,
        headSha,
        runId: '77',
        attempt: 2,
        jobId: '88',
      },
      scripts: [{ stdout: [bytes(jobBody())] }, { hold: true }],
      publishFailure: 'synchronous',
      expected: (result) => {
        assert.equal(result.state, 'unavailable');
        if (result.state === 'unavailable') assert.equal(result.reason, 'unavailable');
      },
    },
    {
      name: 'pull request read binds its head',
      request: {
        kind: 'pull-request',
        repository,
        headSha,
        pullRequest: '42',
      },
      scripts: [
        {
          stdout: [
            bytes({
              number: 42,
              state: 'open',
              draft: false,
              merged_at: null,
              html_url: 'https://github.com/crew-kite/daily-work/pull/42',
              head: { sha: headSha },
            }),
          ],
        },
      ],
      expected: (result) => {
        assert.equal(result.state, 'complete');
        if (result.state === 'complete' && result.kind === 'pull-request')
          assert.equal(result.status, 'open');
      },
    },
  ];

  for (const scenario of cases) {
    const runner = new FixtureRunner(scenario.scripts);
    const stored: Buffer[] = [];
    const trace: string[] = [];
    const operation = startGitHubRead(
      `read-${scenario.name.replaceAll(' ', '-')}`,
      client,
      scenario.request,
      {
        runner,
        lifecycle: (phase) => ({
          intent: () => trace.push(`${phase}:intent`),
          owned: () => trace.push(`${phase}:owned`),
          quiescent: () => trace.push(`${phase}:quiescent`),
        }),
        publishStream:
          scenario.publishFailure === 'synchronous'
            ? () => {
                throw new Error('fixture publication failure');
              }
            : scenario.publishWaitForAbort
              ? (_source, options) =>
                  new Promise((_, reject) => {
                    const refuse = () => reject(new DOMException('Stopped.', 'AbortError'));
                    if (options?.signal?.aborted) refuse();
                    else options?.signal?.addEventListener('abort', refuse, { once: true });
                  })
              : async (source) => {
                  for await (const chunk of source) {
                    assert(chunk.length <= 64 * 1024, scenario.name);
                    stored.push(Buffer.from(chunk));
                  }
                  const content = Buffer.concat(stored);
                  return {
                    hash: createHash('sha256').update(content).digest('hex'),
                    bytes: content.length,
                  };
                },
        now: () => '2026-10-21T09:00:00.000Z',
      },
    );
    if (scenario.stop === 'metadata') operation.stop();
    if (scenario.stop === 'content') {
      while (runner.launches.length < 2) await new Promise((resolve) => setImmediate(resolve));
      operation.stop();
    }
    const result = await operation.result;
    scenario.expected(result);
    assert.equal(runner.scripts.length, 0, scenario.name);
    for (const [index, launch] of runner.launches.entries()) {
      assert.equal(launch.executable, client.path);
      assert.equal(launch.executableIdentity, 'verified-prelaunch-sha256');
      assert.equal(launch.executableSha256, client.sha256);
      assert.equal(launch.shell, false);
      assert.deepEqual(launch.argv.slice(0, 5), [
        'api',
        '--method',
        'GET',
        '--hostname',
        'github.com',
      ]);
      const content = scenario.request.kind === 'job-log' && index === 1;
      assert.equal(launch.argv.includes('--allow-escape-sequences'), content, scenario.name);
      assert(!launch.argv.some((value) => /login|token|rerun|cancel|dispatch/i.test(value)));
      assert.deepEqual(launch.environment, {
        HOME: '/home/example',
        PATH: '/usr/bin:/bin',
        GH_HOST: 'github.com',
        GH_PROMPT_DISABLED: '1',
        GH_PAGER: 'cat',
        NO_COLOR: '1',
      });
    }
    if (scenario.name.includes('full log')) {
      const retained = Buffer.concat(stored);
      assert(retained.subarray(0, ansi.length).equals(ansi));
      assert(!retained.includes(Buffer.from('github_pat_')));
      assert(!retained.includes(Buffer.from('secret-value')));
      assert(retained.subarray(-9).equals(Buffer.from('last-byte')));
      assert.equal(result.state, 'complete');
      if (result.state === 'complete' && result.kind === 'job-log')
        assert.equal(result.artifact.hash, createHash('sha256').update(retained).digest('hex'));
      assert.deepEqual(runner.launches[1]?.argv, [
        'api',
        '--method',
        'GET',
        '--hostname',
        'github.com',
        '--header',
        'Accept: application/vnd.github+json',
        '--header',
        'X-GitHub-Api-Version: 2022-11-28',
        '--allow-escape-sequences',
        '/repos/crew-kite/daily-work/actions/jobs/88/logs',
      ]);
    }
    assert.equal(
      trace.at(-1),
      `${runner.launches.length === 2 ? 'content' : 'metadata'}:quiescent`,
      scenario.name,
    );
  }
});
