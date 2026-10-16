import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { groupAbsent } from '../../host/worker.ts';
import {
  GoogleWriterError,
  GoogleWriterOutput,
  googleVersionEligible,
  projectGoogleCreditSetting,
  runGoogleWriter,
} from './native-writer.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const original = 'export const total = 0;\n';
const file = { path: 'net.mjs', baseHash: hash(original), content: original };
const attemptId = 'att_01M51M322B2AEBXD9MA74CBCFM';
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
const start={event:'init',conversation_id:'session',init:{cwd:process.cwd(),tools:['view_file'],permission_mode:'request-review',model:value('--model')}};
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
    const wire = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    const decoderCases = [
      { name: 'fragmented valid stream', events: [start, end], ok: true },
      { name: 'result before init', events: [end] },
      { name: 'duplicate init', events: [start, start, end] },
      {
        name: 'unknown event',
        events: [start, { event: 'future', private: 'private@example.test' }],
      },
      {
        name: 'unrestricted permission mode',
        events: [{ ...start, init: { ...start.init, permission_mode: 'always-proceed' } }, end],
      },
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
        events: [
          start,
          { ...end, result: { ...end.result, usage: { ...usage, input_tokens: -1 } } },
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
        permissionMode: 'request-review',
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
      if (entry.ok) assert.deepEqual(read().replacement, replacement, entry.name);
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
    for (const mode of [
      'good',
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
      if (mode === 'good')
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
      if (['old-build', 'missing-evidence', 'billing-unknown', 'hash-mismatch'].includes(mode))
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
