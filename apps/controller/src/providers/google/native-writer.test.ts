import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { spawnCheckChild as spawn } from '../../host/check-ownership.ts';
import { groupAbsent } from '../../host/worker.ts';
import {
  GoogleWriterError,
  GoogleWriterOutput,
  googleVersionEligible,
  projectGoogleConfig,
  projectGoogleCreditSetting,
  runGoogleWriter,
  startGoogleConfig,
  startGoogleWriter,
} from './native-writer.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const original = 'export const total = 0;\n';
const file = { path: 'net.mjs', baseHash: hash(original), content: original };
const attemptId = 'att_01M51M322B2AEBXD9MA74CBCFM';
const permissionModes = [
  'request-review',
  'strict',
  'always-proceed',
  'proceed-in-sandbox',
] as const;
const replacement = { attemptId, ...file, content: 'export const total = 1;\n' };
const usage = {
  input_tokens: 1,
  output_tokens: 2,
  thinking_tokens: 0,
  cache_read_tokens: 0,
  total_tokens: 3,
};

test('the google writer returns a bounded replacement only after its admitted process is quiescent', async () => {
  mkdirSync(resolve('internal'), { recursive: true });
  const home = mkdtempSync(resolve('internal/google-writer-'));
  const directory = join(home, 'scratch');
  const runtime = join(home, 'runtime');
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(runtime, { mode: 0o700 });
  const groups: number[] = [];
  const executable = join(runtime, 'fixture');
  const fixture = String.raw`#!${process.execPath}
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const args=process.argv.slice(2);
const value=flag=>args[args.indexOf(flag)+1];
const prompt=value('--print');
const mode=prompt.split('Task: ')[1].split('\nFile: ')[0];
const file=JSON.parse(prompt.split('\nFile: ')[1]);
assert(args.includes('--sandbox')&&args.includes('--disable-slash-commands'));
assert(!args.includes('--dangerously-skip-permissions'));
assert(process.env.HOME&&process.env.USER&&process.env.LOGNAME);
assert(Object.keys(process.env).every(key=>['HOME','USER','LOGNAME','PATH','LANG','TERM','NO_COLOR','TMPDIR','__CF_USER_TEXT_ENCODING'].includes(key)),JSON.stringify(Object.keys(process.env)));
const permissionMode=['strict','always-proceed','proceed-in-sandbox'].includes(mode)?mode:'request-review';
const start={event:'init',conversation_id:'session',init:{cwd:process.cwd(),tools:['view_file'],permission_mode:permissionMode,model:value('--model')}};
const result={event:'result',result:{conversation_id:mode==='wrong-session'?'other':'session',status:mode==='failed'?'ERROR':'SUCCESS',response:'discarded',duration_seconds:0,num_turns:1,usage:${JSON.stringify(usage)},structured_output:{...file,content:'export const total = 1;\n'}}};
if(mode==='startup-notice') process.stdout.write(JSON.stringify({event:'future',message:'private@example.test'})+'\n');
else if(mode==='invalid-utf8') process.stdout.write(Buffer.from([255,10]));
else if(mode==='oversized')process.stdout.write('x'.repeat(1048577));
else {
 process.stdout.write(JSON.stringify(start)+'\n');
 process.stdout.write(JSON.stringify(result)+(mode==='truncated'?'':'\n'));
 if(mode==='descendant') { spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});process.exit(0); }
}
`;
  writeFileSync(executable, fixture, { mode: 0o700 });
  const client = { executable, version: '1.1.12', sha256: hash(readFileSync(executable)) };
  const admission = {
    clientExecutable: executable,
    clientVersion: client.version,
    clientSha256: client.sha256,
    checkedAt: '2026-10-16T00:00:00Z',
    nativeTrust: 'accepted' as const,
    permissions: 'request-review' as const,
    billing: 'subscription-only' as const,
    extraCredits: 'disabled' as const,
    evidence: {
      nativePermissions: 'fixture:permissions',
      subscriptionBilling: 'fixture:subscription',
      paidCreditsDisabled: 'fixture:no-credits',
    },
    model: 'fixture-model',
    effort: 'medium' as const,
  };
  try {
    for (const [version, eligible] of [
      ['1.1.10', false],
      ['1.1.11', false],
      ['1.1.12', true],
      ['1.3.4', true],
      ['2.0.0', false],
      ['1.1.12-beta', false],
    ] as const)
      assert.equal(googleVersionEligible(version), eligible);
    for (const [settings, projected] of [
      [{ useG1Credits: false, email: 'private@example.test' }, 'disabled'],
      [{ useG1Credits: true }, 'enabled'],
      [{ token: 'private' }, 'unknown'],
      [{ useG1Credits: 'false' }, 'unknown'],
    ] as const)
      assert.equal(projectGoogleCreditSetting(settings), projected);
    const start = {
      event: 'init',
      conversation_id: 'session',
      init: {
        cwd: directory,
        model: admission.model,
        permission_mode: 'request-review',
        tools: [],
      },
    };
    const end = {
      event: 'result',
      result: {
        conversation_id: 'session',
        status: 'SUCCESS',
        response: 'discarded',
        duration_seconds: 0,
        num_turns: 1,
        usage,
        structured_output: replacement,
      },
    };
    const step = {
      event: 'step_update',
      step_update: { conversation_id: 'session', step_index: 1, state: 'ACTIVE' },
    };
    const wire = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    const decoderCases = [
      { name: 'fragmented valid stream', events: [start, end], ok: true },
      ...permissionModes.map((permissionMode) => ({
        name: `matching native permission mode ${permissionMode}`,
        permissionMode,
        events: [{ ...start, init: { ...start.init, permission_mode: permissionMode } }, end],
        ok: true,
      })),
      {
        name: 'step category may be omitted across producer state transitions',
        events: [
          start,
          step,
          { ...step, step_update: { ...step.step_update, state: 'ERROR' } },
          { ...step, step_update: { ...step.step_update, state: 'DONE' } },
          end,
        ],
        ok: true,
      },
      {
        name: 'producer step categories remain bounded metadata',
        events: [
          start,
          ...[
            'user_input',
            'agent_response',
            'tool',
            'checkpoint',
            'finish',
            'unknown',
            'subagent',
            'system_message',
            'error_message',
          ].map((step_type) => ({
            ...step,
            step_update: { ...step.step_update, step_type },
          })),
          end,
        ],
        ok: true,
      },
      {
        name: 'unknown step category',
        field: 'step_type',
        events: [
          start,
          { ...step, step_update: { ...step.step_update, step_type: 'private@example.test' } },
          end,
        ],
      },
      {
        name: 'unknown step state',
        field: 'state',
        events: [
          start,
          { ...step, step_update: { ...step.step_update, state: 'private@example.test' } },
          end,
        ],
      },
      {
        name: 'step session required',
        events: [
          start,
          { ...step, step_update: { ...step.step_update, conversation_id: undefined } },
          end,
        ],
      },
      {
        name: 'step index required',
        field: 'step_index',
        events: [
          start,
          { ...step, step_update: { ...step.step_update, step_index: undefined } },
          end,
        ],
      },
      {
        name: 'step state required',
        events: [start, { ...step, step_update: { ...step.step_update, state: undefined } }, end],
      },
      {
        name: 'step session remains bound',
        events: [
          start,
          { ...step, step_update: { ...step.step_update, conversation_id: 'foreign' } },
          end,
        ],
      },

      {
        name: 'error step alone supplies no successful terminal result',
        events: [start, { ...step, step_update: { ...step.step_update, state: 'ERROR' } }],
      },
      { name: 'result before init', events: [end] },
      { name: 'duplicate init', events: [start, start, end] },
      {
        name: 'unknown event',
        events: [start, { event: 'future', private: 'private@example.test' }],
      },
      {
        name: 'reported permission mode must match admission',
        events: [{ ...start, init: { ...start.init, permission_mode: 'always-proceed' } }, end],
      },
      {
        name: 'admitted mode must match reported permission mode',
        permissionMode: 'always-proceed' as const,
        events: [start, end],
      },
      ...[
        { name: 'unknown permission mode', value: 'private@example.test' },
        { name: 'missing permission mode', value: undefined },
        { name: 'wrong permission mode type', value: 7 },
      ].map(({ name, value }) => ({
        name,
        field: 'permission_mode',
        events: [{ ...start, init: { ...start.init, permission_mode: value } }, end],
      })),
      {
        name: 'wrong directory',
        events: [{ ...start, init: { ...start.init, cwd: '/outside' } }, end],
      },
      { name: 'wrong model', events: [{ ...start, init: { ...start.init, model: 'other' } }, end] },
      {
        name: 'malformed model',
        events: [{ ...start, init: { ...start.init, model: 7 } }],
        field: 'model',
      },
      {
        name: 'malformed tools',
        events: [{ ...start, init: { ...start.init, tools: 7 } }],
        field: 'tools',
      },
      {
        name: 'wrong file',
        events: [
          start,
          {
            ...end,
            result: { ...end.result, structured_output: { ...replacement, path: '../other' } },
          },
        ],
      },
      {
        name: 'wrong base',
        events: [
          start,
          {
            ...end,
            result: {
              ...end.result,
              structured_output: { ...replacement, baseHash: '0'.repeat(64) },
            },
          },
        ],
      },
      {
        name: 'negative usage',
        field: 'input_tokens',
        events: [
          start,
          { ...end, result: { ...end.result, usage: { ...usage, input_tokens: -1 } } },
        ],
      },
      {
        name: 'NUL replacement text',
        field: 'content',
        events: [
          start,
          {
            ...end,
            result: { ...end.result, structured_output: { ...replacement, content: 'text\0tail' } },
          },
        ],
      },
      { name: 'terminal duplication', events: [start, end, end] },
      { name: 'incomplete stream', events: [start] },
      {
        name: 'no structured result',
        events: [start, { ...end, result: { ...end.result, structured_output: undefined } }],
      },
      {
        name: 'extra replacement field',
        events: [
          start,
          {
            ...end,
            result: {
              ...end.result,
              structured_output: { ...replacement, private: 'private@example.test' },
            },
          },
        ],
      },
    ];
    for (const entry of decoderCases) {
      const reader = new GoogleWriterOutput({
        attemptId,
        permissionMode:
          ('permissionMode' in entry ? entry.permissionMode : undefined) ?? 'request-review',
        directory,
        model: admission.model,
        path: file.path,
        baseHash: file.baseHash,
      });
      const read = () => {
        for (const value of entry.events) {
          const bytes = wire(value);
          for (const byte of bytes) reader.push(new Uint8Array([byte]));
        }
        return reader.finish();
      };
      if ('ok' in entry && entry.ok) assert.deepEqual(read().replacement, replacement, entry.name);
      else {
        assert.throws(
          read,
          (error) => error instanceof GoogleWriterError && !error.message.includes('private'),
          entry.name,
        );
        const diagnostic = reader.diagnostic;
        assert(diagnostic, entry.name);
        if ('field' in entry) assert.equal(diagnostic.field, entry.field, entry.name);
        assert(Object.isFrozen(diagnostic), entry.name);
        assert(!JSON.stringify(diagnostic).includes('private'), entry.name);
        assert.throws(
          () => reader.finish(),
          (error) => error instanceof GoogleWriterError && error.diagnostic === diagnostic,
          entry.name,
        );
      }
    }
    const config = {
      status: 'SUCCESS',
      num_turns: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        thinking_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 0,
      },
      command: {
        data: {
          config: {
            toolPermission: 'request-review',
            useG1Credits: false,
            artifactReviewPolicy: 'agent-decides',
            enableTerminalSandbox: false,
            allowNonWorkspaceAccess: false,
            email: 'private@example.test',
            token: 'private-canary',
          },
        },
      },
    };
    const projected = projectGoogleConfig(Buffer.from(JSON.stringify(config)));
    assert.deepEqual(projected, {
      permissionMode: 'request-review',
      creditFallback: 'disabled',
      artifactReviewPolicy: 'agent-decides',
      allowNonWorkspaceAccess: false,
      enableTerminalSandbox: false,
      account: 'unknown',
      billing: 'unknown',
      observedTurns: 0,
    });
    assert(!JSON.stringify(projected).includes('private'));
    for (const invalid of [
      { ...config, status: 'ERROR' },
      { ...config, num_turns: 1 },
      { ...config, usage: { ...config.usage, total_tokens: 1 } },
      {
        ...config,
        command: { data: { config: { ...config.command.data.config, useG1Credits: true } } },
      },
      {
        ...config,
        command: {
          data: { config: { ...config.command.data.config, toolPermission: 'unrecognized' } },
        },
      },
    ])
      assert.throws(
        () => projectGoogleConfig(Buffer.from(JSON.stringify(invalid))),
        GoogleWriterError,
      );
    assert.throws(
      () => projectGoogleConfig(Buffer.from('private-canary')),
      (error) => error instanceof GoogleWriterError && !error.message.includes('private'),
    );
    for (const row of [
      'success',
      'nonzero',
      'unexpected-turn',
      'auth-needed',
      'owned-reject',
      'quiescent-reject',
    ] as const) {
      const events: string[] = [];
      const output = row === 'unexpected-turn' ? { ...config, num_turns: 1 } : config;
      const script = `${row === 'auth-needed' ? "process.stderr.write('authentication required private-canary');" : ''}process.stdout.write(${JSON.stringify(JSON.stringify(output))});${row === 'nonzero' ? 'process.exitCode=1;' : ''}`;
      const handle = startGoogleConfig({
        client,
        repositoryRoot: resolve('.'),
        directory,
        temporaryDirectory: runtime,
        timeoutMs: 3000,
        environment: {
          ...process.env,
          GOOGLE_API_KEY: 'private-canary',
          GOOGLE_APPLICATION_CREDENTIALS: 'private-canary',
        },
        spawn: (_, args, options) => {
          assert.deepEqual(args.slice(0, 4), ['-p', '/config', '--output-format', 'json']);
          events.push('spawn');
          const child = spawn(process.execPath, ['-e', script], options);
          if (child.pid) groups.push(child.pid);
          assert(!('GOOGLE_API_KEY' in (options?.env ?? {})));
          return child;
        },
        lifecycle: {
          beforePhase: (phase) => {
            assert.equal(phase, 'config');
            events.push('intent');
          },
          owned: (_, group) => {
            assert(group > 0);
            events.push('owned');
            if (row === 'owned-reject') return Promise.reject(new Error('private-canary')) as never;
          },
          quiescent: (_, group) => {
            assert(groupAbsent(group));
            events.push('quiescent');
            if (row === 'quiescent-reject') throw new Error('private-canary');
          },
        },
      });
      const outcome = await handle.result;
      assert.equal(outcome.quiescent, true, row);
      assert(groupAbsent(handle.group));
      assert.deepEqual(events, ['intent', 'spawn', 'owned', 'quiescent']);
      if (row === 'success') {
        assert.equal(outcome.reason, null);
        assert.deepEqual(outcome.metadata, projected);
      } else {
        assert.equal(outcome.metadata, null);
        assert(outcome.reason, row);
        assert(!JSON.stringify(outcome).includes('private'));
      }
    }
    for (const row of [
      'success',
      'before-reject',
      'before-deadline',
      'missing-submission-hook',
      'submission-reject',
      'submission-deadline',
      'submission-abort',
      'owned-reject',
      'owned-thenable',
      'quiescent-reject',
      'quiescent-deadline',
      'stop',
    ] as const) {
      let tick = 0;
      const events: string[] = [];
      const abort = new AbortController();
      const selected = { ...file, path: 'src/日本 語.js' };
      const options = {
        client,
        admission,
        attemptId,
        repositoryRoot: resolve('.'),
        directory,
        temporaryDirectory: runtime,
        file: selected,
        task: 'good',
        timeoutMs: 3000,
        deadline: 3000,
        now: () => tick,
        signal: abort.signal,
        onSubmitted: (row === 'missing-submission-hook'
          ? undefined
          : () => {
              events.push('submitted');
              if (row === 'submission-reject') throw new Error('private-canary');
              if (row === 'submission-deadline') tick = 1600;
              if (row === 'submission-abort') abort.abort();
            }) as () => void,
        spawn: (command, args, options) => {
          events.push('spawn');
          assert(events.includes('submitted'));
          const child = spawn(command, args, options);
          if (child.pid) groups.push(child.pid);
          return child;
        },
        lifecycle: {
          beforePhase: (phase) => {
            assert.equal(phase, 'task');
            events.push('intent');
            if (row === 'before-reject') throw new Error('private-canary');
            if (row === 'before-deadline') tick = 1600;
          },
          owned: () => {
            events.push('owned');
            if (row === 'owned-reject') throw new Error('private-canary');
            if (row === 'owned-thenable')
              return Promise.reject(new Error('private-canary')) as never;
          },
          quiescent: (_, group: number) => {
            assert(groupAbsent(group));
            events.push('quiescent');
            if (row === 'quiescent-reject') throw new Error('private-canary');
            if (row === 'quiescent-deadline') tick = 3001;
          },
        },
      } satisfies Parameters<typeof startGoogleWriter>[0];
      if (
        [
          'before-reject',
          'before-deadline',
          'missing-submission-hook',
          'submission-reject',
          'submission-deadline',
          'submission-abort',
        ].includes(row)
      ) {
        assert.throws(
          () => startGoogleWriter(options),
          (error) => error instanceof GoogleWriterError && !error.message.includes('private'),
          row,
        );
        assert(!events.includes('spawn'), row);
        assert.equal(
          events.filter((value) => value === 'submitted').length,
          row.startsWith('submission-') ? 1 : 0,
          row,
        );
      } else {
        const handle = startGoogleWriter(options);
        if (row === 'stop') handle.stop();
        const outcome = await handle.result;
        assert.equal(outcome.quiescent, true, row);
        assert(groupAbsent(handle.group));
        assert.deepEqual(events, ['intent', 'submitted', 'spawn', 'owned', 'quiescent']);
        if (row === 'success') {
          assert.equal(outcome.reason, null);
          assert.equal(outcome.metadata?.replacement.path, selected.path);
          assert.equal(outcome.metadata?.conversationId, 'session');
        } else {
          assert.equal(outcome.metadata, null);
          assert(outcome.reason, row);
          assert(!JSON.stringify(outcome).includes('private'));
        }
      }
    }
    for (const content of ['text\0tail', '\ud800'])
      await assert.rejects(
        runGoogleWriter({
          client,
          admission,
          attemptId,
          repositoryRoot: resolve('.'),
          directory,
          temporaryDirectory: runtime,
          logFile: join(runtime, 'invalid-text.log'),
          file: { ...file, content, baseHash: hash(content) },
          task: 'good',
          timeoutMs: 3000,
          onSpawn: () => assert.fail('invalid text must not spawn'),
        }),
        GoogleWriterError,
      );
    for (const mode of [
      'good',
      ...permissionModes.slice(1),
      'unknown-permission',
      'cancelled',
      'wrong-session',
      'failed',
      'truncated',
      'invalid-utf8',
      'startup-notice',
      'oversized',
      'descendant',
      'old-build',
      'missing-evidence',
      'billing-unknown',
      'hash-mismatch',
    ]) {
      let spawned = false;
      const abort = new AbortController();
      const options = {
        client: mode === 'old-build' ? { ...client, version: '1.1.10' } : client,
        admission: {
          ...admission,
          permissions:
            mode === 'unknown-permission'
              ? 'private@example.test'
              : (permissionModes.find((value) => value === mode) ?? admission.permissions),
          ...(mode === 'old-build' ? { clientVersion: '1.1.10' } : {}),
          ...(mode === 'missing-evidence' ? { evidence: undefined } : {}),
          ...(mode === 'billing-unknown' ? { billing: 'unknown' } : {}),
        } as typeof admission,
        attemptId,
        repositoryRoot: resolve('.'),
        directory,
        temporaryDirectory: runtime,
        logFile: join(runtime, `${mode}.log`),
        file: mode === 'hash-mismatch' ? { ...file, baseHash: '0'.repeat(64) } : file,
        task: mode,
        timeoutMs: 3000,
        signal: abort.signal,
        onSpawn: (group: number) => {
          spawned = true;
          groups.push(group);
          if (mode === 'cancelled') abort.abort();
        },
      };
      if (mode === 'good' || permissionModes.some((value) => value === mode))
        assert.deepEqual((await runGoogleWriter(options)).replacement, replacement);
      else
        await assert.rejects(
          runGoogleWriter(options),
          (error) =>
            error instanceof GoogleWriterError &&
            (mode !== 'cancelled' || error.reason === 'cancelled') &&
            (mode !== 'startup-notice' ||
              (error.diagnostic?.event === 'other' &&
                error.diagnostic.stage === 'before-init' &&
                Object.isFrozen(error.diagnostic) &&
                !JSON.stringify(error.diagnostic).includes('private'))),
          mode,
        );
      if (mode === 'cancelled') {
        assert.equal(spawned, true);
        assert(groupAbsent(groups.at(-1) ?? null));
      }
      if (
        [
          'old-build',
          'missing-evidence',
          'billing-unknown',
          'hash-mismatch',
          'unknown-permission',
        ].includes(mode)
      )
        assert.equal(spawned, false, mode);
    }
  } finally {
    for (const group of groups) {
      if (!groupAbsent(group)) {
        try {
          process.kill(-group, 'SIGKILL');
        } catch {}
      }
    }
    assert(
      groups.every(groupAbsent),
      'every fixture group must be absent before deleting its files',
    );
    rmSync(home, { recursive: true, force: true });
  }
});
