import { z } from 'zod';

const clientSha256 = '5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37';
const maximumStdoutBytes = 131_072;
const name = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.isWellFormed() && !/\p{Cc}/u.test(value));
const timestamp = z.iso.datetime({ offset: true });
// The client adds fields and frames from one weekly build to the next. These schemas hold only
// what the gauge shows, so anything else the client prints is ignored and never fails a read.
const limit = z.object({
  kind: name,
  percent: z.number().finite().nonnegative(),
  resets_at: timestamp.nullish(),
  scope: z.object({ model: z.object({ display_name: name }).nullish() }).nullish(),
});
const report = z.object({
  rate_limits: z
    .object({
      limits: z.array(limit).max(64).nullish(),
      // The switch is a display fact. A change in its shape drops it and keeps the gauge.
      extra_usage: z.object({ is_enabled: z.boolean() }).nullish().catch(null),
    })
    .nullish(),
});
const frame = z.object({ type: z.string() });

export class UsageReaderError extends Error {
  readonly reason:
    | 'client'
    | 'output-limit'
    | 'native-trust-required'
    | 'not-json'
    | 'no-usage-report'
    | 'unreadable-report'
    | 'no-result'
    | 'client-error';
  constructor(reason: UsageReaderError['reason']) {
    super(`Subscription usage reader refused: ${reason}.`);
    this.name = 'UsageReaderError';
    this.reason = reason;
  }
}

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

// The client reports used percent and the gauge shows what is left. A limit past its cap has
// nothing left. The window IDs match the five-hour and weekly windows of the other families.
function usageWindow(value: z.output<typeof limit>) {
  const model = value.scope?.model?.display_name;
  return {
    windowId:
      value.kind === 'session'
        ? 'five-hour'
        : value.kind === 'weekly_all'
          ? 'weekly'
          : value.kind === 'weekly_scoped' && model
            ? `weekly-${model.toLowerCase().replace(/\s+/g, '-')}`
            : value.kind,
    remaining: { value: Math.max(0, 100 - value.percent), unit: 'percent' as const },
    resetsAt: value.resets_at ? new Date(value.resets_at).toISOString() : null,
  };
}

export class AnthropicUsageReader {
  private pending = Buffer.alloc(0);
  private bytes = 0;
  private failure: UsageReaderError['reason'] | undefined;
  private reading:
    | {
        windows: ReturnType<typeof usageWindow>[] | null;
        extraUsage: { is_enabled: boolean } | null;
      }
    | undefined;
  private ended = false;
  private model: string | null = null;

  feed(chunk: Uint8Array) {
    if (this.failure) throw new UsageReaderError(this.failure);
    try {
      this.bytes += chunk.byteLength;
      if (this.bytes > maximumStdoutBytes) throw new UsageReaderError('output-limit');
      this.pending = Buffer.concat([this.pending, chunk]);
      for (let end = this.pending.indexOf(10); end >= 0; end = this.pending.indexOf(10)) {
        const line = this.pending.subarray(0, end);
        this.pending = this.pending.subarray(end + 1);
        this.line(line);
      }
    } catch (error) {
      this.failure = error instanceof UsageReaderError ? error.reason : 'not-json';
      throw new UsageReaderError(this.failure);
    }
  }

  private line(bytes: Uint8Array) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.trim()) return;
    const value: unknown = JSON.parse(text);
    const head = frame.safeParse(value);
    if (!head.success) return;
    const fields = value as Record<string, unknown>;
    if (head.data.type === 'system' && fields.subtype === 'init') {
      // The chat composer starts on this model. A value it cannot read leaves the default.
      const model = name.safeParse(fields.model);
      this.model = model.success ? model.data : null;
    } else if (head.data.type === 'assistant' && fields.usage_report != null) {
      try {
        const parsed = report.parse(fields.usage_report).rate_limits;
        this.reading = {
          windows: parsed?.limits?.map(usageWindow) ?? null,
          extraUsage: parsed?.extra_usage ?? null,
        };
      } catch {
        throw new UsageReaderError('unreadable-report');
      }
    } else if (head.data.type === 'result') {
      if (fields.is_error === true) throw new UsageReaderError('client-error');
      this.ended = true;
    }
  }

  finish(receivedAt: string) {
    // A last line without its newline still counts.
    if (this.pending.length) this.feed(Uint8Array.of(10));
    if (this.failure) throw new UsageReaderError(this.failure);
    if (!this.reading) throw new UsageReaderError('no-usage-report');
    if (!this.ended) throw new UsageReaderError('no-result');
    timestamp.parse(receivedAt);
    return {
      status: this.reading.windows ? ('reported' as const) : ('unavailable' as const),
      source: 'native-local-command' as const,
      receivedAt,
      // The structured twin has no fetch timestamp. Text and receipt time cannot supply one.
      observedAt: null,
      freshness: 'unknown' as const,
      windows: this.reading.windows ?? [],
      extraUsage: this.reading.extraUsage,
      model: this.model,
      // The plan runs a local command with no tools and no prompt, so no model turn is asked for.
      modelTurns: 0 as const,
      qualified: false as const,
    };
  }
}
