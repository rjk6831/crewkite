import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { clientRecord } from '../client-record.ts';
import { CLIENT_VERSIONS, parseClientVersion } from '../client-versions.ts';
import { fileDigestSync } from '../file-digest.ts';
import { chatArguments, frameSchemas } from './chat.ts';
import { readAnthropicModels } from './models.ts';
import {
  flagsIn,
  OPTIONAL_FLAGS,
  PASSED_FLAGS,
  parseInitializeReply,
  RESULT_SUBTYPES,
  UNLISTED_FLAGS,
} from './protocol.ts';
import { replacementPlan } from './replacement.ts';
import { anthropicUsageReaderPlan } from './usage-reader.ts';

// The Claude Code section of scripts/protocol-check.mjs. It runs a published build with no
// account and no model call, in an environment that holds no credentials. The flag list comes
// from the build's own help, a value the build refuses comes back as a parse error before any
// prompt, and the initialize request answers from local state.

export const name = 'Claude Code';
export const npmPackage = '@anthropic-ai/claude-code';
export function executable(prefix: string) {
  return join(prefix, 'node_modules', '.bin', 'claude');
}

export type Row = {
  request: string;
  shape: string;
  result: 'accepted' | 'refused' | 'warning';
  detail: string;
};
export type Validate = (schema: unknown, value: unknown) => string[];

const PROBE = '--zz-crewkite-probe';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// The flags whose values the build checks against a list of choices.
const VALUED = ['--permission-mode', '--permission-prompts', '--input-format', '--output-format'];
// Words that make a changelog line worth a look. The job summary prints each line that has one.
const WATCH = /(?:^|[\s`(])-p\b|stream-json|permission|--bare|deprecated|removed/i;

const flagsOf = (argv: readonly string[]) => argv.filter((token) => /^--[A-Za-z]/.test(token));

function builders() {
  const chat = chatArguments(
    {
      selection: { model: 'probe', effort: 'high' },
      readOnly: true,
      permissionPolicy: 'ask',
      subagents: false,
      mcp: { servers: [] },
    } as unknown as Parameters<typeof chatArguments>[0],
    'resume-probe',
    ['/tmp/probe'],
    { name: 'crewkite', command: 'node', args: ['probe'] } as unknown as Parameters<
      typeof chatArguments
    >[3],
    () => '{}',
  ).argv;
  const usage = anthropicUsageReaderPlan({
    clientSha256: 'a'.repeat(64),
    clientVersion: CLIENT_VERSIONS.anthropic.tested,
    sessionId: randomUUID(),
  }).argv;
  const original = 'export const probe = 1;\n';
  const writer = replacementPlan({
    attemptId: 'att_00000000000000000000000001',
    sessionId: randomUUID(),
    model: 'probe',
    effort: 'low',
    baseHash: createHash('sha256').update(original).digest('hex'),
    original,
    criteria: ['probe'],
  }).argv;
  return { chat, usage, writer };
}

/** A parse error from the build before any prompt: the dry call that needs no account. */
function dry(binary: string, home: string, argv: readonly string[]) {
  const run = spawnSync(binary, [...argv, PROBE], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, LANG: 'C', NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const said = `${run.stderr}${run.stdout}`.replace(/\s+/g, ' ').trim();
  // Reaching the probe flag means every flag before it parsed. Anything else is the build's refusal.
  const reached = said.includes(`unknown option '${PROBE}'`) && !/Unknown --|invalid/.test(said);
  return { reached, said: said.slice(0, 200) };
}

async function changelog(tested: string): Promise<Row[]> {
  try {
    const response = await fetch(
      'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md',
      { signal: AbortSignal.timeout(20_000) },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const floor = parseClientVersion(tested)?.core ?? [0, 0, 0];
    const rows: Row[] = [];
    let entries = 0;
    let at: string | null = null;
    for (const line of (await response.text()).split('\n')) {
      const heading = /^## (\d+)\.(\d+)\.(\d+)\s*$/.exec(line);
      if (heading) {
        const core = [Number(heading[1]), Number(heading[2]), Number(heading[3])];
        const newer =
          core[0] !== floor[0]
            ? core[0] > floor[0]
            : core[1] !== floor[1]
              ? core[1] > floor[1]
              : core[2] > floor[2];
        at = newer ? `${core.join('.')}` : null;
        if (newer) entries++;
      } else if (at && WATCH.test(line) && rows.length < 60)
        rows.push({
          request: 'changelog',
          shape: at,
          result: 'warning',
          detail: line.replace(/^-\s*/, '').slice(0, 300),
        });
    }
    rows.unshift({
      request: 'changelog',
      shape: `after ${tested}`,
      result: 'accepted',
      detail: `${entries} newer ${entries === 1 ? 'entry' : 'entries'}, ${rows.length} with a watched word`,
    });
    return rows;
  } catch (error) {
    return [
      {
        request: 'changelog',
        shape: `after ${tested}`,
        result: 'warning',
        detail: `could not be read: ${error instanceof Error ? error.message : 'unknown error'}`,
      },
    ];
  }
}

export async function check(context: { binary: string; work: string; validate: Validate }) {
  const { binary, work } = context;
  const rows: Row[] = [];
  const home = join(work, 'home');
  mkdirSync(home, { recursive: true });
  const environment = { PATH: process.env.PATH, HOME: home, LANG: 'C', NO_COLOR: '1' };
  const version = parseClientVersion(
    spawnSync(binary, ['--version'], { encoding: 'utf8', env: environment }).stdout,
  );
  const help = spawnSync(binary, ['--help'], { encoding: 'utf8', env: environment }).stdout;
  const listed = flagsIn(help);

  // The flags each adapter passes, from the adapters' own builders.
  const plans = builders();
  for (const [plan, argv] of Object.entries(plans)) {
    const passed = flagsOf(argv);
    const unknown = passed.filter((flag) => !PASSED_FLAGS.includes(flag));
    const missing = passed.filter((flag) => !listed.has(flag) && !UNLISTED_FLAGS.has(flag));
    const required = missing.filter((flag) => !OPTIONAL_FLAGS.has(flag));
    rows.push({
      request: 'flags',
      shape: plan,
      result:
        unknown.length || required.length ? 'refused' : missing.length ? 'warning' : 'accepted',
      detail:
        [
          unknown.length ? `${unknown.join(', ')} not in the watched list` : null,
          required.length ? `${required.join(', ')} not listed by the build` : null,
          missing.length > required.length
            ? `${missing.filter((flag) => OPTIONAL_FLAGS.has(flag)).join(', ')} optional and not listed`
            : null,
        ]
          .filter(Boolean)
          .join('; ') || `${passed.length} flags listed`,
    });
  }

  // The values the build checks, and the flag the help leaves out.
  const values = new Map<string, Set<string>>();
  for (const argv of Object.values(plans))
    for (const [index, token] of argv.entries())
      if (VALUED.includes(token) && argv[index + 1] !== undefined) {
        const set = values.get(token) ?? new Set<string>();
        set.add(argv[index + 1]);
        values.set(token, set);
      }
  const calls: Array<[string, string[]]> = [
    ...[...values].flatMap(([flag, set]) =>
      [...set].map((value): [string, string[]] => [`${flag} ${value}`, [flag, value]]),
    ),
    ...EFFORTS.map((level): [string, string[]] => [`--effort ${level}`, ['--effort', level]]),
    ['--permission-prompt-tool stdio', ['--permission-prompt-tool', 'stdio']],
  ];
  for (const [shape, argv] of calls) {
    const { reached, said } = dry(binary, home, argv);
    rows.push({
      request: 'value',
      shape,
      result: reached ? 'accepted' : 'refused',
      detail: reached ? 'parsed' : said,
    });
  }

  // The initialize request, through the same reader the controller uses. It answers from local
  // state, so no account and no prompt are involved.
  const client = realpathSync(binary);
  const models = await readAnthropicModels({
    executable: client,
    sha256: fileDigestSync(client),
    environment,
    directory: join(work, 'models'),
    timeoutMs: 30_000,
  });
  const record = clientRecord('anthropic');
  rows.push({
    request: 'initialize',
    shape: 'models',
    result: models?.length ? 'accepted' : 'refused',
    detail: models?.length ? `${models.length} rows` : 'no model rows parsed',
  });
  rows.push({
    request: 'initialize',
    shape: 'capabilities',
    result: record ? 'accepted' : 'refused',
    detail: record ? `${record.capabilities.join(', ') || 'none listed'}` : 'no reply recorded',
  });

  // Recorded frames, through the parsers the adapter uses.
  const frames = readFileSync(new URL('./protocol-frames.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; subtype?: string });
  for (const frame of frames) {
    const shape = `${frame.type}/${frame.subtype ?? ''}`;
    const ok =
      frame.type === 'control_response'
        ? parseInitializeReply(frame) !== null
        : frame.type === 'system'
          ? frameSchemas.init.safeParse(frame).success
          : frame.type === 'control_request'
            ? frameSchemas.control.safeParse(frame).success
            : frame.type === 'result'
              ? frameSchemas.result.safeParse(frame).success &&
                RESULT_SUBTYPES.has(frame.subtype ?? '')
              : false;
    rows.push({
      request: 'replay',
      shape,
      result: ok ? 'accepted' : 'refused',
      detail: ok ? 'parsed' : 'the parser refused a recorded frame',
    });
  }

  // The documentation says --bare will become the default for -p, and bare mode never reads the
  // sign-in. A build that lists a flag to turn it off is the one the adapters should pass.
  const bare = /--bare\b[\s\S]{0,1200}?(?=\n {2}--[a-z]|\n {2}-[a-z],)/i.exec(help)?.[0] ?? '';
  const nonBare = [...listed].filter((flag) => /^--(no-bare|full|oauth|keychain)/.test(flag));
  const becameDefault =
    /default (?:for|under|with) (?:-p|--print)|bare (?:is|mode is) (?:now )?the default/i.test(
      help.replace(/\s+/g, ' '),
    );
  rows.push({
    request: 'bare',
    shape: '--bare',
    result: becameDefault && !nonBare.length ? 'refused' : nonBare.length ? 'warning' : 'accepted',
    detail: becameDefault
      ? nonBare.length
        ? `bare is the default for -p; ${nonBare.join(', ')} turns it off and the adapters do not pass it`
        : 'bare is the default for -p and no flag turns it off, so a subscription sign-in is never read'
      : bare
        ? `opt-in; no flag turns it off (${nonBare.join(', ') || 'none listed'}), so the adapters pass none`
        : 'not listed',
  });

  rows.push(...(await changelog(CLIENT_VERSIONS.anthropic.tested)));
  return { version: version?.text ?? 'unreadable', rows };
}
