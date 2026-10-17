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
  type AcpClientPinSchema,
  type AcpReviewMapping,
  type AcpSetupProof,
  AcpSetupProofSchema,
  acpClientPin,
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
export type AcpToolMapping = {
  client: z.infer<typeof AcpClientPinSchema>;
  toolName: string;
  schema: 'replace-target-v1';
  evidenceHash: string;
};
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
          hashCanonical(v.client) === hashCanonical(proof.client) &&
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
  } & AcpDependencies,
): AcpWriterPlan {
  const proof = validateAcpSetupProof(options.proof, options.proof.client, options.reviewMappings);
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
export const AcpPermissionActionSchema = z
  .strictObject({
    type: z.literal('replace-target'),
    path: NativeTargetPathSchema,
    oldText: text(65536),
    newText: text(65536),
    baseHash: HashSchema,
    mode: z.enum(['100644', '100755']),
  })
  .refine(
    (v) =>
      Buffer.byteLength(v.oldText) <= 65536 &&
      Buffer.byteLength(v.newText) <= 65536 &&
      Buffer.byteLength(canonicalJson(v)) <= 4096 &&
      createHash('sha256').update(v.oldText).digest('hex') === v.baseHash,
  );
export type AcpPermissionAction = z.infer<typeof AcpPermissionActionSchema>;
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
    onActivity(activity: z.infer<typeof AcpActivitySchema>, text: string): void;
  };
export type AcpWriterCompletion = {
  sessionId: string;
  stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
  submitted: true;
  selectionHash: string;
  reviewModeHash: string;
};
const toolUpdate = z.object({
  toolCallId: acpIdentifier,
  name: acpIdentifier.nullable().optional(),
  title: text(4096).nullable().optional(),
  kind: z.string().nullable().optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']).nullable().optional(),
  rawInput: z.unknown().optional(),
  content: z.array(z.unknown()).max(32).nullable().optional(),
  locations: z
    .array(z.object({ path: text(4096), line: z.number().int().positive().nullable().optional() }))
    .max(32)
    .nullable()
    .optional(),
});
type Tool = z.infer<typeof toolUpdate>;
const permission = z.object({
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
    if (value !== null && value !== undefined) Object.assign(next, { [key]: value });
  return next;
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
          const toolMappings = (options.toolMappings ?? GoogleAcpToolMappings).filter(
            (v) =>
              hashCanonical(v.client) === hashCanonical(proof.client) &&
              v.schema === 'replace-target-v1' &&
              v.toolName === tool.name &&
              HashSchema.safeParse(v.evidenceHash).success,
          );
          if (toolMappings.length !== 1 || tool.kind !== 'edit' || tool.status !== 'pending')
            return reject(id);
          const input = z
            .strictObject({ path: text(4096), oldText: text(65536), newText: text(65536) })
            .parse(tool.rawInput);
          const path = scratchPath(options.scratch, input.path);
          if (path !== plan.target.path) return reject(id);
          for (const location of tool.locations ?? [])
            if (scratchPath(options.scratch, location.path) !== path) return reject(id);
          for (const content of tool.content ?? []) {
            const diff = z
              .strictObject({
                type: z.literal('diff'),
                path: text(4096),
                oldText: text(65536),
                newText: text(65536),
              })
              .parse(content);
            if (
              scratchPath(options.scratch, diff.path) !== path ||
              diff.oldText !== input.oldText ||
              diff.newText !== input.newText
            )
              return reject(id);
          }
          const detail = AcpPermissionActionSchema.parse({
            type: 'replace-target',
            path,
            oldText: input.oldText,
            newText: input.newText,
            baseHash: createHash('sha256').update(input.oldText).digest('hex'),
            mode: plan.target.mode,
          });
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
        if (decision === 'approved')
          connection.respond(entry.id, {
            outcome: { outcome: 'selected', optionId: entry.proposal.acpTarget.optionId },
          });
        else {
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
