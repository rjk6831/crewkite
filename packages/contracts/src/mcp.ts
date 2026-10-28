import { z } from 'zod';

// The person's own MCP servers. The desktop keeps the definitions and encrypts their secrets, then
// hands the resolved set to the controller in memory. The controller alone decides, per turn,
// which servers join a thread and what each call may do. The renderer sees only the view types.

/** The thread tools server owns this name. */
export const MCP_RESERVED_NAME = 'crewkite';
const taskId = z.string().regex(/^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

// No underscores, so a client's `mcp__<server>__<tool>` name splits in exactly one way.
export const McpServerNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,30}$/)
  .refine((name) => name !== MCP_RESERVED_NAME, 'That name belongs to the thread tools.');
/** Ask each time, allow the tools the person listed as reads, or allow every tool. */
export const McpPolicySchema = z.enum(['ask', 'reads', 'all']);
/** A tool name, or a name prefix ending in a star. */
export const McpToolPatternSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,64}\*?$/);
const argument = z
  .string()
  .max(4096)
  .refine((value) => value.isWellFormed() && !value.includes('\0'));
const variable = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);

/** What a user types in. The secret fields are write only. */
export const McpServerInputSchema = z.strictObject({
  name: McpServerNameSchema,
  command: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => value.isWellFormed() && !value.includes('\0')),
  args: z.array(argument).max(64),
  /** Arguments appended after args and stored encrypted. */
  secretArgs: z.array(argument).max(16),
  /** Environment variables. Every value is stored encrypted. */
  env: z.record(variable, argument).refine((value) => Object.keys(value).length <= 32),
  /** Tools the person declares as reads. Under the reads policy only these run without asking. */
  readTools: z.array(McpToolPatternSchema).max(64),
  /** Keep the stored secret arguments and environment and ignore the two fields above. */
  keepSecrets: z.boolean().optional(),
});
export type McpServerInput = z.infer<typeof McpServerInputSchema>;

/** One server as the controller receives it. Secrets are in place. */
export const McpServerSchema = McpServerInputSchema.omit({ keepSecrets: true });
export type McpServer = z.infer<typeof McpServerSchema>;
export const McpThreadPoliciesSchema = z.record(
  taskId,
  z.record(McpServerNameSchema, McpPolicySchema),
);
/** A server missing from a thread's record is off for that thread. */
export const McpSupplySchema = z.strictObject({
  servers: z.array(McpServerSchema).max(32),
  threads: McpThreadPoliciesSchema,
});
export type McpSupply = z.infer<typeof McpSupplySchema>;

/** What the renderer may see of a server: the plain arguments, no secret argument, no variable value. */
export const McpServerViewSchema = z.strictObject({
  name: McpServerNameSchema,
  command: z.string(),
  args: z.array(z.string()),
  secretArgCount: z.number().int().nonnegative(),
  envKeys: z.array(z.string()),
  readTools: z.array(McpToolPatternSchema),
});
export type McpServerView = z.infer<typeof McpServerViewSchema>;
export const McpStateSchema = z.strictObject({
  /** False when this device has no keychain that encrypts. Servers with secrets are refused. */
  encrypted: z.boolean(),
  reason: z.string().optional(),
  servers: z.array(McpServerViewSchema),
  threads: McpThreadPoliciesSchema,
});
export type McpState = z.infer<typeof McpStateSchema>;

/** The renderer's calls. Main holds the secrets and never returns them. */
export type McpBridge = {
  state(): Promise<McpState>;
  save(server: McpServerInput): Promise<McpState>;
  remove(name: string): Promise<McpState>;
  /** A null policy turns the server off for the thread. */
  setThread(
    taskId: string,
    name: string,
    policy: z.infer<typeof McpPolicySchema> | null,
  ): Promise<McpState>;
};

const MIN_SECRET = 4;
/** The values of a server's secret arguments and variables that are long enough to match safely. */
export const mcpSecrets = (server: Pick<McpServer, 'secretArgs' | 'env'>): string[] =>
  [...server.secretArgs, ...Object.values(server.env)].filter(
    (value) => value.length >= MIN_SECRET,
  );

/**
 * Replaces every occurrence of a secret value in every string of a value, keys included. A value
 * shorter than four characters is skipped, since it would match ordinary text.
 */
export function scrubSecrets<T>(value: T, secrets: readonly string[]): T {
  const list = [...new Set(secrets.filter((secret) => secret.length >= MIN_SECRET))].sort(
    (a, b) => b.length - a.length,
  );
  if (!list.length) return value;
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') {
      let next = item;
      for (const secret of list) next = next.split(secret).join('[redacted]');
      return next;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [walk(key), walk(entry)]),
      );
    return item;
  };
  return walk(value) as T;
}
