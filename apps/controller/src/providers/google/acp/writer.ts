import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import {
  AcpActivitySchema,
  type ApprovalBinding,
  ApprovalBindingSchema,
  AttemptIdSchema,
  canonicalJson,
  GoogleAcpConfigurationSchema,
  GoogleAcpSelectionSchema,
  HashSchema,
  NativeTargetPathSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { z } from 'zod';
import {
  type AcpConnection,
  AcpError,
  type AcpProcessOptions,
  acpIdentifier,
  startAcpProcess,
} from './client.ts';
import {
  type AcpClientIdentity,
  AcpClientPinSchema,
  AcpImportIdentitySchema,
  type AcpReviewMapping,
  type AcpSetupProof,
  AcpSetupProofSchema,
  acpClientPin,
  acpReviewMappingMatchesClient,
  GoogleAcpReviewMappings,
  validateAcpSetupProof,
} from './profile.ts';

const text = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((v) => v.isWellFormed() && !v.includes('\0'));
const valueSchema = z.object({ value: acpIdentifier, name: text(200) });
const configSchema = z.object({
  id: acpIdentifier,
  type: z.string(),
  name: text(200),
  category: z.string().optional(),
  currentValue: z.unknown(),
  options: z.unknown().optional(),
});
type Configuration = z.infer<typeof GoogleAcpConfigurationSchema>;
type DecodedConfig = {
  configOptions: Configuration | null;
  modeValues: AcpSetupProof['modeValues'];
  selectedModes: Map<string, string>;
};
export const AcpToolMappingSchema = z.discriminatedUnion('schema', [
  z.strictObject({
    client: AcpClientPinSchema,
    toolName: acpIdentifier,
    schema: z.literal('replace-target-v1'),
    evidenceHash: HashSchema,
  }),
  z.strictObject({
    client: AcpImportIdentitySchema,
    toolTitle: z.literal('Run replace_file_content?'),
    schema: z.literal('replace-hunk-v1'),
    evidenceHash: HashSchema,
  }),
]);
export type AcpToolMapping = z.infer<typeof AcpToolMappingSchema>;
export const GoogleAcpToolMappings: readonly AcpToolMapping[] = Object.freeze([]);
export type AcpDependencies = {
  reviewMappings?: readonly AcpReviewMapping[];
  toolMappings?: readonly AcpToolMapping[];
};

export function decodeAcpConfiguration(raw: unknown): DecodedConfig {
  const options = z.array(configSchema).max(32).parse(raw);
  if (new Set(options.map((v) => v.id)).size !== options.length)
    throw new AcpError('configuration');
  const selections: { id: string; category?: string; currentValue: string; supported: string[] }[] =
    [];
  for (const option of options) {
    if (option.type !== 'select') continue;
    const flat = z.array(valueSchema).min(1).max(32).safeParse(option.options);
    const groups = z
      .array(
        z.object({
          group: acpIdentifier,
          name: text(200),
          options: z.array(valueSchema).min(1).max(32),
        }),
      )
      .min(1)
      .max(32)
      .safeParse(option.options);
    const values = flat.success
      ? flat.data
      : groups.success
        ? groups.data.flatMap((g) => g.options)
        : null;
    if (
      !values ||
      values.length > 32 ||
      new Set(values.map((v) => v.value)).size !== values.length ||
      (groups.success && new Set(groups.data.map((g) => g.group)).size !== groups.data.length) ||
      typeof option.currentValue !== 'string' ||
      !values.some((v) => v.value === option.currentValue)
    )
      throw new AcpError('configuration');
    selections.push({
      id: option.id,
      category: option.category,
      currentValue: option.currentValue,
      supported: values.map((v) => v.value),
    });
  }
  const models = selections.filter((v) => v.category === 'model');
  const thoughts = selections.filter((v) => v.category === 'thought_level');
  const modes = selections.filter((v) => v.category === 'mode');
  const normalized = (v: (typeof selections)[number]) => ({
    optionId: v.id,
    currentValue: v.currentValue,
    supported: v.supported,
  });
  return {
    configOptions:
      models.length === 1 && thoughts.length <= 1
        ? GoogleAcpConfigurationSchema.parse({
            model: normalized(models[0]),
            thoughtLevel: thoughts[0] ? normalized(thoughts[0]) : null,
          })
        : null,
    modeValues: modes.flatMap((v) => v.supported.map((valueId) => ({ optionId: v.id, valueId }))),
    selectedModes: new Map(modes.map((v) => [v.id, v.currentValue])),
  };
}

const initialized = z.object({
  protocolVersion: z.literal(1),
  agentInfo: z.object({ version: z.literal('1.4.0') }),
  agentCapabilities: z
    .object({
      sessionCapabilities: z
        .object({ close: z.record(z.string(), z.unknown()).nullable().optional() })
        .optional(),
    })
    .default({}),
  authMethods: z
    .array(z.object({ id: acpIdentifier, name: text(200), type: z.string().optional() }))
    .max(16)
    .default([]),
});
async function initialize(
  connection: AcpConnection,
  client: AcpClientIdentity,
): Promise<AcpSetupProof> {
  const result = initialized.parse(
    await connection.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'crewkite', version: '0.1.0' },
    }),
  );
  const personal = result.authMethods.filter(
    (v) => v.id === 'oauth-personal' && (v.type === undefined || v.type === 'agent'),
  );
  return AcpSetupProofSchema.parse({
    version: 1,
    profileId: 'google-acp-v1',
    client: acpClientPin(client),
    capabilities: {
      protocolVersion: 1,
      authMethods: personal.length === 1 ? ['oauth-personal'] : [],
      sessionClose: !!result.agentCapabilities.sessionCapabilities?.close,
      fs: false,
      terminal: false,
    },
    auth: { method: null, status: 'unknown' },
    configOptions: null,
    reviewMode: null,
    modeValues: [],
  });
}
const sessionSchema = z.object({ sessionId: acpIdentifier, configOptions: z.unknown().optional() });
function bufferSessionUpdates(connection: AcpConnection) {
  const buffered: { method: string; params: Record<string, unknown> }[] = [];
  connection.onNotification = (method, params) => {
    if (method !== 'session/update' || buffered.length >= 32) throw new AcpError('protocol');
    buffered.push({ method, params });
  };
  return () => {
    for (const update of buffered) connection.onNotification(update.method, update.params);
  };
}
async function closeSession(connection: AcpConnection, proof: AcpSetupProof, sessionId: string) {
  if (proof.capabilities.sessionClose)
    z.object({}).parse(await connection.request('session/close', { sessionId }));
}
export type AcpSetupOptions = Omit<AcpProcessOptions, 'timeoutMs'> & {
  operation: 'initialize' | 'authenticate' | 'discover';
  priorProof: AcpSetupProof | null;
} & AcpDependencies;
export function startGoogleAcpSetup(options: AcpSetupOptions) {
  const mappings = options.reviewMappings ?? GoogleAcpReviewMappings;
  if (options.operation !== 'initialize') {
    if (!options.priorProof) throw new AcpError('identity');
    validateAcpSetupProof(options.priorProof, options.client, mappings);
  }
  return startAcpProcess(
    {
      ...options,
      timeoutMs: { initialize: 5000, authenticate: 120000, discover: 20000 }[options.operation],
    },
    async (connection) => {
      const proof = await initialize(connection, options.client);
      connection.onRequest = (id) => {
        connection.respond(id, { outcome: { outcome: 'cancelled' } });
        throw new AcpError('permission');
      };
      if (options.operation === 'initialize') return proof;
      if (!proof.capabilities.authMethods.includes('oauth-personal'))
        throw new AcpError('authentication');
      if (options.operation === 'authenticate') {
        z.object({}).parse(
          await connection.request('authenticate', { methodId: 'oauth-personal' }),
        );
        return AcpSetupProofSchema.parse({
          ...proof,
          auth: { method: 'oauth-personal', status: 'authenticated' },
        });
      }
      if (options.priorProof?.auth.status !== 'authenticated') throw new AcpError('authentication');
      const replay = bufferSessionUpdates(connection);
      const session = sessionSchema.parse(
        await connection.request('session/new', { cwd: options.directory, mcpServers: [] }),
      );
      let observed = decodeAcpConfiguration(session.configOptions ?? []);
      connection.onNotification = (method, params) => {
        if (method !== 'session/update' || params.sessionId !== session.sessionId)
          throw new AcpError('protocol');
        const update = z
          .object({ sessionUpdate: z.string(), configOptions: z.unknown().optional() })
          .parse(params.update);
        if (update.sessionUpdate === 'config_option_update')
          observed = decodeAcpConfiguration(update.configOptions);
      };
      replay();
      const matches = mappings.filter(
        (v) =>
          acpReviewMappingMatchesClient(v, options.client) &&
          observed.modeValues.some((m) => m.optionId === v.configId && m.valueId === v.valueId),
      );
      const mode = matches.length === 1 ? matches[0] : null;
      const discovered = AcpSetupProofSchema.parse({
        ...proof,
        auth: options.priorProof.auth,
        configOptions: observed.configOptions,
        modeValues: observed.modeValues,
        reviewMode: mode
          ? {
              surface: 'config',
              configId: mode.configId,
              valueId: mode.valueId,
              semantics: 'request-review',
              mappingEvidenceHash: mode.evidenceHash,
              discoveryStateHash: hashCanonical({
                configOptions: observed.configOptions,
                modeValues: observed.modeValues,
              }),
            }
          : null,
      });
      await closeSession(connection, proof, session.sessionId);
      return validateAcpSetupProof(discovered, options.client, mappings);
    },
  );
}

const targetSchema = z.strictObject({
  path: NativeTargetPathSchema,
  baseHash: HashSchema,
  mode: z.enum(['100644', '100755']),
});
const planSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  generation: z.number().int().nonnegative(),
  target: targetSchema,
  selection: GoogleAcpSelectionSchema,
  proof: AcpSetupProofSchema,
  prompt: text(65536),
});
export type AcpWriterPlan = z.infer<typeof planSchema>;
export function googleAcpWriterPlan(
  options: {
    attemptId: string;
    generation: number;
    target: z.infer<typeof targetSchema>;
    criteria: string[];
    selection: z.infer<typeof GoogleAcpSelectionSchema>;
    proof: AcpSetupProof;
    client?: AcpClientIdentity;
  } & AcpDependencies,
): AcpWriterPlan {
  const proof = validateAcpSetupProof(
    options.proof,
    options.client ?? options.proof.client,
    options.reviewMappings,
  );
  const config = proof.configOptions;
  if (
    !config ||
    !proof.reviewMode ||
    proof.auth.status !== 'authenticated' ||
    !config.model.supported.includes(options.selection.modelId) ||
    (config.thoughtLevel
      ? !config.thoughtLevel.supported.includes(options.selection.thoughtLevelId ?? '')
      : options.selection.thoughtLevelId !== null)
  )
    throw new AcpError('configuration');
  const criteria = z.array(text(4096).min(1)).min(1).max(32).parse(options.criteria);
  return planSchema.parse({
    attemptId: options.attemptId,
    generation: options.generation,
    target: options.target,
    selection: options.selection,
    proof,
    prompt: `Edit only the existing scratch file ${options.target.path}. Preserve its mode and every other path. Do not run checks or change session settings. Request human permission for edits.\nTask criteria: ${canonicalJson(criteria)}`,
  });
}
const actionFields = {
  path: NativeTargetPathSchema,
  oldText: text(65536),
  newText: text(65536),
  baseHash: HashSchema,
  mode: z.enum(['100644', '100755']),
};
export const AcpPermissionActionSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      ...actionFields,
      type: z.literal('replace-target'),
    }),
    z.strictObject({
      ...actionFields,
      type: z.literal('replace-hunk'),
      oldText: actionFields.oldText.min(1),
      afterHash: HashSchema,
    }),
  ])
  .refine(
    (v) =>
      Buffer.byteLength(v.oldText) <= 65536 &&
      Buffer.byteLength(v.newText) <= 65536 &&
      Buffer.byteLength(canonicalJson(v)) <= 4096 &&
      (v.type === 'replace-hunk' ||
        createHash('sha256').update(v.oldText).digest('hex') === v.baseHash),
  );
export type AcpPermissionAction = z.infer<typeof AcpPermissionActionSchema>;
const targetSnapshot = z.strictObject({
  path: NativeTargetPathSchema,
  hash: HashSchema,
  mode: actionFields.mode,
  content: text(65536),
});
export type AcpTargetSnapshot = z.infer<typeof targetSnapshot>;
export function acpPermissionAfterHash(
  action: AcpPermissionAction,
  value: AcpTargetSnapshot,
): string {
  const detail = AcpPermissionActionSchema.parse(action);
  const target = targetSnapshot.parse(value);
  if (
    target.path !== detail.path ||
    target.mode !== detail.mode ||
    target.hash !== detail.baseHash ||
    Buffer.byteLength(target.content) > 65536 ||
    createHash('sha256').update(target.content).digest('hex') !== target.hash
  )
    throw new AcpError('permission');
  let content = detail.newText;
  if (detail.type === 'replace-hunk') {
    const offset = target.content.indexOf(detail.oldText);
    if (offset < 0 || target.content.lastIndexOf(detail.oldText) !== offset)
      throw new AcpError('permission');
    content =
      target.content.slice(0, offset) +
      detail.newText +
      target.content.slice(offset + detail.oldText.length);
  } else if (target.content !== detail.oldText) throw new AcpError('permission');
  const hash = createHash('sha256').update(content).digest('hex');
  if (
    Buffer.byteLength(content) > 65536 ||
    (detail.type === 'replace-hunk' && detail.afterHash !== hash)
  )
    throw new AcpError('permission');
  return hash;
}
export type AcpPermissionProposal = {
  acpTarget: NonNullable<ApprovalBinding['acpTarget']>;
  action: 'write-scratch';
  target: string;
  consequence: string;
  detail: AcpPermissionAction;
  actionHash: string;
  proposalHash: string;
};
export type AcpMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
};
export type AcpWriterOptions = Omit<AcpProcessOptions, 'timeoutMs'> &
  AcpDependencies & {
    scratch: string;
    timeoutMs?: number;
    plan: AcpWriterPlan;
    mcpServer: AcpMcpServer;
    onSubmitted(): void;
    onPermission(proposal: AcpPermissionProposal): ApprovalBinding;
    readTarget?(): AcpTargetSnapshot;
    onActivity(activity: z.infer<typeof AcpActivitySchema>, text: string): void;
  };
export type AcpWriterCompletion = {
  sessionId: string;
  stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
  submitted: true;
  selectionHash: string;
  reviewModeHash: string;
  targetHash?: string;
};
const toolUpdate = z.strictObject({
  sessionUpdate: z.enum(['tool_call', 'tool_call_update']).optional(),
  toolCallId: acpIdentifier,
  name: acpIdentifier.nullable().optional(),
  title: text(4096).nullable().optional(),
  kind: z.string().nullable().optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']).nullable().optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  _meta: z.unknown().optional(),
  content: z.array(z.unknown()).max(32).nullable().optional(),
  locations: z
    .array(
      z.strictObject({ path: text(4096), line: z.number().int().positive().nullable().optional() }),
    )
    .max(32)
    .nullable()
    .optional(),
});
type Tool = z.infer<typeof toolUpdate>;
const permission = z.strictObject({
  sessionId: acpIdentifier,
  toolCall: toolUpdate,
  options: z
    .array(
      z.strictObject({
        optionId: acpIdentifier,
        name: text(200),
        kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
      }),
    )
    .min(1)
    .max(16),
});
function scratchPath(root: string, path: string) {
  if (!isAbsolute(path)) throw new AcpError('permission');
  const result = relative(root, path);
  return NativeTargetPathSchema.parse(result);
}
function mergeTool(previous: Tool | undefined, patch: Tool): Tool {
  const next = { ...previous, toolCallId: patch.toolCallId } as Tool;
  for (const [key, value] of Object.entries(patch))
    if (key !== 'sessionUpdate' && value !== null && value !== undefined)
      Object.assign(next, { [key]: value });
  return next;
}

export function decodeAcpPermissionAction(options: {
  tool: unknown;
  client: AcpClientIdentity;
  scratch: string;
  target: AcpWriterPlan['target'];
  toolMappings: readonly AcpToolMapping[];
  readTarget?: () => AcpTargetSnapshot;
}): AcpPermissionAction {
  const tool = toolUpdate.parse(options.tool);
  const mappings = options.toolMappings
    .map((entry) => AcpToolMappingSchema.parse(entry))
    .filter(
      (entry) =>
        hashCanonical(acpClientPin(entry.client)) === hashCanonical(acpClientPin(options.client)) &&
        (entry.schema === 'replace-target-v1'
          ? entry.toolName === tool.name
          : entry.client.harnessSha256 === options.client.harnessSha256 &&
            entry.toolTitle === tool.title &&
            tool.name == null),
    );
  if (
    mappings.length !== 1 ||
    tool.kind !== 'edit' ||
    tool.status !== 'pending' ||
    tool.rawOutput != null ||
    tool._meta != null
  )
    throw new AcpError('permission');
  const mapping = mappings[0];
  const input =
    mapping.schema === 'replace-target-v1'
      ? z
          .strictObject({ path: text(4096), oldText: text(65536), newText: text(65536) })
          .parse(tool.rawInput)
      : (() => {
          const raw = z
            .strictObject({
              TargetFile: text(4096),
              TargetContent: text(65536).min(1),
              ReplacementContent: text(65536),
            })
            .parse(tool.rawInput);
          return {
            path: raw.TargetFile,
            oldText: raw.TargetContent,
            newText: raw.ReplacementContent,
          };
        })();
  const path = scratchPath(options.scratch, input.path);
  if (path !== options.target.path) throw new AcpError('permission');
  for (const location of tool.locations ?? [])
    if (
      scratchPath(options.scratch, location.path) !== path ||
      (mapping.schema === 'replace-hunk-v1' && location.line != null)
    )
      throw new AcpError('permission');
  for (const content of tool.content ?? []) {
    const diff = z
      .strictObject({
        type: z.literal('diff'),
        path: text(4096),
        oldText: text(65536),
        newText: text(65536),
        _meta: z.strictObject({ kind: z.literal('modify') }).optional(),
      })
      .parse(content);
    if (
      scratchPath(options.scratch, diff.path) !== path ||
      diff.oldText !== input.oldText ||
      diff.newText !== input.newText
    )
      throw new AcpError('permission');
  }
  if (mapping.schema === 'replace-target-v1')
    return AcpPermissionActionSchema.parse({
      type: 'replace-target',
      path,
      oldText: input.oldText,
      newText: input.newText,
      baseHash: createHash('sha256').update(input.oldText).digest('hex'),
      mode: options.target.mode,
    });
  if (!options.readTarget) throw new AcpError('permission');
  const target = targetSnapshot.parse(options.readTarget());
  const offset = target.content.indexOf(input.oldText);
  if (
    target.path !== path ||
    target.mode !== options.target.mode ||
    offset < 0 ||
    target.content.lastIndexOf(input.oldText) !== offset
  )
    throw new AcpError('permission');
  const merged =
    target.content.slice(0, offset) +
    input.newText +
    target.content.slice(offset + input.oldText.length);
  const action = AcpPermissionActionSchema.parse({
    type: 'replace-hunk',
    path,
    oldText: input.oldText,
    newText: input.newText,
    baseHash: target.hash,
    mode: target.mode,
    afterHash: createHash('sha256').update(merged).digest('hex'),
  });
  acpPermissionAfterHash(action, target);
  return action;
}

export function startGoogleAcpWriter(options: AcpWriterOptions) {
  const plan = planSchema.parse(options.plan);
  const mappings = options.reviewMappings ?? GoogleAcpReviewMappings;
  validateAcpSetupProof(plan.proof, options.client, mappings);
  if (!plan.proof.reviewMode || !plan.proof.configOptions || !isAbsolute(options.scratch))
    throw new AcpError('configuration');
  z.strictObject({
    name: acpIdentifier,
    command: text(4096).refine(isAbsolute),
    args: z.array(text(4096)).max(16),
    env: z.array(z.never()).length(0),
  }).parse(options.mcpServer);
  let reply: ((binding: ApprovalBinding, decision: 'approved' | 'denied') => void) | undefined;
  let settled = false;
  let refusal: 'permission' | null = null;
  const handle = startAcpProcess(
    { ...options, timeoutMs: options.timeoutMs ?? 300000 },
    async (connection, onStop): Promise<AcpWriterCompletion> => {
      const proof = await initialize(connection, options.client);
      if (hashCanonical(proof.capabilities) !== hashCanonical(plan.proof.capabilities))
        throw new AcpError('configuration');
      const replay = bufferSessionUpdates(connection);
      const session = sessionSchema.parse(
        await connection.request('session/new', {
          cwd: options.scratch,
          mcpServers: [options.mcpServer],
        }),
      );
      const sessionId = session.sessionId;
      let config = decodeAcpConfiguration(session.configOptions ?? []),
        armed = false,
        cancelled = false,
        promptStarted = false,
        finalAcknowledged = false;
      const tools = new Map<string, Tool>();
      const seenTools = new Set<string>();
      let expectedTargetHash = plan.target.baseHash;
      const pending = new Map<
        string,
        { id: string | number; binding: ApprovalBinding; proposal: AcpPermissionProposal }
      >();
      const mode = plan.proof.reviewMode;
      if (!mode || !config.configOptions) throw new AcpError('configuration');
      const matchesSelection = () =>
        config.configOptions?.model.currentValue === plan.selection.modelId &&
        (config.configOptions.thoughtLevel?.currentValue ?? null) ===
          plan.selection.thoughtLevelId &&
        config.selectedModes.get(mode.configId) === mode.valueId;
      function cancel() {
        if (settled || cancelled) return;
        cancelled = true;
        armed = false;
        for (const entry of pending.values())
          connection.respond(entry.id, { outcome: { outcome: 'cancelled' } });
        pending.clear();
        if (promptStarted) connection.notify('session/cancel', { sessionId });
      }
      onStop(cancel);
      function reject(id: string | number) {
        refusal = 'permission';
        connection.respond(id, { outcome: { outcome: 'cancelled' } });
        cancel();
      }
      connection.onRequest = (id, method, params) => {
        try {
          if (method !== 'session/request_permission' || !armed || cancelled) return reject(id);
          const request = permission.parse(params);
          if (
            request.sessionId !== sessionId ||
            seenTools.has(request.toolCall.toolCallId) ||
            pending.size > 0 ||
            new Set(request.options.map((v) => v.optionId)).size !== request.options.length
          )
            return reject(id);
          const choices = request.options.filter((v) => v.kind === 'allow_once');
          if (choices.length !== 1) return reject(id);
          const tool = mergeTool(tools.get(request.toolCall.toolCallId), request.toolCall);
          const detail = decodeAcpPermissionAction({
            tool,
            client: options.client,
            scratch: options.scratch,
            target: plan.target,
            toolMappings: options.toolMappings ?? GoogleAcpToolMappings,
            readTarget: options.readTarget,
          });
          if (detail.baseHash !== expectedTargetHash) return reject(id);
          const path = detail.path;
          const proposal: AcpPermissionProposal = {
            acpTarget: {
              sessionId,
              toolCallId: tool.toolCallId,
              optionId: choices[0].optionId,
              kind: 'allow_once',
            },
            action: 'write-scratch',
            target: path,
            consequence: canonicalJson(detail),
            detail,
            actionHash: hashCanonical(detail),
            proposalHash: hashCanonical({ id, sessionId, tool, options: request.options }),
          };
          Object.freeze(proposal.detail);
          Object.freeze(proposal.acpTarget);
          Object.freeze(proposal);
          const binding = ApprovalBindingSchema.parse(options.onPermission(proposal));
          if (cancelled || !armed || settled) {
            connection.respond(id, { outcome: { outcome: 'cancelled' } });
            return;
          }
          if (
            binding.attemptId !== plan.attemptId ||
            binding.generation !== plan.generation ||
            binding.action !== proposal.action ||
            binding.target !== path ||
            hashCanonical(binding.acpTarget) !== hashCanonical(proposal.acpTarget)
          )
            return reject(id);
          seenTools.add(tool.toolCallId);
          tools.set(tool.toolCallId, tool);
          pending.set(tool.toolCallId, { id, binding, proposal });
        } catch {
          reject(id);
        }
      };
      reply = (binding, decision) => {
        connection.assertActive();
        const target = binding.acpTarget;
        const entry = target ? pending.get(target.toolCallId) : undefined;
        if (
          !entry ||
          !armed ||
          cancelled ||
          settled ||
          hashCanonical(entry.binding) !== hashCanonical(binding) ||
          hashCanonical(entry.proposal.detail) !== entry.proposal.actionHash
        )
          throw new AcpError('permission');
        pending.delete(entry.proposal.acpTarget.toolCallId);
        if (decision === 'approved') {
          if (entry.proposal.detail.baseHash !== expectedTargetHash)
            throw new AcpError('permission');
          if (options.readTarget)
            acpPermissionAfterHash(entry.proposal.detail, options.readTarget());
          else if (entry.proposal.detail.type === 'replace-hunk') throw new AcpError('permission');
          expectedTargetHash =
            entry.proposal.detail.type === 'replace-hunk'
              ? entry.proposal.detail.afterHash
              : createHash('sha256').update(entry.proposal.detail.newText).digest('hex');
          connection.respond(entry.id, {
            outcome: { outcome: 'selected', optionId: entry.proposal.acpTarget.optionId },
          });
        } else {
          connection.respond(entry.id, { outcome: { outcome: 'cancelled' } });
          cancel();
        }
      };
      connection.onNotification = (method, params) => {
        if (settled) throw new AcpError('protocol');
        if (method !== 'session/update' || params.sessionId !== sessionId)
          throw new AcpError('protocol');
        const update = z.object({ sessionUpdate: z.string() }).passthrough().parse(params.update);
        const kind = update.sessionUpdate;
        if (kind === 'config_option_update') {
          config = decodeAcpConfiguration(update.configOptions);
          if ((armed || finalAcknowledged) && !matchesSelection()) {
            cancel();
            throw new AcpError('configuration');
          }
        }
        if (kind === 'current_mode_update' && update.currentModeId !== mode.valueId) {
          cancel();
          throw new AcpError('configuration');
        }
        if (kind === 'tool_call' || kind === 'tool_call_update') {
          const patch = toolUpdate.parse(update);
          const previous = tools.get(patch.toolCallId);
          if (kind === 'tool_call' && previous) throw new AcpError('protocol');
          if (tools.size >= 128 && !previous) throw new AcpError('output-limit');
          const next = mergeTool(previous, patch);
          if (pending.has(next.toolCallId) && hashCanonical(previous) !== hashCanonical(next)) {
            cancel();
            throw new AcpError('permission');
          }
          tools.set(next.toolCallId, next);
        }
        const call = ['tool_call', 'tool_call_update'].includes(kind)
          ? toolUpdate.parse(update)
          : null;
        const supported = AcpActivitySchema.safeParse({
          sessionId,
          sessionUpdate: kind,
          ...(call
            ? {
                toolCallId: call.toolCallId,
                ...(call.status ? { status: call.status } : {}),
                locations: (call.locations ?? []).map((v) => ({
                  path: scratchPath(options.scratch, v.path),
                  ...(v.line ? { line: v.line } : {}),
                })),
              }
            : {}),
        });
        if (supported.success) {
          let output = '';
          if (['agent_message_chunk', 'user_message_chunk'].includes(kind)) {
            const content = z
              .object({ type: z.string(), text: text(65536).optional() })
              .parse(update.content);
            if (content.type === 'text') output = content.text ?? '';
          }
          options.onActivity(supported.data, output);
        }
      };
      replay();
      const set = async (configId: string, value: string, final = false) => {
        await connection.request(
          'session/set_config_option',
          { sessionId, configId, value },
          (raw) => {
            const ack = z.object({ configOptions: z.unknown() }).parse(raw);
            config = decodeAcpConfiguration(ack.configOptions);
            const acknowledged = z
              .array(configSchema)
              .parse(ack.configOptions)
              .find((v) => v.id === configId);
            if (
              acknowledged?.currentValue !== value ||
              config.configOptions?.model.currentValue !== plan.selection.modelId
            )
              throw new AcpError('configuration');
            if (
              !config.modeValues.some(
                (v) => v.optionId === mode.configId && v.valueId === mode.valueId,
              )
            )
              throw new AcpError('configuration');
            if (final) {
              if (!matchesSelection()) throw new AcpError('configuration');
              finalAcknowledged = true;
            }
          },
        );
      };
      const observed = config.configOptions;
      if (!observed.model.supported.includes(plan.selection.modelId))
        throw new AcpError('configuration');
      await set(observed.model.optionId, plan.selection.modelId);
      if (
        !config.configOptions ||
        config.configOptions.model.currentValue !== plan.selection.modelId
      )
        throw new AcpError('configuration');
      const thought = config.configOptions.thoughtLevel;
      if (plan.selection.thoughtLevelId !== null) {
        if (!thought?.supported.includes(plan.selection.thoughtLevelId))
          throw new AcpError('configuration');
        await set(thought.optionId, plan.selection.thoughtLevelId);
      } else if (thought) throw new AcpError('configuration');
      if (
        !config.modeValues.some((v) => v.optionId === mode.configId && v.valueId === mode.valueId)
      )
        throw new AcpError('configuration');
      await set(mode.configId, mode.valueId, true);
      if (!matchesSelection() || cancelled) throw new AcpError('configuration');
      connection.assertActive();
      const submitted: unknown = options.onSubmitted();
      if (submitted instanceof Promise) {
        void submitted.catch(() => {});
        throw new AcpError('ownership');
      }
      if (cancelled) throw new AcpError('stopped');
      connection.assertActive();
      armed = true;
      promptStarted = true;
      const terminal = z
        .object({
          stopReason: z.enum([
            'end_turn',
            'max_tokens',
            'max_turn_requests',
            'refusal',
            'cancelled',
          ]),
        })
        .parse(
          await connection.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: plan.prompt }],
          }),
        );
      settled = true;
      armed = false;
      if (
        pending.size ||
        (!cancelled &&
          [...tools.values()].some((v) => v.status === 'pending' || v.status === 'in_progress')) ||
        (cancelled && terminal.stopReason !== 'cancelled') ||
        (!cancelled && terminal.stopReason === 'cancelled')
      )
        throw new AcpError('protocol');
      await closeSession(connection, proof, sessionId);
      return {
        sessionId,
        stopReason: terminal.stopReason,
        submitted: true,
        selectionHash: hashCanonical(plan.selection),
        reviewModeHash: hashCanonical(mode),
        targetHash: expectedTargetHash,
      };
    },
  );
  return {
    ...handle,
    result: handle.result.then((outcome) => ({
      ...outcome,
      reason:
        outcome.reason ??
        refusal ??
        (outcome.metadata?.stopReason === 'cancelled' ? ('stopped' as const) : null),
    })),
    stop: () => {
      if (!settled) handle.stop();
    },
    replyPermission(binding: ApprovalBinding, decision: 'approved' | 'denied') {
      if (!reply) throw new AcpError('permission');
      reply(binding, decision);
    },
  };
}
