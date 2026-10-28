import type {
  AgentEvent,
  ChatChangesRead,
  ChatMessage,
  ChatModelSelection,
  ChatThread,
  ChatThreadRead,
  ChatTurn,
  CommandResult,
} from '@crewkite/contracts';
import {
  BASE,
  catalog,
  DIFF,
  FIRST_SELECTION,
  familyNames,
  openingEvents,
  SELECTION,
  TEST_OUTPUT,
  usageLimit,
} from './preview-data.ts';

// Scripted thread for the interface preview. It answers the same commands and sends the same events
// as the controller, so the thread view runs without one. No provider is involved.

export type PreviewBus = {
  /** Publishes an event and returns its cursor. A function payload receives that cursor. */
  publish: (type: string, payload: unknown) => string;
  advance: (cursor: bigint) => void;
  /** The cursor of the last published event, which a read reports as the point it reflects. */
  cursor: () => string;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pieces = (text: string, size: number) =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, at) =>
    text.slice(at * size, (at + 1) * size),
  );
let sequence = 0;
const mint = (prefix: string) => `${prefix}_0${String(++sequence).padStart(25, '0')}`;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

export function createThreadScript(bus: PreviewBus, taskId: string, seeded: boolean) {
  const failedTurn = mint('trn');
  const openTurn = mint('trn');
  let thread: ChatThread = {
    taskId,
    scratchReady: seeded,
    base: seeded ? BASE : null,
    selection: SELECTION,
    permissionPolicy: 'ask',
    sessions: [],
    activeTurnId: null,
    autoHandoff: false,
    handoffMode: 'most-left',
    crew: null,
    flightMode: 'manual',
    crewChain: null,
    queued: [],
  };
  const messages: ChatMessage[] = [];
  const turns: ChatTurn[] = [];
  let live: AgentEvent[] = [];
  let stopped = false;
  let awaiting: string | null = null;

  const emit = (event: AgentEvent) => {
    live.push(event);
    bus.publish('agent.event', event);
  };
  const store = (author: ChatMessage['author'], text: string, cursor: string, at = ago(0)) => {
    const stored: ChatMessage = {
      id: mint('msg'),
      taskId,
      at,
      cursor,
      author,
      text,
      attachments: [],
      files: [],
    };
    messages.push(stored);
    return stored;
  };
  // A message is stored and published under the cursor the event log gives it.
  const say = (author: ChatMessage['author'], text: string) => {
    let stored: ChatMessage | undefined;
    bus.publish('conversation.entry', (cursor: string) => {
      stored = store(author, text, cursor);
      return stored;
    });
    return stored as ChatMessage | undefined;
  };
  const setThread = (patch: Partial<ChatThread>) => {
    thread = { ...thread, ...patch };
    bus.publish('chat.thread', thread);
  };
  const setTurn = (turn: ChatTurn) => {
    const at = turns.findIndex(({ id }) => id === turn.id);
    if (at === -1) turns.push(turn);
    else turns[at] = turn;
    bus.publish('chat.turn', turn);
  };

  if (seeded) {
    const user = store(
      { kind: 'user' },
      'Add netMinor(subtotalMinor, discountMinor) to net.mjs. Reject negative and fractional input.',
      '101',
      ago(200_000),
    );
    store(
      { kind: 'system', turnId: null },
      'Continued on Anthropic (large-2) from OpenAI. Reason: five-hour limit reached, resets in 1 h 40 min.',
      '103',
      ago(60_000),
    );
    const shared = {
      taskId,
      role: 'assistant' as const,
      userMessageId: user.id,
      assistantMessageId: null,
    };
    turns.push(
      {
        ...shared,
        id: failedTurn,
        sequence: 0,
        selection: FIRST_SELECTION,
        state: 'failed',
        startedAt: ago(180_000),
        endedAt: ago(170_000),
        failure: usageLimit(),
        handoffFrom: null,
      },
      {
        ...shared,
        id: openTurn,
        sequence: 1,
        selection: SELECTION,
        state: 'waiting-permission',
        startedAt: ago(30_000),
        endedAt: null,
        failure: null,
        handoffFrom: 'openai',
      },
    );
    thread = {
      ...thread,
      activeTurnId: openTurn,
      queued: [
        {
          id: mint('msg'),
          at: ago(12_000),
          text: 'Then add a test for a discount larger than the subtotal.',
          role: 'assistant',
          attachments: [],
          files: [],
        },
      ],
      sessions: [
        {
          family: 'openai',
          sessionId: 'session-openai-0001',
          model: 'large-1',
          updatedAt: ago(180_000),
        },
        {
          family: 'anthropic',
          sessionId: 'session-anthropic-0002',
          model: 'large-2',
          updatedAt: ago(30_000),
        },
      ],
    };
    live = openingEvents(openTurn, SELECTION);
    awaiting = 'p1';
    bus.advance(110n);
  }

  async function stream(turnId: string, kind: 'text' | 'thinking', itemId: string, text: string) {
    for (const piece of pieces(text, 14)) {
      if (stopped) throw new Error('stopped');
      emit({ type: `${kind}.delta`, turnId, itemId, text: piece });
      await sleep(40);
    }
    emit(
      kind === 'text'
        ? { type: 'text.completed', turnId, itemId, text }
        : { type: 'thinking.completed', turnId, itemId },
    );
  }
  async function finish(turnId: string, selection: ChatModelSelection, body: () => Promise<void>) {
    let stopReason: 'done' | 'stopped' = 'done';
    try {
      await body();
    } catch {
      stopReason = 'stopped';
    }
    // A stop arrives as a failure of kind 'stopped', the way the adapters report it.
    emit({
      type: 'turn.completed',
      turnId,
      stopReason,
      failure:
        stopReason === 'done'
          ? null
          : {
              stage: 'stream',
              kind: 'stopped',
              message: 'The turn was stopped.',
              providerMessage: null,
              method: null,
              code: null,
              resetsAt: null,
              nextAction: 'Send a new message to continue.',
            },
    });
    // The controller keeps what was streamed, so a stopped turn stores its partial text.
    const last = live.findLast((e) => e.type === 'text.delta' || e.type === 'text.completed');
    const text =
      last?.type === 'text.completed'
        ? last.text
        : last
          ? live
              .flatMap((e) => (e.type === 'text.delta' && e.itemId === last.itemId ? [e.text] : []))
              .join('')
          : '';
    const author = {
      kind: 'assistant',
      turnId,
      family: selection.family,
      model: selection.model,
      role: 'assistant',
    } as const;
    const stored = text ? say(author, text) : undefined;
    const turn = turns.find(({ id }) => id === turnId);
    if (turn)
      setTurn({
        ...turn,
        state: stopReason === 'done' ? 'done' : 'stopped',
        endedAt: ago(0),
        assistantMessageId: stored?.id ?? null,
      });
    live = [];
    stopped = false;
    setThread({ activeTurnId: null });
    // Like the controller, the oldest queued message starts once the turn has ended.
    const [first, ...rest] = thread.queued;
    if (!first) return;
    setThread({ queued: rest });
    say({ kind: 'user' }, first.text);
    void answer(first.text);
  }

  async function afterPermission(choice: string) {
    const turnId = openTurn;
    awaiting = null;
    emit({ type: 'permission.resolved', turnId, requestId: 'p1', choice });
    await finish(turnId, SELECTION, async () => {
      const run = { turnId, callId: 'c3' };
      if (choice === 'deny') {
        emit({ type: 'tool.started', ...run, kind: 'command', title: 'Run node --test' });
        emit({ type: 'tool.completed', ...run, status: 'denied' });
        await stream(
          turnId,
          'text',
          'a2',
          'Understood. I left the tests unrun. The change is in the scratch copy under Changes.',
        );
        return;
      }
      emit({
        type: 'tool.started',
        ...run,
        kind: 'command',
        title: 'Run node --test',
        input: { command: 'node --test' },
      });
      for (const line of TEST_OUTPUT) {
        emit({ type: 'tool.output', ...run, chunk: `${line}\n` });
        await sleep(120);
      }
      emit({ type: 'tool.completed', ...run, status: 'ok', summary: '3 passed' });
      await stream(
        turnId,
        'text',
        'a2',
        'All three tests pass. netMinor now rejects negative, fractional and unsafe inputs. Review the change under Changes.',
      );
    });
  }

  async function answer(text: string) {
    const selection = thread.selection ?? SELECTION;
    const turnId = mint('trn');
    const user = messages.findLast(({ author }) => author.kind === 'user');
    const turn: ChatTurn = {
      id: turnId,
      taskId,
      sequence: turns.length,
      role: 'assistant',
      selection,
      userMessageId: user?.id ?? mint('msg'),
      assistantMessageId: null,
      state: 'running',
      startedAt: ago(0),
      endedAt: null,
      failure: null,
      handoffFrom: null,
    };
    setTurn(turn);
    setThread({ activeTurnId: turnId });
    emit({
      type: 'turn.started',
      turnId,
      family: selection.family,
      model: selection.model,
      effort: selection.effort,
      role: 'assistant',
    });
    // The preview catalog has OpenAI at 0% left, so a turn on it stops on its limit as a real one would.
    if (selection.family === 'openai') {
      const failure = usageLimit();
      emit({ type: 'turn.completed', turnId, stopReason: 'limit', failure });
      setTurn({ ...turn, state: 'failed', endedAt: ago(0), failure });
      live = [];
      setThread({ activeTurnId: null });
      return;
    }
    await finish(turnId, selection, async () => {
      await stream(turnId, 'thinking', 'th', 'Preview turn. No provider runs here.');
      await stream(
        turnId,
        'text',
        'a',
        `This is a scripted reply from ${familyNames[selection.family]} to "${text.slice(0, 60)}". Connect the controller to run real turns.`,
      );
    });
  }

  function command(name: string, payload: Record<string, unknown>): CommandResult | null {
    const data = (value: unknown) =>
      ({ outcome: 'applied', data: value }) as unknown as CommandResult;
    const ok: CommandResult = { outcome: 'applied' };
    switch (name) {
      case 'ReadChatThread': {
        const read: ChatThreadRead = {
          thread,
          turns,
          messages,
          liveEvents: live,
          cursor: bus.cursor(),
        };
        return data(read);
      }
      case 'ReadChatChanges': {
        const changes: ChatChangesRead = {
          taskId,
          base: thread.base,
          files: seeded ? [{ path: 'net.mjs', additions: 5, deletions: 2, patch: DIFF }] : [],
        };
        return data(changes);
      }
      case 'ReadChatCatalog':
        return data(catalog());
      case 'SendChatMessage':
        if (thread.activeTurnId) {
          if (thread.queued.length >= 8)
            return { outcome: 'blocked', reason: 'queue-full', next: 'Remove a queued message.' };
          const text = String(payload.text);
          const message = {
            id: mint('msg'),
            at: ago(0),
            text,
            role: 'assistant' as const,
            attachments: [],
            files: [],
          };
          setThread({ queued: [...thread.queued, message] });
          return ok;
        }
        say({ kind: 'user' }, String(payload.text));
        void answer(String(payload.text));
        return ok;
      case 'ResolveChatPermission':
        if (awaiting !== payload.requestId)
          return { outcome: 'blocked', reason: 'That request is no longer open.' };
        void afterPermission(String(payload.choice));
        return ok;
      case 'StopChatTurn':
        stopped = true;
        setThread({ queued: [] });
        if (awaiting) void afterPermission('deny');
        return ok;
      case 'ConfigureChatThread': {
        const {
          taskId: _task,
          dequeue,
          // The preview has no project files to read, so a checks edit changes nothing.
          checks: _checks,
          ...patch
        } = payload as Partial<ChatThread> & {
          taskId: string;
          dequeue?: string;
          checks?: unknown;
        };
        const queued = thread.queued.filter((message) => message.id !== dequeue);
        // Like the controller: no crew means manual, and entering glide turns automatic handoff on.
        const crew = patch.crew === undefined ? thread.crew : patch.crew;
        if (!crew && patch.flightMode && patch.flightMode !== 'manual')
          return {
            outcome: 'blocked',
            reason: 'crew-missing',
            next: 'Pick a crew, then choose a flight mode.',
          };
        const flightMode = crew ? (patch.flightMode ?? thread.flightMode) : 'manual';
        const glides = flightMode === 'glide' && thread.flightMode !== 'glide';
        setThread({
          ...patch,
          crew,
          flightMode,
          autoHandoff: glides ? true : (patch.autoHandoff ?? thread.autoHandoff),
          queued,
        });
        return ok;
      }
      // Stop the reply and keep the queue, with this message first. The stopped turn's finish
      // starts it, the way a limit stop hands over.
      case 'SteerChatMessage': {
        const message = thread.queued.find(({ id }) => id === payload.messageId);
        if (!thread.activeTurnId)
          return {
            outcome: 'blocked',
            reason: 'nothing-running',
            next: 'Nothing is running. Send the message.',
          };
        if (!message)
          return {
            outcome: 'blocked',
            reason: 'message-not-queued',
            next: 'It is no longer queued. If it started, Stop ends it.',
          };
        setThread({ queued: [message, ...thread.queued.filter(({ id }) => id !== message.id)] });
        stopped = true;
        if (awaiting) void afterPermission('deny');
        return ok;
      }
      case 'HandoffChatThread': {
        const next = payload.selection as ChatModelSelection;
        const from = thread.selection?.family ?? 'openai';
        say(
          { kind: 'system', turnId: null },
          `Continued on ${familyNames[next.family]} (${next.model}) from ${familyNames[from]}. Reason: chosen in the composer.`,
        );
        setThread({ selection: next });
        return ok;
      }
      // The git steps answer the way the controller does after a push to a github.com remote with
      // gh installed, so the Changes tab shows each step without touching a repository.
      case 'AcceptChatChanges': {
        const branch = String(payload.branch);
        if (!seeded) return { outcome: 'blocked', reason: 'no-changes' };
        const commit = '7'.repeat(40);
        setThread({ lastAcceptance: { branch, at: ago(0), fileCount: 1, commit }, lastPush: null });
        say({ kind: 'system', turnId: null }, `Accepted 1 file to branch ${branch}.`);
        return data({ kind: 'chat-acceptance', branch, commit, fileCount: 1 });
      }
      case 'PushChatBranch': {
        const accepted = thread.lastAcceptance;
        if (!accepted?.commit || accepted.branch !== payload.branch)
          return {
            outcome: 'blocked',
            reason: 'branch-not-accepted',
            next: 'Accept the changes to this branch, then push.',
          };
        const { branch, commit } = accepted;
        setThread({
          lastPush: { branch, remote: 'origin', commit, at: ago(0), pullRequestUrl: null },
        });
        say({ kind: 'system', turnId: null }, `Pushed ${branch} to origin.`);
        return data({ kind: 'chat-push', branch, remote: 'origin', commit });
      }
      case 'OpenChatPullRequest': {
        const pushed = thread.lastPush;
        if (!pushed || pushed.branch !== payload.branch)
          return {
            outcome: 'blocked',
            reason: 'branch-not-pushed',
            next: 'Push the branch, then open a pull request.',
          };
        const url = 'https://github.com/rjk6831/demo-shop/pull/12';
        setThread({ lastPush: { ...pushed, pullRequestUrl: url } });
        say({ kind: 'system', turnId: null }, `Opened a pull request for ${pushed.branch}.`);
        return data({ kind: 'chat-pull-request', url, via: 'gh' });
      }
      case 'ReadChatBranchStatus':
        return data({
          kind: 'chat-branch-status',
          branch: String(payload.branch),
          runs: thread.lastPush
            ? [
                {
                  id: '9001',
                  name: 'verify',
                  status: 'in_progress',
                  conclusion: null,
                  url: 'https://github.com/rjk6831/demo-shop/actions/runs/9001',
                  createdAt: thread.lastPush.at,
                },
              ]
            : [],
          reason: null,
          readAt: ago(0),
        });
      default:
        return null;
    }
  }
  return { command };
}
