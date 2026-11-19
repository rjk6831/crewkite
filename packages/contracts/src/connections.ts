import { z } from 'zod';
import { ChatCrewRoleSchema, ChatFamilySchema, SpendSchema } from './chat.ts';

// Billing connections. A subscription stays the default. An API connection spends only for the
// exact thread or role the person assigned it to, and a subscription limit never moves work onto
// one. The native client keeps the credential, so no record here holds a secret. Keeping a
// connection, assigning it and permission to run are three separate facts.

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`));
const timestamp = z.iso.datetime();

export const ConnectionIdSchema = id('con');
export const ConnectionBackendSchema = z.enum(['native-client', 'local-runtime']);
export const BillingModeSchema = z.enum(['subscription', 'api', 'local']);
export type BillingMode = z.infer<typeof BillingModeSchema>;
export const ConnectionReadinessSchema = z.enum(['ready', 'needs-attention', 'disconnected']);
/** A sign-in command for the person's own terminal. The key goes to the client, never here. */
const LoginLineSchema = z.string().min(1).max(1000);
const ConnectionLabelSchema = z
  .string()
  .min(1)
  .max(60)
  .refine(
    (value) => value.isWellFormed() && !/\p{Cc}/u.test(value),
    'A label is one line of text.',
  );

export const ConnectionSchema = z
  .strictObject({
    connectionId: ConnectionIdSchema,
    family: ChatFamilySchema,
    backend: ConnectionBackendSchema,
    /** The mode the person chose. Admission compares it with `observedMode` before each turn. */
    billingMode: BillingModeSchema,
    /** The owned client profile the connection signs in through. */
    profileId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    /** A name the person gives the connection. It never holds a key or token. */
    label: ConnectionLabelSchema.optional(),
    /** Restore after restart. Off for a new API connection. Restoring never starts work. */
    keepConnected: z.boolean(),
    readiness: ConnectionReadinessSchema,
    /** Moves each time the client proves its mode again, so an old proof never admits a turn. */
    proofGeneration: z.number().int().nonnegative(),
    /** The mode the client last reported. Null until it reports one. */
    observedMode: BillingModeSchema.nullable(),
    observedAt: timestamp.nullable(),
  })
  .refine(
    (connection) => (connection.observedMode === null) === (connection.observedAt === null),
    'An observed mode has a time, and a missing one has none.',
  )
  .refine(
    (connection) =>
      (connection.family === 'local') === (connection.billingMode === 'local') &&
      (connection.family === 'local') === (connection.backend === 'local-runtime'),
    'Local runs on the local runtime with no provider billing, and only Local does.',
  );
export type Connection = z.infer<typeof ConnectionSchema>;

/** What a connection is assigned to: the whole thread or one named role in its crew. */
export const ConnectionRoleSchema = z.enum(['thread', ...ChatCrewRoleSchema.options]);
export type ConnectionRole = z.infer<typeof ConnectionRoleSchema>;

export const ConnectionAssignmentSchema = z.strictObject({
  taskId: id('tsk'),
  role: ConnectionRoleSchema,
  connectionId: ConnectionIdSchema,
});
export type ConnectionAssignment = z.infer<typeof ConnectionAssignmentSchema>;

/** Only the person's choice assigns a connection. No automatic path sends this. */
export const AssignConnectionPayloadSchema = z.strictObject({
  taskId: id('tsk'),
  role: ConnectionRoleSchema,
  connectionId: ConnectionIdSchema,
  consent: z.literal('explicit'),
});
export const UnassignConnectionPayloadSchema = z.strictObject({
  taskId: id('tsk'),
  role: ConnectionRoleSchema,
});
export const SetKeepConnectedPayloadSchema = z.strictObject({
  connectionId: ConnectionIdSchema,
  keepConnected: z.boolean(),
});
/** The most connections one home keeps. */
export const MAX_CONNECTIONS = 64;

/** With a thread, `assignments` lists that thread's. Without one, it is empty. */
export const ReadConnectionsPayloadSchema = z.strictObject({ taskId: id('tsk').optional() });
export const ConnectionsReadSchema = z.strictObject({
  connections: z.array(ConnectionSchema).max(MAX_CONNECTIONS),
  assignments: z.array(ConnectionAssignmentSchema).max(ConnectionRoleSchema.options.length),
  /**
   * What the turns on each API connection cost, summed over every thread. A connection with no
   * turn yet has no row. It is never an allowance and never joins one.
   */
  spend: z
    .array(z.strictObject({ connectionId: ConnectionIdSchema, spend: SpendSchema }))
    .max(MAX_CONNECTIONS)
    .default([]),
  /** The sign-in command for each API connection, so the person can run it again later. */
  loginLines: z
    .array(z.strictObject({ connectionId: ConnectionIdSchema, line: LoginLineSchema }))
    .max(MAX_CONNECTIONS)
    .default([]),
});
export type ConnectionsRead = z.infer<typeof ConnectionsReadSchema>;

/**
 * Adds an API connection for one family. It starts with no observed mode and Keep connected off,
 * so it admits nothing until the person signs in to its own profile and the client proves the mode.
 */
export const AddConnectionPayloadSchema = z.strictObject({
  family: z.enum(['openai', 'anthropic']),
  label: ConnectionLabelSchema.optional(),
});
export const ConnectionAddedSchema = z.strictObject({
  connection: ConnectionSchema,
  loginLine: LoginLineSchema,
});
/**
 * Asks the connection's own client which mode it is signed in with, outside any turn. The answer
 * moves the proof generation. A signed-out client disconnects the connection.
 */
export const ProveConnectionPayloadSchema = z.strictObject({ connectionId: ConnectionIdSchema });

/** Disconnect ends availability. The restoration record stays. */
export const DisconnectConnectionPayloadSchema = z.strictObject({
  connectionId: ConnectionIdSchema,
});
/** Forget removes the restoration record and signs out only the owned profile. */
export const ForgetConnectionPayloadSchema = z.strictObject({ connectionId: ConnectionIdSchema });

/** Settings and rail copy for connections. */
export const CONNECTION_COPY = {
  subscriptionLabel: 'Subscription',
  subscriptionDetail: 'Uses your connected subscription.',
  apiLabel: 'API billing',
  apiDetail:
    'Provider charges apply. CrewKite uses this connection only when you select it for a thread or role.',
  keepConnectedLabel: 'Keep connected on this device',
  keepConnectedDetail: 'Restore this connection after restart. This does not start work.',
  useApiBilling: 'Use API billing',
  spendNotReported: 'Spend not reported',
  signInChanged: 'Sign-in changed. Reconnect this API connection.',
  localRuntime: 'Local runtime. No provider billing.',
  apiUnverified: 'Provider API billing is not verified for this client.',
} as const;
