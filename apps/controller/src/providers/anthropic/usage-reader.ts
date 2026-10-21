import { z } from 'zod';

const clientSha256 = '5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37';
const maximumStdoutBytes = 131_072;
const label = z
  .string()
  .max(128)
  .refine((value) => value.isWellFormed() && !/\p{Cc}/u.test(value));
const timestamp = z.iso.datetime({ offset: true });
const zero = z.literal(0);
const session = z.strictObject({
  total_cost_usd: zero,
  total_api_duration_ms: zero,
  total_duration_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  total_lines_added: zero,
  total_lines_removed: zero,
  model_usage: z.record(z.string(), z.never()),
});
const scope = z
  .strictObject({
    model: z.strictObject({ display_name: label }).nullable().optional(),
    surface: z.strictObject({ display_name: label }).nullable().optional(),
  })
  .nullable()
  .optional();
const row = z.strictObject({
  kind: label,
  group: label,
  percent: z.number().finite().min(0).max(100),
  resets_at: timestamp.nullable(),
  scope,
  severity: label,
  is_active: z.boolean(),
});
const extra = z.strictObject({
  is_enabled: z.boolean(),
  monthly_limit: z.number().finite().nonnegative().nullable(),
  used_credits: z.number().finite().nonnegative().nullable(),
  utilization: z.number().finite().nonnegative().nullable(),
  currency: label.nullable().optional(),
});
const report = z.strictObject({
  session,
  rate_limits: z
    .strictObject({
      limits: z.array(row).max(64).nullable(),
      extra_usage: extra.nullable().optional(),
    })
    .nullable(),
});
const zeroUsage = z.strictObject({
  input_tokens: zero,
  output_tokens: zero,
  cache_creation_input_tokens: zero.nullable().optional(),
  cache_read_input_tokens: zero.nullable().optional(),
  cache_creation: z
    .strictObject({ ephemeral_1h_input_tokens: zero, ephemeral_5m_input_tokens: zero })
    .nullable()
    .optional(),
  server_tool_use: z
    .strictObject({ web_search_requests: zero, web_fetch_requests: zero })
    .nullable()
    .optional(),
  service_tier: label.nullable().optional(),
  inference_geo: label.nullable().optional(),
  speed: label.nullable().optional(),
  iterations: z.array(z.never()).nullable().optional(),
  output_tokens_details: z.strictObject({ thinking_tokens: zero.optional() }).nullable().optional(),
  fallback_credit: z.null().optional(),
});
const identity = { session_id: z.uuid(), uuid: z.uuid() };
const init = z.object({
  ...identity,
  type: z.literal('system'),
  subtype: z.literal('init'),
  tools: z.array(z.never()),
  mcp_servers: z.array(z.never()),
  plugins: z.array(z.never()).optional(),
});
const localOutput = z.strictObject({
  ...identity,
  type: z.literal('system'),
  subtype: z.literal('local_command_output'),
  content: z.string().max(maximumStdoutBytes),
});
const localReport = z.object({
  ...identity,
  type: z.literal('assistant'),
  parent_tool_use_id: z.null(),
  local_command_run: z.strictObject({ command: z.literal('usage'), args: z.literal('') }),
  local_command_outcome: z.never().optional(),
  usage_report: report,
  batch_tool_uses: z.array(z.never()).optional(),
  is_api_error_message: z.literal(false).optional(),
  api_error: z.never().optional(),
  api_error_params: z.never().optional(),
  message: z.object({
    role: z.literal('assistant'),
    content: z
      .array(z.strictObject({ type: z.literal('text'), text: z.string().max(maximumStdoutBytes) }))
      .max(4),
    stop_reason: z.literal('end_turn'),
    usage: zeroUsage.optional(),
  }),
});
const noSubagents = z.strictObject({
  spawned: zero,
  requested: z.strictObject({ background: zero, foreground: zero, unset: zero }),
  started_in_background: zero,
  by_type: z.record(z.string(), zero),
  max_depth: zero,
  spawned_by_subagents: zero,
  completed: zero,
  failed: zero,
  killed: z.strictObject({ parent: zero, user: zero, system: zero }),
  refused: z.strictObject({ depth_limit: zero, concurrency_limit: zero, budget: zero }),
});
const terminal = z.object({
  ...identity,
  type: z.literal('result'),
  subtype: z.literal('success'),
  is_error: z.literal(false),
  num_turns: zero,
  duration_api_ms: zero,
  total_cost_usd: zero,
  modelUsage: z.record(z.string(), z.never()),
  usage: zeroUsage,
  permission_denials: z.array(z.never()),
  deferred_tool_use: z.never().optional(),
  subagent_stats: noSubagents.optional(),
  queued_turn_count: zero.optional(),
  safety_stops: zero.optional(),
  terminal_reason: z.never().optional(),
  interrupted_by_shutdown: z.never().optional(),
});

export class UsageReaderError extends Error {
  readonly reason:
    | 'client'
    | 'protocol'
    | 'output-limit'
    | 'incomplete'
    | 'managed-hooks-unverified';
  constructor(reason: UsageReaderError['reason']) {
    super(`Subscription usage reader refused: ${reason}.`);
    this.name = 'UsageReaderError';
    this.reason = reason;
  }
}

export const anthropicUsageReaderAvailability = Object.freeze({
  available: false as const,
  reason: 'managed-hooks-unverified' as const,
});

/** This exact build has a local non-interactive /usage command and skips the startup model probe. */
export function anthropicUsageReaderPlan(input: { clientSha256: string; sessionId: string }) {
  if (input.clientSha256 !== clientSha256 || !z.uuid().safeParse(input.sessionId).success)
    throw new UsageReaderError('client');
  return {
    sessionId: input.sessionId,
    clientSha256,
    timeoutMs: 30_000,
    maximumStdoutBytes,
    maximumStderrBytes: 16_384,
    argv: [
      '--print',
      '--safe-mode',
      '--restricted',
      '--setting-sources',
      '',
      '--settings',
      '{"disableAllHooks":true}',
      '--tools',
      '',
      '--disallowedTools',
      'mcp__*',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--permission-mode',
      'default',
      '--permission-prompts',
      'none',
      '--no-chrome',
      '--no-session-persistence',
      '--session-id',
      input.sessionId,
      '--input-format',
      'text',
      '--output-format',
      'stream-json',
      '--verbose',
      '/usage',
    ],
  };
}
export type AnthropicUsageReaderPlan = ReturnType<typeof anthropicUsageReaderPlan>;
export type AnthropicUsageReport = z.output<typeof report>;

export class AnthropicUsageReader {
  private pending = Buffer.alloc(0);
  private bytes = 0;
  private initialized = false;
  private complete = false;
  private value: AnthropicUsageReport | undefined;
  private failed = false;

  private readonly sessionId: string;
  constructor(sessionId: string) {
    this.sessionId = z.uuid().parse(sessionId);
  }

  feed(chunk: Uint8Array) {
    try {
      if (this.failed || !(chunk instanceof Uint8Array)) throw new UsageReaderError('protocol');
      this.bytes += chunk.byteLength;
      if (this.bytes > maximumStdoutBytes) throw new UsageReaderError('output-limit');
      this.pending = Buffer.concat([this.pending, chunk]);
      for (;;) {
        const end = this.pending.indexOf(10);
        if (end < 0) break;
        const line = this.pending.subarray(0, end);
        this.pending = this.pending.subarray(end + 1);
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
        const frame = z
          .object({ session_id: z.literal(this.sessionId), type: z.string() })
          .parse(value);
        if (this.complete) throw new UsageReaderError('protocol');
        if (!this.initialized) {
          init.parse(value);
          this.initialized = true;
        } else if (frame.type === 'assistant') {
          if (this.value) throw new UsageReaderError('protocol');
          this.value = localReport.parse(value).usage_report;
        } else if (frame.type === 'system') {
          localOutput.parse(value);
        } else {
          terminal.parse(value);
          this.complete = true;
        }
      }
    } catch (error) {
      this.failed = true;
      if (error instanceof UsageReaderError) throw error;
      throw new UsageReaderError('protocol');
    }
  }

  finish(receivedAt: string) {
    if (this.failed || this.pending.length || !this.initialized || !this.complete || !this.value)
      throw new UsageReaderError('incomplete');
    timestamp.parse(receivedAt);
    const limits = this.value.rate_limits;
    return {
      status: limits?.limits == null ? ('unavailable' as const) : ('reported' as const),
      source: 'native-local-command' as const,
      receivedAt,
      // The structured twin has no fetch timestamp. Text and receipt time cannot supply one.
      observedAt: null,
      freshness: 'unknown' as const,
      windows: limits?.limits ?? [],
      extraUsage: limits?.extra_usage ?? null,
      modelTurns: 0 as const,
      qualified: false as const,
    };
  }
}
