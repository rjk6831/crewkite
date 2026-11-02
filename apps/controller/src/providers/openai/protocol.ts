import { join } from 'node:path';
import { CREWKITE_VERSION } from '@crewkite/contracts/version';

// What CrewKite says to the OpenAI client and what it expects back, in one place. When a client
// release note names a field, this is the file to read. ADR 0048 explains the read-only design.

/** The permission profile a read-only thread runs under. The client refuses an id with a dot. */
export const READ_PROFILE = 'crewkite-read';

export type CodexFeatures = Readonly<{
  /** A named permission profile in thread/start config narrows what a read-only turn reads. */
  readProfile: boolean;
  /** thread/resume takes excludeTurns without the experimental opt-in. */
  resumeExcludeTurns: boolean;
  /** account/rateLimits/read takes its two params. Older builds take none. */
  rateLimitsParams: boolean;
}>;

// The first release that has each feature, from sign-in-free probes of the published builds. A
// version CrewKite cannot read gets every feature, and the replies decide from there.
const FIRST: Readonly<Record<keyof CodexFeatures, string>> = {
  readProfile: '0.133.0',
  resumeExcludeTurns: '0.151.0',
  rateLimitsParams: '0.154.0',
};

const release = (version: string) => {
  const match = /(\d{1,9})\.(\d{1,9})\.(\d{1,9})/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};
const atLeast = (version: number[], first: string) => {
  const floor = release(first) ?? [0, 0, 0];
  for (let index = 0; index < 3; index++)
    if (version[index] !== floor[index]) return version[index] > floor[index];
  return true;
};

export function features(version: string | null | undefined): CodexFeatures {
  const parsed = version ? release(version) : null;
  const has = (key: keyof CodexFeatures) => !parsed || atLeast(parsed, FIRST[key]);
  return {
    readProfile: has('readProfile'),
    resumeExcludeTurns: has('resumeExcludeTurns'),
    rateLimitsParams: has('rateLimitsParams'),
  };
}

// Launch. The settings go in as -c overrides. Without --strict-config a key the build does not
// know is ignored, so the reply to config/read is what proves a setting took (confirmSettings).
// `--listen stdio://` is the default transport and the one spelling every build since 0.133
// accepts; `--stdio` arrived later.
export type LaunchSettings = Readonly<Record<string, string | boolean>>;

export function launchSettings(
  directory: string,
  options: {
    approvalPolicy: 'never' | 'on-request';
    /** Absent for a read-only chat turn: a sandbox mode would switch the client off profiles. */
    sandboxMode?: 'read-only' | 'workspace-write';
    subagents: boolean;
  },
): LaunchSettings {
  return {
    model_provider: 'openai',
    openai_base_url: '',
    chatgpt_base_url: 'https://chatgpt.com/backend-api/',
    service_tier: 'default',
    approval_policy: options.approvalPolicy,
    approvals_reviewer: 'user',
    ...(options.sandboxMode ? { sandbox_mode: options.sandboxMode } : {}),
    web_search: 'disabled',
    'features.plugins': false,
    'features.remote_plugin': false,
    'features.apps': false,
    'features.hooks': false,
    'features.multi_agent': options.subagents,
    log_dir: join(directory, 'logs'),
  };
}

export function configArguments(settings: LaunchSettings, extra: readonly string[] = []) {
  return [
    ...Object.entries(settings).flatMap(([key, value]) => [
      '-c',
      `${key}=${JSON.stringify(value)}`,
    ]),
    ...extra,
  ];
}

export function launchArguments(settings: LaunchSettings, extra: readonly string[] = []) {
  return [...configArguments(settings, extra), 'app-server', '--listen', 'stdio://'];
}

// The settings that decide what a turn may reach. A value that differs fails the turn. A key the
// reply leaves out is one this build does not know, which the turn reports and survives.
const CONFIRMED = ['approval_policy', 'sandbox_mode', 'web_search', 'features.plugins'] as const;

export function confirmSettings(
  settings: LaunchSettings,
  reply: unknown,
): { missing: string[]; different: Array<{ key: string; value: string }> } {
  const config =
    reply && typeof reply === 'object' && 'config' in reply ? (reply.config as unknown) : null;
  const read = (key: string) => {
    let value: unknown = config;
    // config/read nests the dotted keys, and some builds also keep the flat spelling.
    if (value && typeof value === 'object' && key in value)
      return (value as Record<string, unknown>)[key];
    for (const part of key.split('.'))
      value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : null;
    return value;
  };
  const missing: string[] = [];
  const different: Array<{ key: string; value: string }> = [];
  for (const key of CONFIRMED) {
    if (!(key in settings)) continue;
    const value = read(key);
    if (value === undefined || value === null) missing.push(key);
    else if (value !== settings[key])
      different.push({ key, value: JSON.stringify(value).slice(0, 80) });
  }
  return { missing, different };
}

// Requests. Each builder sends the fields a turn needs and nothing a build may not know.
export const initializeParams = () =>
  ({
    clientInfo: { name: 'crewkite', title: 'CrewKite', version: CREWKITE_VERSION },
    capabilities: { experimentalApi: false, explicitGatewayOauth: true },
  }) as const;
export const accountReadParams = () => ({ refreshToken: false as const });
export const RATE_LIMITS_PARAMS = {
  supportsLunaReserve: false,
  excludeResetCreditDetails: true,
} as const;
export const rateLimitsParams = (codex: CodexFeatures) =>
  codex.rateLimitsParams ? RATE_LIMITS_PARAMS : null;
export const configReadParams = (cwd: string) => ({ includeLayers: false, cwd });
export const modelListParams = (limit: number, includeHidden: boolean, cursor?: string | null) => ({
  limit,
  includeHidden,
  ...(cursor ? { cursor } : {}),
});

/**
 * thread/start config for a read-only turn: the profile's table and the switch that selects it.
 * `:minimal` is what the platform needs to run a command. Every other root reads only.
 */
export function readProfileConfig(roots: readonly string[]) {
  return {
    default_permissions: READ_PROFILE,
    permissions: {
      [READ_PROFILE]: {
        filesystem: Object.fromEntries([
          [':minimal', 'read'],
          ...roots.map((root) => [root, 'read']),
        ]),
      },
    },
  };
}

/** The plain read-only sandbox. It reads the whole disk, so CrewKite guards each command. */
export const READ_ONLY_SANDBOX = { type: 'readOnly', networkAccess: false } as const;
export const writableSandbox = (root: string) => ({
  type: 'workspaceWrite',
  writableRoots: [root],
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
});

export type ThreadSettings = Readonly<{
  model: string;
  cwd: string;
  approvalPolicy: 'never' | 'untrusted' | 'on-request';
  sandbox?: 'read-only' | 'workspace-write';
  developerInstructions?: string;
  config?: Record<string, unknown>;
}>;

function threadSettings(settings: ThreadSettings) {
  return {
    model: settings.model,
    modelProvider: 'openai',
    cwd: settings.cwd,
    approvalPolicy: settings.approvalPolicy,
    approvalsReviewer: 'user',
    ...(settings.sandbox ? { sandbox: settings.sandbox } : {}),
    serviceTier: 'default',
    ...(settings.developerInstructions
      ? { developerInstructions: settings.developerInstructions }
      : {}),
    ...(settings.config ? { config: settings.config } : {}),
  };
}

export const threadStartParams = (settings: ThreadSettings, ephemeral: boolean) => ({
  ...threadSettings(settings),
  ephemeral,
});

export const threadResumeParams = (
  threadId: string,
  settings: ThreadSettings,
  codex: CodexFeatures = features(null),
) => ({
  threadId,
  ...threadSettings(settings),
  ...(codex.resumeExcludeTurns ? { excludeTurns: true } : {}),
});

export const turnStartParams = (turn: {
  threadId: string;
  input: readonly unknown[];
  effort?: string;
  sandboxPolicy?: unknown;
  approvalPolicy?: 'untrusted';
}) => ({
  threadId: turn.threadId,
  input: turn.input,
  ...(turn.effort ? { effort: turn.effort } : {}),
  ...(turn.sandboxPolicy ? { sandboxPolicy: turn.sandboxPolicy } : {}),
  ...(turn.approvalPolicy ? { approvalPolicy: turn.approvalPolicy } : {}),
});

export const turnInterruptParams = (threadId: string, turnId: string) => ({ threadId, turnId });

export type Decision = 'accept' | 'acceptForSession' | 'decline';
export const approvalReply = (decision: Decision) => ({ decision });
/** A grant answers with the access the request named, for this turn. A denial grants none. */
export const permissionsReply = (granted: unknown) => ({
  permissions: granted && typeof granted === 'object' ? granted : {},
  scope: 'turn',
});

// Method sets.
export const APPROVAL_REQUESTS = {
  'item/commandExecution/requestApproval': 'command',
  'item/fileChange/requestApproval': 'edit',
  'item/permissions/requestApproval': 'permissions',
} as const;
export type ApprovalRequest = (typeof APPROVAL_REQUESTS)[keyof typeof APPROVAL_REQUESTS];
export const approvalRequest = (method: string): ApprovalRequest | null =>
  Object.hasOwn(APPROVAL_REQUESTS, method)
    ? APPROVAL_REQUESTS[method as keyof typeof APPROVAL_REQUESTS]
    : null;

// Fields a request can lose and still do its job. A build that refuses one gets the request again
// without it. config, sandbox, sandboxPolicy, approvalPolicy, approvalsReviewer and
// developerInstructions decide what the turn may reach or what it is told, so they never drop.
export const OPTIONAL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'thread/start': ['ephemeral', 'serviceTier'],
  'thread/resume': ['excludeTurns', 'serviceTier'],
  'turn/start': ['effort'],
};

// Error matchers. A refused shape comes back as -32600 when the request fails to deserialize and
// as -32602 when a handler rejects it. Thread-not-found is also -32600, so the message decides.
const REFUSED_SHAPE =
  /no longer supported|unknown (?:variant|field)|cannot be combined|requires experimentalApi|not supported|invalid type/i;

export type ProtocolError = { code?: number | null; message?: string | null } | null | undefined;

export const refusedShape = (error: ProtocolError) =>
  (error?.code === -32600 || error?.code === -32602) && REFUSED_SHAPE.test(error?.message ?? '');

/** The optional field a refusal names, when the request carried it. */
export function refusedField(
  error: ProtocolError,
  method: string,
  params: Readonly<Record<string, unknown>>,
): string | null {
  if (!refusedShape(error)) return null;
  const message = error?.message ?? '';
  const sent = (OPTIONAL_FIELDS[method] ?? []).filter((field) => field in params);
  // serde lists the fields it expected after the one it did not know, so only that one counts.
  const unknown = /unknown field `([^`]+)`/.exec(message)?.[1];
  if (unknown !== undefined) return sent.includes(unknown) ? unknown : null;
  const named = message.split(', expected')[0];
  return (
    sent.find((field) =>
      new RegExp(`(?:^|[^A-Za-z0-9_])${field}(?:[^A-Za-z0-9_]|$)`).test(named),
    ) ?? null
  );
}
