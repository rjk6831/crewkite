import { z } from 'zod';

// What CrewKite sends the Anthropic client and what it expects back that can change between
// builds, in one place. The flags come from the client's own --help, the capability list from its
// own handshake, so a release that moves one shows up here first. scripts/protocol-check.mjs
// runs this file's lists against a published build.

/**
 * Flags an adapter may drop when the build does not list them, with the number of values each
 * takes. Dropping one changes the turn's detail and never its limits: partial messages only
 * stream text sooner, the effort level falls back to the client's default, and the other two keep
 * a read from touching Chrome or the session store.
 */
export const OPTIONAL_FLAGS: ReadonlyMap<string, number> = new Map([
  ['--include-partial-messages', 0],
  ['--effort', 1],
  ['--no-chrome', 0],
  ['--no-session-persistence', 0],
]);

/**
 * Every flag the chat turn, the model read, the usage read and the writer pass. A flag that
 * limits what the client may do is never optional: a build that does not know it is reported,
 * and the client's own unknown option error ends the launch.
 */
export const PASSED_FLAGS: readonly string[] = [
  '--add-dir',
  '--allowedTools',
  '--disable-slash-commands',
  '--disallowedTools',
  '--effort',
  '--include-partial-messages',
  '--input-format',
  '--json-schema',
  '--mcp-config',
  '--model',
  '--no-chrome',
  '--no-session-persistence',
  '--output-format',
  '--permission-mode',
  '--permission-prompt-tool',
  '--permission-prompts',
  '--print',
  '--restricted',
  '--resume',
  '--safe-mode',
  '--session-id',
  '--setting-sources',
  '--settings',
  '--strict-mcp-config',
  '--tools',
  '--verbose',
];

/**
 * Passed flags that a help text does not list. The SDK flag for permission prompts is hidden, so
 * a build that has it can still leave it out of --help.
 */
export const UNLISTED_FLAGS: ReadonlySet<string> = new Set(['--permission-prompt-tool']);

/** The flag names a help text lists, including the ones a description mentions. */
export function flagsIn(help: string): Set<string> {
  const names = new Set<string>();
  for (const match of help.matchAll(/(?:^|[\s,[(|`'"])(--[A-Za-z][A-Za-z0-9-]*)/g))
    names.add(match[1]);
  return names;
}

/** The flags in an argument list, one per flag position. Values that start with dashes are not read. */
export function flagsPassed(argv: readonly string[]): string[] {
  const found = new Set<string>();
  for (const token of argv) if (PASSED_FLAGS.includes(token)) found.add(token);
  return [...found].sort();
}

/**
 * The argument list without the optional flags the build does not know, and the flags dropped.
 * With no list for the build, every flag stays and the client's own reply decides.
 */
export function withKnownFlags(argv: readonly string[], known: ReadonlySet<string> | null) {
  if (!known) return { argv: [...argv], dropped: [] as string[] };
  const kept: string[] = [];
  const dropped: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const values = OPTIONAL_FLAGS.get(argv[at]);
    if (values === undefined || known.has(argv[at])) {
      kept.push(argv[at]);
      continue;
    }
    dropped.push(argv[at]);
    at += values;
  }
  return { argv: kept, dropped };
}

// The flag lists of builds already probed, by the digest of the file. A probe runs once per build.
const flagLists = new Map<string, ReadonlySet<string>>();
export const knownFlags = (sha256: string) => flagLists.get(sha256) ?? null;
export const rememberFlags = (sha256: string, flags: ReadonlySet<string>) =>
  void flagLists.set(sha256, flags);
export const forgetFlags = () => flagLists.clear();

/** The result subtypes the client documents. Anything else is a release CrewKite has not read. */
export const RESULT_SUBTYPES: ReadonlySet<string> = new Set([
  'success',
  'error_max_turns',
  'error_during_execution',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
]);

const text = (limit: number) => z.string().max(limit);
const body = z.object({
  models: z.array(z.unknown()).max(64),
  commands: z
    .array(z.object({ name: text(200), argumentHint: text(200).optional().catch(undefined) }))
    .max(1024)
    .optional()
    .catch(undefined),
  account: z.record(z.string(), z.unknown()).optional().catch(undefined),
  capabilities: z.array(text(80)).max(64).optional().catch(undefined),
  claude_code_version: text(200).optional().catch(undefined),
});
const reply = z.object({
  type: z.literal('control_response'),
  response: z.object({
    subtype: z.literal('success'),
    request_id: z.string(),
    response: body,
  }),
});

export type InitializeReply = {
  requestId: string;
  models: unknown[];
  commands: Array<{ name: string; argumentHint?: string }>;
  account: Record<string, unknown> | null;
  capabilities: string[];
  version: string | null;
};

/**
 * The initialize reply, whole: the model rows, the command names, the account the client reports
 * and the capability list. Null when the frame is not an initialize reply. Only the model list
 * has to be there; every other part falls back to empty on its own.
 */
export function parseInitializeReply(value: unknown): InitializeReply | null {
  const parsed = reply.safeParse(value);
  if (!parsed.success) return null;
  const { request_id: requestId, response } = parsed.data.response;
  return {
    requestId,
    models: response.models,
    commands: response.commands ?? [],
    account: response.account ?? null,
    capabilities: response.capabilities ?? [],
    version: response.claude_code_version ?? null,
  };
}

/** The ids of the live model rows, for a default that follows the account's own list. */
export function liveModelIds(models: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const row of models) {
    const value = (row ?? {}) as { resolvedModel?: unknown; value?: unknown };
    const id = typeof value.resolvedModel === 'string' ? value.resolvedModel : value.value;
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}
