import {
  AcceptChatChangesPayloadSchema,
  type ChatBranchStatus,
  ChatBranchStatusSchema,
  type ChatCatalogRead,
  ChatCatalogReadSchema,
  type ChatChangesRead,
  ChatChangesReadSchema,
  type ChatThreadRead,
  ChatThreadReadSchema,
  type CommandResult,
  ConfigureChatThreadPayloadSchema,
  HandoffChatThreadPayloadSchema,
  OpenChatPullRequestPayloadSchema,
  PushChatBranchPayloadSchema,
  ReadChatBranchStatusPayloadSchema,
  ReadChatCatalogPayloadSchema,
  ReadChatChangesPayloadSchema,
  ReadChatThreadPayloadSchema,
  RefreshChatModelsPayloadSchema,
  ResolveChatPermissionPayloadSchema,
  SendChatMessagePayloadSchema,
  SteerChatMessagePayloadSchema,
  StopChatTurnPayloadSchema,
} from '@crewkite/contracts';
import type { DesktopCommand, DesktopSource } from '../source.ts';

// The chat commands are listed in CommandSchema. The cast stays in this one file so the thread
// view never spells a command name anywhere else.
export type ThreadSource = Pick<DesktopSource, 'command' | 'subscribe'>;
// Mutations carry a revision by contract. The controller does not race chat commands on it, so
// the thread sends zero and never has to chase the task revision while events stream.
const CHAT_REVISION = 0;
// The desktop does not depend on zod directly, so payload types come from the schema objects.
type Input<S extends { _zod: { input: unknown } }> = S['_zod']['input'];

const dispatch = (source: ThreadSource, command: string, payload: unknown) =>
  source.command({
    command,
    payload,
    ...(command.startsWith('Read') ? {} : { expectedRevision: CHAT_REVISION }),
  } as unknown as DesktopCommand);

async function run(
  source: ThreadSource,
  command: string,
  payload: unknown,
): Promise<CommandResult> {
  const result = await dispatch(source, command, payload);
  // The reason is a code for the log. The next step is the sentence written for the person.
  if (result.outcome !== 'applied' && result.outcome !== 'already-applied')
    throw new Error(result.next ?? result.reason ?? 'The controller did not accept this request.');
  return result;
}

// Read results come back in CommandResult.data. A kind tag, if the controller adds one, is not part
// of the read shapes.
async function read<T>(
  source: ThreadSource,
  command: string,
  payload: unknown,
  schema: { parse(data: unknown): T },
): Promise<T> {
  const { data } = await run(source, command, payload);
  if (data === undefined) throw new Error('The controller returned no data for this request.');
  const { kind: _kind, ...rest } = data as Record<string, unknown>;
  return schema.parse(rest);
}

export const readThread = (source: ThreadSource, taskId: string): Promise<ChatThreadRead> =>
  read(
    source,
    'ReadChatThread',
    ReadChatThreadPayloadSchema.parse({ taskId, limit: 200 }),
    ChatThreadReadSchema,
  );
export const readChanges = (source: ThreadSource, taskId: string): Promise<ChatChangesRead> =>
  read(
    source,
    'ReadChatChanges',
    ReadChatChangesPayloadSchema.parse({ taskId }),
    ChatChangesReadSchema,
  );
export const readCatalog = (source: ThreadSource, taskId?: string): Promise<ChatCatalogRead> =>
  read(
    source,
    'ReadChatCatalog',
    ReadChatCatalogPayloadSchema.parse({ taskId }),
    ChatCatalogReadSchema,
  );

// A read can take 20 seconds and its refusal names the next step, so the result comes back as is.
export const refreshModels = (source: ThreadSource) =>
  dispatch(source, 'RefreshChatModels', RefreshChatModelsPayloadSchema.parse({ family: 'openai' }));

export const sendMessage = (
  source: ThreadSource,
  input: Input<typeof SendChatMessagePayloadSchema>,
) => run(source, 'SendChatMessage', SendChatMessagePayloadSchema.parse(input));
export const resolvePermission = (
  source: ThreadSource,
  input: Input<typeof ResolveChatPermissionPayloadSchema>,
) => run(source, 'ResolveChatPermission', ResolveChatPermissionPayloadSchema.parse(input));
export const stopTurn = (source: ThreadSource, input: Input<typeof StopChatTurnPayloadSchema>) =>
  run(source, 'StopChatTurn', StopChatTurnPayloadSchema.parse(input));
// A refusal throws with the controller's next step, such as "Nothing is running. Send the message."
export const steerMessage = (
  source: ThreadSource,
  input: Input<typeof SteerChatMessagePayloadSchema>,
) => run(source, 'SteerChatMessage', SteerChatMessagePayloadSchema.parse(input));
export const configureThread = (
  source: ThreadSource,
  input: Input<typeof ConfigureChatThreadPayloadSchema>,
) => run(source, 'ConfigureChatThread', ConfigureChatThreadPayloadSchema.parse(input));
export const handoffThread = (
  source: ThreadSource,
  input: Input<typeof HandoffChatThreadPayloadSchema>,
) => run(source, 'HandoffChatThread', HandoffChatThreadPayloadSchema.parse(input));

export type Acceptance =
  | { accepted: true; branch: string; commit: string; fileCount: number; note: string | null }
  | { accepted: false; reason: string; next: string | null };
// Refusals come back as values so the Changes tab can name each reason on its own line.
export async function acceptChanges(
  source: ThreadSource,
  input: Input<typeof AcceptChatChangesPayloadSchema>,
): Promise<Acceptance> {
  const payload = AcceptChatChangesPayloadSchema.safeParse(input);
  if (!payload.success) return { accepted: false, reason: 'branch-name-unsupported', next: null };
  const result = await dispatch(source, 'AcceptChatChanges', payload.data);
  if (result.outcome === 'applied' && result.data?.kind === 'chat-acceptance') {
    const { branch, commit, fileCount } = result.data;
    return { accepted: true, branch, commit, fileCount, note: result.next ?? null };
  }
  return { accepted: false, reason: result.reason ?? 'not-accepted', next: result.next ?? null };
}

export type GitStep =
  | { done: true; url: string | null; via: 'gh' | 'compare-link' | null }
  | { done: false; message: string };
// A push or pull request refusal carries git's or gh's own last line as its reason. That line is
// worth showing with the next step. A reason code is not.
async function gitStep(source: ThreadSource, command: string, payload: unknown): Promise<GitStep> {
  const result = await dispatch(source, command, payload);
  if (result.outcome === 'applied' || result.outcome === 'already-applied') {
    const data = result.data;
    if (data?.kind === 'chat-pull-request') return { done: true, url: data.url, via: data.via };
    return { done: true, url: null, via: null };
  }
  const said = result.reason && !/^[a-z-]+$/.test(result.reason) ? result.reason : null;
  const message = [said, result.next].filter(Boolean).join(' ');
  return { done: false, message: message || 'The step did not run.' };
}
/** Only the confirmation button calls this, so `confirmed` is always the person's answer. */
export const pushBranch = (source: ThreadSource, taskId: string, branch: string) =>
  gitStep(
    source,
    'PushChatBranch',
    PushChatBranchPayloadSchema.parse({ taskId, branch, confirmed: true }),
  );
export const openPullRequest = (
  source: ThreadSource,
  input: Input<typeof OpenChatPullRequestPayloadSchema>,
) => gitStep(source, 'OpenChatPullRequest', OpenChatPullRequestPayloadSchema.parse(input));
export const readBranchStatus = (
  source: ThreadSource,
  taskId: string,
  branch: string,
): Promise<ChatBranchStatus> =>
  read(
    source,
    'ReadChatBranchStatus',
    ReadChatBranchStatusPayloadSchema.parse({ taskId, branch }),
    ChatBranchStatusSchema,
  );

// The controller events the thread view folds. A conversation entry also reaches the workspace,
// which still reads it. The other three are streamed output and thread state. They change many
// times a second, so the workspace skips them and does not re-read its snapshot for every delta.
const threadEventTypes = new Set(['agent.event', 'chat.turn', 'chat.thread', 'conversation.entry']);
export const isThreadEvent = (type: string) => threadEventTypes.has(type);
export const isStreamEvent = (type: string) =>
  type === 'agent.event' || type === 'chat.turn' || type === 'chat.thread';
