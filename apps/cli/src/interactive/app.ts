import { homedir } from 'node:os';
import {
  type ChatBranchStatus,
  type ChatCatalogRead,
  type ChatChangesRead,
  type ChatFamily,
  ChatFamilySchema,
  type ChatModelSelection,
  type ChatThread,
  type CliSettings,
  type Event,
  rankFamilies,
  type TaskSummary,
} from '@crewkite/contracts';
import { Box, type Key, Static, Text, useApp, useInput, usePaste, useWindowSize } from 'ink';
import {
  createElement as h,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  crewFromPreset,
  crewPresetNames,
  familyModel,
  readCrewPresets,
} from '../../../desktop/src/renderer/settings/preferences.ts';
import { tryWithChoices } from '../../../desktop/src/renderer/thread/file-fit.ts';
import {
  activeTurnId,
  historyWanted,
  initialThreadState,
  lastReply,
  reduceThread,
  type ThreadItem,
  threadItems,
  triedFamilies,
  turnFiles,
} from '../../../desktop/src/renderer/thread/thread-state.ts';
import { callerDirectory, checkoutAt, projectsForCheckout } from '../chat/checkout.ts';
import { applied, type ChatClient } from '../chat/client.ts';
import { parseSlash } from '../chat/composer-shared.ts';
import { chooseSelection } from '../chat/scripting.ts';
import { settingsStore } from '../settings.ts';
import { SPINNER_INTERVAL_MS } from './brand.ts';
import {
  acceptCompletion,
  attachmentPaths,
  backspace,
  type Composer,
  closeCompletion,
  emptyComposer,
  insert,
  mentionQuery,
  moveCaret,
  offerMentions,
  sent,
  vertical,
} from './composer-state.ts';
import { beforeGoogleConnection } from './google-gate.ts';
import { matches } from './keys.ts';
import { colorAllowed, familyNames, palette, resolveTheme, safeText } from './theme.ts';
import {
  type Animation,
  ChangesView,
  ComposerView,
  CrewView,
  FamilyMark,
  HelpView,
  handoffLabels,
  PlanCardView,
  policyLabels,
  SettingsView,
  settingsFields,
  ThreadListView,
  ThreadRows,
  UsageLine,
  Wordmark,
} from './views.ts';

// The interactive CLI. It holds the screen state and turns keys into chat commands; the views
// draw, the renderer's thread state folds the stream, and the controller decides every command.

type Printed = { key: string; node: ReactNode };
type View = 'thread' | 'threads' | 'changes' | 'crew' | 'plan' | 'settings' | 'help';
type Confirm = { question: string; yes: () => void | Promise<void> };
type LinePrompt = { label: string; value: string; submit: (value: string) => void | Promise<void> };

export type AppProps = {
  client: ChatClient;
  settings: CliSettings;
  saveSettings: (next: CliSettings) => CliSettings;
  /** Ink renders before the first read finishes, and this note shows above the composer. */
  settingsProblem: string | null;
  animation: Animation;
  env: NodeJS.ProcessEnv;
  /** The directory the CLI started in, when INIT_CWD does not name one. */
  cwd?: string;
  now?: () => number;
};

const cycle = <T>(values: readonly T[], current: T, step: number): T =>
  values[(values.indexOf(current) + step + values.length) % values.length];

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'changes';

/** Items that will not change any more, and the live rest. Static output takes only the first. */
function settledPrefix(items: readonly ThreadItem[]): number {
  const index = items.findIndex(
    (item) => (item.kind === 'turn' && !item.turn.ended) || (item.kind === 'user' && item.pending),
  );
  return index === -1 ? items.length : index;
}

type Action = Parameters<typeof reduceThread>[1] | { type: 'reset'; taskId: string };
const threadReducer = (state: ReturnType<typeof initialThreadState>, action: Action) =>
  action.type === 'reset' ? initialThreadState(action.taskId) : reduceThread(state, action);

export function App(props: AppProps) {
  const { client } = props;
  const now = props.now ?? Date.now;
  const app = useApp();
  const { columns } = useWindowSize();
  const width = Math.max(40, columns - 2);
  const [settings, setSettings] = useState(props.settings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // A settings file with a problem stays as it is until the person fixes it by hand.
  const save = useCallback(
    (next: CliSettings) => {
      if (props.settingsProblem)
        throw new Error(`${props.settingsProblem} Nothing was saved; fix cli.json first.`);
      setSettings(props.saveSettings(next));
    },
    [props.saveSettings, props.settingsProblem],
  );
  const store = useMemo(() => settingsStore(() => settingsRef.current, save), [save]);
  const colors = useMemo(
    () => palette(resolveTheme(settings.theme, props.env), colorAllowed(props.env)),
    [settings.theme, props.env],
  );
  const animation: Animation =
    props.animation === 'off' || settings.animation === 'off'
      ? 'off'
      : props.animation === 'reduced' || settings.animation === 'reduced'
        ? 'reduced'
        : 'full';

  const [view, setView] = useState<View>('thread');
  const [threads, setThreads] = useState<{ list: TaskSummary[]; complete: boolean }>({
    list: [],
    complete: true,
  });
  const [threadIndex, setThreadIndex] = useState(0);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  /** Null until the checkout matches one project, or the person picks one. */
  const [projectIndex, setProjectIndex] = useState<number | null>(null);
  const [promptFocus, setPromptFocus] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const taskRef = useRef<string | null>(null);
  taskRef.current = taskId;
  const [state, dispatch] = useReducer(threadReducer, initialThreadState(''));
  const [ready, setReady] = useState(false);
  const [catalog, setCatalog] = useState<ChatCatalogRead | null>(null);
  const [composer, setComposer] = useState<Composer>(emptyComposer());
  const [notice, setNotice] = useState<string | null>(props.settingsProblem);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [linePrompt, setLinePrompt] = useState<LinePrompt | null>(null);
  const [changes, setChanges] = useState<ChatChangesRead | null>(null);
  const [changeIndex, setChangeIndex] = useState(0);
  const [branchStatus, setBranchStatus] = useState<ChatBranchStatus | null>(null);
  const [settingsField, setSettingsField] = useState(0);
  const [frame, setFrame] = useState(0);
  const [showThinking, setShowThinking] = useState(false);
  const printed = useRef<Printed[]>([]);
  const printedKeys = useRef(new Set<string>());

  const say = useCallback(
    (failure: unknown) => setNotice(failure instanceof Error ? failure.message : String(failure)),
    [],
  );
  const thread = state.loaded && state.taskId === taskId ? state.thread : null;
  const items = useMemo(() => (taskId && ready ? threadItems(state) : []), [state, taskId, ready]);
  const running = taskId ? activeTurnId(state) : null;

  // The first read: providers, threads and projects, then the event stream from that point.
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const header = await client.transport.workspaceState();
        setCatalog(await client.readCatalog());
        const known = await client.listThreads();
        setThreads({ list: known.threads, complete: known.complete });
        const listed = await client.listProjects();
        setProjects(listed.map(({ id, name }) => ({ id, name })));
        // New threads go to the project this terminal is in, when exactly one matches it.
        const checkout = checkoutAt(
          callerDirectory(props.env, props.cwd ?? process.cwd()),
          props.env,
        );
        const here = checkout ? await projectsForCheckout(client, checkout, listed) : [];
        if (here.length === 1)
          setProjectIndex(listed.findIndex((project) => project.id === here[0].id));
        if (cancelled) return;
        stop = await client.transport.subscribe(header.cursor, (event: Event) => {
          if (
            event.taskId &&
            event.taskId === taskRef.current &&
            ['agent.event', 'chat.turn', 'chat.thread', 'conversation.entry'].includes(event.type)
          )
            dispatch({ type: 'events', events: [event] });
          if (event.type === 'chat.catalog') void client.readCatalog().then(setCatalog, () => {});
          if (['task.created', 'task.updated', 'task.removed', 'chat.thread'].includes(event.type))
            void client.listThreads().then(
              (listed) => setThreads({ list: listed.threads, complete: listed.complete }),
              () => {},
            );
        });
      } catch (failure) {
        say(failure);
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [client, say, props.env, props.cwd]);

  // The spinner turns only while a reply runs and motion is allowed.
  useEffect(() => {
    if (animation !== 'full' || !running) return;
    const timer = setInterval(() => setFrame((value) => value + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [animation, running]);

  // A reopened thread reads each finished turn's stored events once, before its rows print.
  const openThread = useCallback(
    async (id: string) => {
      setTaskId(id);
      taskRef.current = id;
      setReady(false);
      setView('thread');
      dispatch({ type: 'reset', taskId: id });
      const read = await client.readThread(id);
      dispatch({ type: 'loaded', read });
      const loaded = reduceThread(initialThreadState(id), { type: 'loaded', read });
      for (const turnId of historyWanted(loaded)) {
        const events = [];
        let after: string | undefined;
        try {
          for (let page = 0; page < 20; page++) {
            const turn = await client.readTurnEvents(id, turnId, after);
            events.push(...turn.events);
            if (!turn.nextAfterCursor) break;
            after = turn.nextAfterCursor;
          }
          dispatch({ type: 'history', turnId, events });
        } catch {
          dispatch({ type: 'history-note', turnId, note: 'This turn could not be read.' });
        }
      }
      if (taskRef.current === id) setReady(true);
    },
    [client],
  );

  // Changes, and CI every thirty seconds while the branch is pushed and the view is open.
  useEffect(() => {
    if (view !== 'changes' || !taskId) return;
    void client.readChanges(taskId).then(setChanges, say);
    const branch = thread?.lastPush?.branch;
    if (!branch) return;
    const poll = () => void client.readBranchStatus(taskId, branch).then(setBranchStatus, () => {});
    poll();
    const timer = setInterval(poll, 30_000);
    return () => clearInterval(timer);
  }, [client, view, taskId, thread?.lastPush?.branch, say]);

  // Mentions come from the controller as the person types after an at sign.
  const projectId = projectIndex === null ? null : (projects[projectIndex]?.id ?? null);
  const mentionText = mentionQuery(composer)?.query ?? null;
  useEffect(() => {
    if (mentionText === null || /^[/~]/.test(mentionText)) return;
    let current = true;
    void client.completeMention(taskId, null, mentionText, 8).then(
      (found) => current && setComposer((value) => offerMentions(value, found)),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [client, mentionText, taskId]);

  const selectionFor = (family?: ChatFamily): ChatModelSelection => {
    if (!catalog) throw new Error('Providers are still being read.');
    if (family) {
      const entry = catalog.families.find((value) => value.family === family);
      if (!entry?.connected) throw new Error(`${familyNames[family]} is not connected.`);
      const chosen = familyModel(entry, store);
      const model = entry.models.find((value) => value.model === chosen) ?? entry.models[0];
      if (!model) throw new Error(`${familyNames[family]} lists no model.`);
      return { family, model: model.model, effort: model.defaultEffort };
    }
    return thread?.selection ?? chooseSelection(catalog, undefined, settings.selection, now());
  };

  async function send(raw: string) {
    const { text, paths } = attachmentPaths(raw, homedir());
    if (text.trim() === '' && paths.length === 0) return;
    let id = taskId;
    const selection = selectionFor();
    if (!id) {
      if (!projectId) {
        setView('threads');
        throw new Error(
          projects.length
            ? 'Which project is this thread for? Pick it with Left and Right, then Esc and send again.'
            : 'Register a project first: crewkite project add <path>.',
        );
      }
      const created = await client.createThread(projectId, text || paths.join(', '));
      id = created.id;
      if (settings.handoffMode !== 'most-left')
        await client.configure({ taskId: id, handoffMode: settings.handoffMode });
      await openThread(id);
      // A setting never grants a permission. The thread starts on Ask each time, and the policy
      // in cli.json is only offered for the person to confirm.
      const offered = settings.permissionPolicy;
      const newThread = id;
      if (offered !== 'ask')
        setConfirm({
          question: `This thread asks before each action. Switch it to ${policyLabels[offered]}? (y/n)`,
          yes: async () => {
            await client.configure({ taskId: newThread, permissionPolicy: offered });
          },
        });
    }
    dispatch({
      type: 'sending',
      pending: { localId: `local-${now()}`, text, files: [], at: new Date(now()).toISOString() },
    });
    const files = [];
    for (const path of paths) files.push(await client.importAttachment(id, path));
    const result = await client.sendMessage({ taskId: id, text, selection, files });
    if (result.next) setNotice(result.next);
  }

  async function slash(text: string): Promise<boolean> {
    const parsed = parseSlash(text);
    if (!parsed) return false;
    const { name, argument } = parsed;
    const needThread = () => {
      if (!taskId) throw new Error('Send a first message to start the thread.');
      return taskId;
    };
    switch (name) {
      case 'new':
        setTaskId(null);
        setReady(false);
        setView('thread');
        setNotice(
          projects.length > 1
            ? `New thread in ${projectIndex === null ? 'a project you pick' : projects[projectIndex]?.name}. Ctrl+T lists threads and projects.`
            : 'New thread.',
        );
        break;
      case 'help':
        setView('help');
        break;
      case 'settings':
        setView('settings');
        break;
      case 'changes':
        needThread();
        setView('changes');
        break;
      case 'crew':
        needThread();
        setView('crew');
        break;
      case 'plan':
        if (!thread?.plan)
          throw new Error('This thread has no plan. A crew with an orchestrator proposes one.');
        setView('plan');
        break;
      case 'model':
      case 'provider': {
        const id = needThread();
        const current = selectionFor();
        let selection: ChatModelSelection;
        if (name === 'provider') {
          const family = ChatFamilySchema.safeParse(argument);
          if (!family.success) {
            const connected = (catalog?.families ?? []).filter((entry) => entry.connected);
            setNotice(
              `Connected: ${connected.map((entry) => entry.family).join(', ')}. Use /provider family.`,
            );
            return true;
          }
          selection = selectionFor(family.data);
        } else {
          const entry = catalog?.families.find((value) => value.family === current.family);
          const models = entry?.models ?? [];
          const [model, effort] = argument.split(':');
          const picked = model
            ? models.find((value) => value.model === model)
            : cycle(models, models.find((value) => value.model === current.model) ?? models[0], 1);
          if (!picked) {
            setNotice(`Models: ${models.map((value) => value.model).join(', ')}`);
            return true;
          }
          selection = {
            family: current.family,
            model: picked.model,
            effort: picked.efforts.find((value) => value === effort) ?? picked.defaultEffort,
          };
        }
        await client.configure({ taskId: id, selection });
        setNotice(`Next message: ${familyNames[selection.family]} ${selection.model}.`);
        break;
      }
      case 'handoff': {
        const id = needThread();
        const family = ChatFamilySchema.safeParse(argument);
        if (!family.success) throw new Error('Use /handoff family, such as /handoff local.');
        await client.handoff(id, selectionFor(family.data));
        setNotice(`The next message goes to ${familyNames[family.data]} with the handoff packet.`);
        break;
      }
      case 'ask': {
        const id = needThread();
        if (!argument) throw new Error('Use /ask followed by the question.');
        const current = selectionFor().family;
        const [other] = rankFamilies(
          catalog?.families ?? [],
          [current],
          (entry) => familyModel(entry, store),
          thread?.handoffMode ?? 'most-left',
          now(),
        );
        const family = other?.family ?? current;
        await client.ask(id, family, argument);
        setNotice(`Asked ${familyNames[family]}. The answer posts beside the thread.`);
        break;
      }
      case 'accept':
        acceptFlow(argument);
        break;
      case 'push':
        pushFlow();
        break;
      case 'pr':
        pullRequestFlow();
        break;
      case 'prompt':
        throw new Error('Saved prompts arrive with the composer update of the controller.');
    }
    return true;
  }

  function acceptFlow(branch?: string) {
    const id = taskRef.current;
    if (!id) throw new Error('Start a thread first.');
    const title = threads.list.find((task) => task.id === id)?.title ?? 'changes';
    const accept = async (name: string) => {
      const result = await client.accept(id, name.trim());
      setNotice(
        applied(result)
          ? (result.next ?? `Accepted on ${name}.`)
          : (result.next ?? result.reason ?? 'Accept was refused.'),
      );
      setChanges(await client.readChanges(id));
    };
    if (branch) void accept(branch).catch(say);
    else setLinePrompt({ label: 'New branch', value: `crewkite/${slug(title)}`, submit: accept });
  }

  function pushFlow() {
    const id = taskRef.current;
    const branch = thread?.lastAcceptance?.branch;
    if (!id || !branch) throw new Error('Accept the changes on a branch first.');
    setConfirm({
      question: `Push ${branch} to origin with your own git credentials? (y/n)`,
      yes: async () => {
        const result = await client.push(id, branch);
        setNotice(
          applied(result)
            ? `Pushed ${branch}.`
            : [result.reason, result.next].filter(Boolean).join(' '),
        );
      },
    });
  }

  function pullRequestFlow() {
    const id = taskRef.current;
    const branch = thread?.lastPush?.branch;
    if (!id || !branch) throw new Error('Push the branch first.');
    const title = threads.list.find((task) => task.id === id)?.title ?? branch;
    setLinePrompt({
      label: 'Pull request title',
      value: title,
      submit: async (value) => {
        const result = await client.openPullRequest(id, branch, value.trim() || branch);
        const url = (result.data as { url?: string } | undefined)?.url;
        setNotice(
          applied(result)
            ? (url ?? 'Pull request opened.')
            : (result.next ?? result.reason ?? 'The pull request was not opened.'),
        );
      },
    });
  }

  const tryWith = useCallback(
    (turnId: string) => {
      if (!catalog) return [];
      const mimeTypes = turnFiles(state, turnId).map((file) => file.mimeType);
      return tryWithChoices(
        catalog,
        triedFamilies(state, turnId),
        mimeTypes,
        thread?.handoffMode ?? 'most-left',
        (entry) => familyModel(entry, store),
        now(),
      )
        .slice(0, 4)
        .map((choice) => ({
          family: choice.family,
          label: choice.label,
          selection: choice.selection,
        }));
    },
    [catalog, state, thread?.handoffMode, store, now],
  );

  const failedTurn = [...items].reverse().find((item) => item.kind === 'failure');
  const openRequest = (() => {
    for (const item of items)
      if (item.kind === 'turn' && !item.turn.ended)
        for (const block of item.turn.blocks)
          if (block.kind === 'permission' && block.choice === null)
            return { turnId: item.turn.id, block };
    return null;
  })();

  const run = (work: () => unknown) => {
    try {
      const result = work();
      if (result instanceof Promise) result.catch(say);
    } catch (failure) {
      say(failure);
    }
  };

  function threadKeys(input: string, key: Key) {
    // Tab moves focus to an open request, and only then do the digit keys answer it.
    if (openRequest && promptFocus) {
      if (key.tab || key.escape) return setPromptFocus(false);
      const option = /^[1-9]$/.test(input) ? openRequest.block.options[Number(input) - 1] : null;
      if (option && taskId) {
        setPromptFocus(false);
        run(() =>
          client.resolvePermission(
            taskId,
            openRequest.turnId,
            openRequest.block.requestId,
            option.id,
          ),
        );
      }
      return;
    }
    if (openRequest && key.tab && !composer.completion) return setPromptFocus(true);
    if (key.meta && taskId) {
      if (input === 'r' && failedTurn?.kind === 'failure')
        return run(() => client.retry({ taskId, turnId: failedTurn.turnId, mode: 'retry' }));
      if (input === 'g') {
        const reply = lastReply(state, items);
        return run(() => {
          if (!reply) throw new Error('Regenerate needs a finished reply.');
          return client.retry({ taskId, turnId: reply, mode: 'regenerate' });
        });
      }
      if (/^[1-4]$/.test(input) && failedTurn?.kind === 'failure') {
        const choice = tryWith(failedTurn.turnId)[Number(input) - 1] as
          | { selection: ChatModelSelection }
          | undefined;
        if (choice)
          return run(() =>
            client.retry({
              taskId,
              turnId: failedTurn.turnId,
              mode: 'retry',
              selection: choice.selection,
            }),
          );
      }
      if (input === 's' && thread?.queued[0])
        return run(() => client.steer(taskId, thread.queued[0].id));
      if (input === 'x' && thread?.queued[0])
        return run(() => client.configure({ taskId, dequeue: thread.queued[0].id }));
      if (input === 't') return setShowThinking((value) => !value);
    }
    if (matches(settings, 'stop', input, key)) {
      if (composer.completion) return setComposer(closeCompletion);
      if (running && taskId) {
        setNotice('Stopping.');
        return run(() => client.stopTurn(taskId, running));
      }
      return;
    }
    if (matches(settings, 'newline', input, key))
      return setComposer((value) => insert(value, '\n'));
    if (matches(settings, 'send', input, key)) {
      if (composer.completion) return setComposer(acceptCompletion);
      if (composer.text.endsWith('\\'))
        return setComposer((value) => insert(backspace(value), '\n'));
      const text = composer.text;
      if (text.trim() === '') return;
      setComposer(sent);
      setNotice(null);
      return run(async () => {
        if (!(await slash(text))) await send(text);
      });
    }
    if (key.tab) return setComposer(acceptCompletion);
    if (key.upArrow) return setComposer((value) => vertical(value, 'up'));
    if (key.downArrow) return setComposer((value) => vertical(value, 'down'));
    if (key.leftArrow) return setComposer((value) => moveCaret(value, 'left'));
    if (key.rightArrow) return setComposer((value) => moveCaret(value, 'right'));
    if (key.home || (key.ctrl && input === 'a'))
      return setComposer((value) => moveCaret(value, 'home'));
    if (key.end || (key.ctrl && input === 'e'))
      return setComposer((value) => moveCaret(value, 'end'));
    if (key.backspace || key.delete) return setComposer(backspace);
    if (key.ctrl || key.meta || input === '') return;
    setComposer((value) => insert(value, input.replace(/\r\n?/g, '\n')));
  }

  function changesKeys(input: string) {
    const id = taskId;
    if (!id) return;
    const files = changes?.files ?? [];
    if (input === 'a') return run(() => acceptFlow());
    if (input === 'p') return run(pushFlow);
    if (input === 'o') return run(pullRequestFlow);
    if (input === 'd' && files[changeIndex]) {
      const path = files[changeIndex].path;
      return setConfirm({
        question: `Put ${path} back the way the base has it? Its changes in the scratch copy go. (y/n)`,
        yes: async () => {
          const result = await client.discard(id, path);
          setNotice(
            applied(result)
              ? `Discarded ${path}.`
              : (result.next ?? result.reason ?? 'Discard was refused.'),
          );
          setChanges(await client.readChanges(id));
        },
      });
    }
  }

  function crewKeys(input: string) {
    const id = taskId;
    if (!id || !thread) return;
    if (/^[1-3]$/.test(input) && catalog) {
      const preset = readCrewPresets(store).find(
        (value) => value.name === crewPresetNames[Number(input) - 1],
      );
      const crew =
        preset &&
        crewFromPreset(preset, catalog, thread.selection, thread.handoffMode, now(), store);
      return run(() => {
        if (!crew) throw new Error('Connect a provider to form a crew.');
        return client.configure({ taskId: id, crew });
      });
    }
    if (input === 'f')
      return run(() =>
        client.configure({
          taskId: id,
          flightMode: cycle(['manual', 'balanced', 'glide'] as const, thread.flightMode, 1),
        }),
      );
    if (input === 'p')
      return run(() =>
        client.configure({
          taskId: id,
          permissionPolicy: cycle(
            Object.keys(policyLabels) as ChatThread['permissionPolicy'][],
            thread.permissionPolicy,
            1,
          ),
        }),
      );
    if (input === 'h')
      return run(() =>
        client.configure({
          taskId: id,
          handoffMode: cycle(
            Object.keys(handoffLabels) as ChatThread['handoffMode'][],
            thread.handoffMode,
            1,
          ),
        }),
      );
    if (input === 'a')
      return run(() => client.configure({ taskId: id, autoHandoff: !thread.autoHandoff }));
  }

  function planKeys(input: string) {
    const plan = thread?.plan;
    const id = taskId;
    if (!plan || !id) return;
    if (input === 'r') return run(() => client.runPlan({ taskId: id, planId: plan.planId }));
    if (input === 'c' || input === 's') return run(() => client.cancelPlan(id, plan.planId));
    if (/^[1-8]$/.test(input))
      return run(() => client.runPlan({ taskId: id, planId: plan.planId, sliceId: Number(input) }));
  }

  function settingsKeys(input: string, key: Key) {
    if (key.upArrow) return setSettingsField((value) => Math.max(0, value - 1));
    if (key.downArrow)
      return setSettingsField((value) => Math.min(settingsFields.length - 1, value + 1));
    const field = settingsFields[settingsField];
    if (key.leftArrow || key.rightArrow) {
      const step = key.rightArrow ? 1 : -1;
      return run(() => {
        if (field === 'theme')
          save({
            ...settings,
            theme: cycle(['system', 'dark', 'light'] as const, settings.theme, step),
          });
        if (field === 'animation')
          save({
            ...settings,
            animation: cycle(['full', 'reduced', 'off'] as const, settings.animation, step),
          });
        if (field === 'permissionPolicy')
          save({
            ...settings,
            permissionPolicy: cycle(
              Object.keys(policyLabels) as CliSettings['permissionPolicy'][],
              settings.permissionPolicy,
              step,
            ),
          });
        if (field === 'handoffMode')
          save({
            ...settings,
            handoffMode: cycle(
              Object.keys(handoffLabels) as CliSettings['handoffMode'][],
              settings.handoffMode,
              step,
            ),
          });
        if (field === 'selection') {
          const options = (catalog?.families ?? [])
            .filter((entry) => entry.connected)
            .flatMap((entry) =>
              entry.models.map((model) => ({
                family: entry.family,
                model: model.model,
                effort: model.defaultEffort,
              })),
            );
          const current = options.findIndex(
            (value) =>
              value.family === settings.selection?.family &&
              value.model === settings.selection?.model,
          );
          const next = current + step;
          save({
            ...settings,
            selection: next < 0 || next >= options.length ? null : options[next],
          });
        }
      });
    }
    if (input === 'm' && field === 'selection' && settings.selection) {
      const { family, model } = settings.selection;
      return run(() =>
        save({ ...settings, familyModels: { ...settings.familyModels, [family]: model } }),
      );
    }
    if (input === 'c') {
      const family = settings.selection?.family;
      if (!family)
        return setNotice('Pick the model new threads start on first. C checks that provider.');
      return run(async () => {
        // The Google terms gate runs before any Google connection the CLI starts.
        if (family === 'google' && !(await beforeGoogleConnection()))
          throw new Error('Google stays unconnected until its terms are acknowledged.');
        const result = await client.send(
          family === 'anthropic' ? 'CheckNativeConnection' : 'ObserveUsage',
          family === 'anthropic' ? { family, consent: 'explicit' } : { family },
        );
        setNotice(
          applied(result)
            ? `${familyNames[family]} check finished.`
            : (result.next ?? result.reason ?? 'The check did not run.'),
        );
        setCatalog(await client.readCatalog());
      });
    }
  }

  useInput((input, key) => {
    if (confirm) {
      if (input === 'y' || input === 'Y') {
        setConfirm(null);
        run(confirm.yes);
      } else if (input === 'n' || input === 'N' || key.escape || (key.ctrl && input === 'c'))
        setConfirm(null);
      return;
    }
    if (key.ctrl && input === 'c') {
      setLinePrompt(null);
      if (running)
        return setConfirm({
          question:
            'A reply is running. Leave CrewKite? The reply keeps running in the controller. (y/n)',
          yes: () => app.exit(),
        });
      return app.exit();
    }
    if (linePrompt) {
      if (key.escape) return setLinePrompt(null);
      if (key.return) {
        const submit = linePrompt.submit;
        const value = linePrompt.value;
        setLinePrompt(null);
        return run(() => submit(value));
      }
      if (key.backspace || key.delete)
        return setLinePrompt({
          ...linePrompt,
          value: Array.from(linePrompt.value).slice(0, -1).join(''),
        });
      if (!key.ctrl && !key.meta && input)
        setLinePrompt({ ...linePrompt, value: linePrompt.value + input.replace(/[\r\n]/g, '') });
      return;
    }
    if (matches(settings, 'threads', input, key)) return setView('threads');
    if (matches(settings, 'changes', input, key)) return taskId ? setView('changes') : undefined;
    if (matches(settings, 'settings', input, key)) return setView('settings');
    if (matches(settings, 'help', input, key)) return setView('help');
    if (view !== 'thread' && key.escape) return setView('thread');
    switch (view) {
      case 'thread':
        return threadKeys(input, key);
      case 'threads':
        if (key.upArrow) return setThreadIndex((value) => Math.max(0, value - 1));
        if (key.downArrow)
          return setThreadIndex((value) => Math.min(threads.list.length - 1, value + 1));
        if (key.leftArrow || key.rightArrow)
          return setProjectIndex((value) =>
            value === null
              ? 0
              : (value + (key.rightArrow ? 1 : projects.length - 1)) % Math.max(1, projects.length),
          );
        if (key.return && threads.list[threadIndex])
          return run(() => openThread(threads.list[threadIndex].id));
        if (input === 'n') return run(() => slash('/new'));
        return;
      case 'changes':
        if (key.upArrow) return setChangeIndex((value) => Math.max(0, value - 1));
        if (key.downArrow)
          return setChangeIndex((value) => Math.min((changes?.files.length ?? 1) - 1, value + 1));
        return changesKeys(input);
      case 'crew':
        return crewKeys(input);
      case 'plan':
        return planKeys(input);
      case 'settings':
        return settingsKeys(input, key);
      default:
        return;
    }
  });

  usePaste((text) => {
    if (linePrompt)
      setLinePrompt({ ...linePrompt, value: linePrompt.value + text.replace(/[\r\n]/g, ' ') });
    else if (view === 'thread' && !confirm)
      setComposer((value) => insert(value, text.replace(/\r\n?/g, '\n')));
  });

  // Settled rows print once above the live area, the way a terminal keeps its scrollback.
  const settled = items.slice(0, settledPrefix(items));
  for (const item of settled)
    if (!printedKeys.current.has(`${taskId}:${item.key}`)) {
      printedKeys.current.add(`${taskId}:${item.key}`);
      printed.current.push({
        key: `${taskId}:${item.key}`,
        node: h(ThreadRows, {
          items: [item],
          thread: null,
          colors,
          width,
          frame: 0,
          animation,
          showThinking,
          tryWith,
        }),
      });
    }
  const live = items.slice(settledPrefix(items));
  const header: Printed = { key: 'wordmark', node: h(Wordmark, { columns, colors }) };
  const selection = (() => {
    try {
      return catalog ? selectionFor() : null;
    } catch {
      return null;
    }
  })();
  const project = projectIndex === null ? undefined : projects[projectIndex];

  const body = (() => {
    switch (view) {
      case 'threads':
        return h(
          Box,
          { flexDirection: 'column' },
          h(ThreadListView, {
            threads: threads.list,
            selected: threadIndex,
            colors,
            complete: threads.complete,
          }),
          projects.length > 0
            ? h(
                Text,
                { color: colors.muted },
                `New threads go to ${project?.name ?? 'a project you pick'}. Left and Right change it.`,
              )
            : null,
        );
      case 'changes':
        return h(ChangesView, {
          changes,
          selected: changeIndex,
          thread,
          status: branchStatus,
          message: null,
          colors,
          width,
        });
      case 'crew':
        return thread ? h(CrewView, { thread, colors }) : h(Text, null, 'Start a thread first.');
      case 'plan':
        return thread?.plan
          ? h(PlanCardView, { plan: thread.plan, flight: thread.flightMode, colors })
          : h(Text, null, 'No plan.');
      case 'settings':
        return h(SettingsView, {
          catalog,
          settings,
          field: settingsField,
          status: null,
          nowMs: now(),
          colors,
        });
      case 'help':
        return h(HelpView, { settings, colors });
      default:
        return h(ThreadRows, {
          promptFocus,
          items: live,
          thread,
          colors,
          width,
          frame,
          animation,
          showThinking,
          tryWith,
        });
    }
  })();

  return h(
    Box,
    { flexDirection: 'column' },
    // Static takes its render function as the child, which createElement types as a node.
    h(
      Static<Printed>,
      { items: [header, ...printed.current] } as Parameters<typeof Static<Printed>>[0],
      ((entry: Printed) =>
        h(Box, { key: entry.key, marginBottom: 1 }, entry.node)) as unknown as ReactNode,
    ),
    body,
    notice ? h(Text, { color: colors.amber }, safeText(notice)) : null,
    confirm ? h(Text, { color: colors.amber, bold: true }, confirm.question) : null,
    linePrompt
      ? h(
          Text,
          null,
          `${linePrompt.label}: `,
          h(Text, { inverse: true }, `${safeText(linePrompt.value)} `),
        )
      : null,
    view === 'thread'
      ? h(ComposerView, {
          composer,
          colors,
          focused: !confirm && !linePrompt,
          placeholder: taskId
            ? 'Message, /command or @file'
            : 'Ask about this project or describe a change',
          attachments: attachmentPaths(composer.text, homedir()).paths,
          model: [
            selection
              ? h(
                  Text,
                  { key: 'model' },
                  FamilyMark({ family: selection.family, colors }),
                  h(Text, { color: colors.muted }, ` ${selection.model} ${selection.effort}`),
                )
              : h(Text, { key: 'model', color: colors.muted }, 'No provider connected'),
            thread
              ? h(
                  Text,
                  { key: 'flight', color: colors.muted },
                  `${thread.flightMode} · ${policyLabels[thread.permissionPolicy]}`,
                )
              : project
                ? h(Text, { key: 'project', color: colors.muted }, `project ${project.name}`)
                : null,
            h(Text, { key: 'keys', color: colors.muted }, 'Ctrl+K keys'),
          ],
        })
      : null,
    h(UsageLine, { catalog, nowMs: now(), colors }),
  );
}
