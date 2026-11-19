import { foldersOf, rankMentions } from '@crewkite/client';
import {
  type ChatCatalogRead,
  type CommandResult,
  type ConnectionsRead,
  canonicalJson,
  type Event,
  PROJECT_NOTES_BYTES,
  type ProjectPageRequest,
  type Task,
  type TaskPageRequest,
  type WorkspaceStamp,
  webhookUrl,
} from '@crewkite/contracts';
import { CREWKITE_VERSION } from '@crewkite/contracts/version';
import { createDemoFixtures, createTestIds, DEMO_TIME } from '@crewkite/testkit';
import { externalLink } from '../shared/external-link.ts';
import { designPreview } from './design/preview-design.ts';
import { recipesPreview } from './recipes/preview-recipes.ts';
import { connectionsPreview } from './settings/preview-connections.ts';
import { settingsPreview } from './settings/preview-data.ts';
import {
  providerCatalog,
  providerFacts,
  rulesPreview,
  setupNotes,
  setupThread,
} from './settings/preview-states.ts';
import type { DesktopCommand, DesktopSource } from './source.ts';
import { acceptPreview } from './thread/preview-accept.ts';
import { githubPreview } from './thread/preview-github.ts';
import { createThreadScript } from './thread/preview-script.ts';
import { workPreview } from './thread/preview-work.ts';

export function createPreviewSource(): DesktopSource {
  const fixtures = createDemoFixtures();
  const state = structuredClone(fixtures.snapshot);
  state.tasks = [structuredClone(fixtures.task)];
  const { localHardware, ...providers } = settingsPreview(state.routes, DEMO_TIME);
  Object.assign(state, providers);
  // A named state, such as ?preview=1&state=provider-stale, changes the facts it is named for.
  const named = new URLSearchParams(window.location.search).get('state');
  Object.assign(state, providerFacts(named, state, DEMO_TIME));
  const id = createTestIds(DEMO_TIME, 1000n);
  const listeners = new Set<(event: Event) => void>();
  let cursor = 0n;
  function emit(type: Event['type'] | string, payload: unknown, task: Task) {
    cursor += 1n;
    state.cursor = cursor.toString();
    const event = {
      protocol: 1,
      id: id('evt'),
      cursor: state.cursor,
      at: DEMO_TIME,
      taskId: task.id,
      revision: task.revision,
      type,
      // A thread event may build its payload from the cursor it is given.
      payload: typeof payload === 'function' ? payload(state.cursor) : payload,
    } as Event;
    for (const listener of listeners) listener(structuredClone(event));
    return state.cursor;
  }
  const chatCommands = new Set([
    'ReadChatThread',
    'ReadChatChanges',
    'ReadChatCatalog',
    'SendChatMessage',
    'ResolveChatPermission',
    'StopChatTurn',
    'ConfigureChatThread',
    'HandoffChatThread',
    'AcceptChatChanges',
    'PushChatBranch',
    'OpenChatPullRequest',
    'ReadChatBranchStatus',
    'SteerChatMessage',
  ]);
  // The composer commands answer from a small scripted project and an in-memory prompt list.
  const sampleFiles = ['net.mjs', 'test/net.test.mjs', 'docs/usage.md', 'AGENTS.md'];
  const sampleEntries = [
    ...sampleFiles.map((path) => ({ path, kind: 'file' as const })),
    ...foldersOf(sampleFiles).map((path) => ({ path, kind: 'folder' as const })),
  ];
  const prompts = new Map<string, string>();
  const promptList = () => ({
    kind: 'chat-prompts',
    prompts: [...prompts]
      .map(([name, body]) => ({ name, body }))
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
  });
  const notes = new Map<string, { id: string; text: string; createdAt: string }[]>([
    [
      fixtures.task.projectId,
      setupNotes(named).map((text, index) => ({
        id: `not_${String(index + 1).padStart(26, '0')}`,
        text,
        createdAt: new Date(0).toISOString(),
      })),
    ],
  ]);
  const noteList = (projectId: string) => {
    const rows = notes.get(projectId) ?? [];
    return {
      kind: 'project-notes',
      projectId,
      projectName: state.projects.find(({ id }) => id === projectId)?.name ?? 'Project',
      notes: rows,
      bytes: rows.reduce((total, row) => total + row.text.length + 3, 0),
      capBytes: PROJECT_NOTES_BYTES,
    };
  };
  function noteCommand(name: string, payload: Record<string, unknown>): CommandResult | null {
    if (
      !['ReadProjectNotes', 'AddProjectNote', 'EditProjectNote', 'RemoveProjectNote'].includes(name)
    )
      return null;
    const projectId = String(payload.projectId);
    const rows = notes.get(projectId) ?? [];
    if (name === 'AddProjectNote')
      rows.push({
        id: `not_${String(rows.length + 1).padStart(26, '0')}`,
        text: String(payload.text),
        createdAt: new Date(0).toISOString(),
      });
    if (name === 'EditProjectNote')
      for (const row of rows) if (row.id === payload.noteId) row.text = String(payload.text);
    if (name === 'RemoveProjectNote')
      notes.set(
        projectId,
        rows.filter((row) => row.id !== payload.noteId),
      );
    else notes.set(projectId, rows);
    const now = noteList(projectId);
    // A read answers with the list. A change answers with the small record the controller sends.
    return {
      outcome: 'applied',
      data:
        name === 'ReadProjectNotes'
          ? now
          : { kind: 'project-notes-changed', projectId, bytes: now.bytes },
    } as CommandResult;
  }
  // Saved crews answer from memory with the whole list, as the controller does.
  let crews = {
    crews: [] as { id: string }[],
    defaultCrew: 'preset:Solo',
    imported: true,
  };
  function crewCommand(name: string, payload: Record<string, unknown>): CommandResult | null {
    if (name === 'SaveCrew') {
      const crew = payload.crew as { id: string };
      crews = {
        ...crews,
        crews: crews.crews.some(({ id }) => id === crew.id)
          ? crews.crews.map((value) => (value.id === crew.id ? crew : value))
          : [...crews.crews, crew],
      };
    } else if (name === 'DeleteCrew')
      crews = {
        ...crews,
        crews: crews.crews.filter(({ id }) => id !== payload.id),
        defaultCrew:
          crews.defaultCrew === `saved:${payload.id}` ? 'preset:Solo' : crews.defaultCrew,
      };
    else if (name === 'SetDefaultCrew') crews = { ...crews, defaultCrew: String(payload.id) };
    else if (name !== 'ReadSavedCrews' && name !== 'ImportSavedCrews') return null;
    return {
      outcome: 'applied',
      data: { kind: 'saved-crews', ...structuredClone(crews) },
    } as CommandResult;
  }
  function composerCommand(name: string, payload: Record<string, unknown>): CommandResult | null {
    const applied = (data: unknown) => ({ outcome: 'applied', data }) as CommandResult;
    const noted = noteCommand(name, payload);
    if (noted) return noted;
    const crewed = crewCommand(name, payload);
    if (crewed) return crewed;
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : fixtures.task.id;
    if (name === 'CompleteChatMention')
      return applied({
        kind: 'chat-mentions',
        taskId,
        mentions: rankMentions(
          sampleEntries,
          String(payload.query ?? ''),
          Number(payload.limit ?? 8),
        ),
      });
    if (name === 'ReadChatInstructions') {
      const wanted = payload.name === 'AGENTS.md';
      return applied({
        kind: 'chat-instructions',
        taskId,
        files: ['AGENTS.md'],
        name: wanted ? 'AGENTS.md' : null,
        text: wanted ? 'Keep changes small and run the tests.\n' : null,
        truncated: false,
      });
    }
    if (name === 'ReadChatPrompts') return applied(promptList());
    if (name === 'SaveChatPrompt') {
      prompts.set(String(payload.name), String(payload.body));
      return applied(promptList());
    }
    if (name === 'DeleteChatPrompt') {
      prompts.delete(String(payload.name));
      return applied(promptList());
    }
    return null;
  }
  // A named state, such as ?preview=1&state=findings, sets up the design system and its findings.
  const design = designPreview(
    new URLSearchParams(window.location.search).get('state'),
    fixtures.task.projectId,
    fixtures.task.id,
  );
  // ?preview=1&state=api-spend puts two API connections on the rail: one whose turns reported no
  // cost, and one with a reported cost whose sign-in changed. The connections- states start the
  // Settings card and the Crew tab's API billing, and every other preview has none.
  const connections = connectionsPreview(
    named,
    DEMO_TIME,
    named === 'api-spend' ? apiSpendPreview() : null,
  );
  const scripts = new Map<string, ReturnType<typeof createThreadScript>>();
  // A gh- state, such as ?preview=1&state=gh-open, starts the demo thread accepted and pushed and
  // answers the GitHub writes, CI and review comments of the Changes tab.
  const github = githubPreview(
    new URLSearchParams(window.location.search).get('state'),
    fixtures.task.id,
    {
      publish: (type, payload) => emit(type, payload, fixtures.task),
      patch: (thread) => scripts.get(fixtures.task.id)?.patch(thread),
    },
  );
  // A recipes- state, such as ?preview=1&state=recipes-schedule, answers the Recipes page.
  const recipes = recipesPreview(
    new URLSearchParams(window.location.search).get('state'),
    fixtures.task.projectId,
    fixtures.task.id,
  );
  // A work- state, such as ?preview=1&state=work-running, starts the demo thread on a plan in
  // that state and answers the records the Work tab reads beside it.
  const work = workPreview(
    new URLSearchParams(window.location.search).get('state'),
    fixtures.task.id,
  );
  // An accept- state answers Accept with required checks, and rules- the writing rules export.
  const accept = acceptPreview(named, fixtures.task.id);
  const rules = rulesPreview(named);
  const setup = setupThread(named);
  function chatCommand(name: string, payload: Record<string, unknown>): CommandResult | null {
    if (!chatCommands.has(name)) return null;
    // The catalog read has no task, and the scripted thread answers it for the demo task.
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : fixtures.task.id;
    const task = state.tasks.find(({ id }) => id === taskId);
    if (!task) return { outcome: 'blocked', reason: 'The preview task could not be found.' };
    let script = scripts.get(taskId);
    if (!script) {
      script = createThreadScript(
        {
          publish: (type, value) => emit(type, value, task),
          advance(to) {
            if (cursor < to) {
              cursor = to;
              state.cursor = to.toString();
            }
          },
          cursor: () => state.cursor,
        },
        taskId,
        taskId === fixtures.task.id,
      );
      scripts.set(taskId, script);
      if (taskId === fixtures.task.id && github.thread) script.patch(github.thread);
      if (taskId === fixtures.task.id && work.thread) script.patch(work.thread);
      if (taskId === fixtures.task.id && accept.thread) script.patch(accept.thread);
      if (taskId === fixtures.task.id && connections.thread) script.patch(connections.thread);
      if (taskId === fixtures.task.id && setup) script.patch(setup);
    }
    return script.command(name, payload);
  }
  let webhookAddress: string | null = null;
  async function command(input: DesktopCommand): Promise<CommandResult> {
    const designed = design.command(
      (input as { command: string }).command,
      input.payload as Record<string, unknown>,
    );
    if (designed) return designed;
    const recipe = recipes.command(
      (input as { command: string }).command,
      input.payload as Record<string, unknown>,
    );
    if (recipe) return recipe;
    const githubAnswer = github.command(
      (input as { command: string }).command,
      input.payload as Record<string, unknown>,
    );
    if (githubAnswer) return githubAnswer;
    const workAnswer = work.command(
      (input as { command: string }).command,
      input.payload as Record<string, unknown>,
    );
    if (workAnswer) return workAnswer;
    const name = (input as { command: string }).command;
    const answered =
      accept.command(name, input.payload as Record<string, unknown>) ??
      rules(name, input.payload as Record<string, unknown>);
    if (answered) return answered;
    const composer = composerCommand(
      (input as { command: string }).command,
      input.payload as Record<string, unknown>,
    );
    if (composer) return composer;
    const chat = chatCommand(
      (input as { command: string }).command,
      input.payload as Record<string, unknown>,
    );
    if (chat) {
      // The style files a design finding points at show in Changes beside the scripted edit.
      const extra = input.command === 'ReadChatChanges' ? design.changes() : [];
      const read = chat.data as { files?: unknown[]; total?: number } | undefined;
      if (extra.length && read?.files) {
        read.files.push(...extra);
        read.total = read.files.length;
      }
      const catalog = chat.data as ChatCatalogRead | undefined;
      if (input.command === 'ReadChatCatalog' && catalog)
        catalog.families = providerCatalog(named, catalog.families);
      return chat;
    }
    const connected = connections.command(name, input.payload as Record<string, unknown>);
    if (connected) return connected;
    switch (input.command) {
      case 'CreateTask': {
        const created: Task = {
          ...input.payload,
          id: id('tsk'),
          state: 'draft',
          waitingReason: null,
          revision: 0,
          runId: null,
          next: 'Prepare the run.',
        };
        state.tasks.push(created);
        emit('task.created', created, created);
        return { outcome: 'applied', entity: created, revision: created.revision };
      }
      case 'ReadWebhook':
        return { outcome: 'applied', data: { kind: 'webhook', url: webhookAddress } };
      case 'SetWebhook': {
        const url = String(input.payload.url ?? '').trim();
        const checked = url === '' ? '' : webhookUrl(url);
        if (checked === null)
          return {
            outcome: 'blocked',
            reason: 'webhook-address-invalid',
            next: 'That address is not allowed. Use https, or http to this computer.',
          };
        webhookAddress = checked || null;
        return { outcome: 'applied' };
      }
      case 'GetSnapshot':
        return { outcome: 'applied', data: { kind: 'snapshot', snapshot: structuredClone(state) } };
      default:
        return {
          outcome: 'unsupported',
          reason: 'This action needs the connected controller.',
          next: 'Open the desktop demo.',
        };
    }
  }
  let projection = '';
  let generation = 0n;
  const currentStamp = (): WorkspaceStamp => {
    const next = canonicalJson({
      projects: state.projects.map(({ id, name }) => ({ id, name })),
      tasks: state.tasks.map(({ id, projectId, title, outcome, criteria }) => ({
        id,
        projectId,
        title,
        outcome,
        criteria,
      })),
    });
    if (next !== projection) {
      projection = next;
      generation += 1n;
    }
    return { epoch: '0'.repeat(32), revision: generation.toString() };
  };
  const workspaceState = async () => ({
    kind: 'workspace-state' as const,
    version: 1 as const,
    protocol: 1 as const,
    stamp: currentStamp(),
    cursor: state.cursor,
    routes: state.routes,
    usage: state.usage,
    usageReaders: state.usageReaders,
    nativeProfiles: state.nativeProfiles,
    googleAcpSetup: state.googleAcpSetup,
    googleAcpInstall: state.googleAcpInstall,
    googleMetadataHolds: state.googleMetadataHolds,
    nativeConnections: state.nativeConnections,
    localSetup: state.localSetup,
    localHardware,
  });
  const projectPage = async (input: Omit<ProjectPageRequest, 'limit'> & { limit?: number }) => ({
    kind: 'project-page' as const,
    version: 1 as const,
    stamp: currentStamp(),
    cursor: state.cursor,
    projects: state.projects
      .filter((project) => !input.projectId || project.id === input.projectId)
      .map((project) => ({
        ...project,
        taskCount: state.tasks.filter((task) => task.projectId === project.id).length,
      })),
    next: null,
    complete: true,
  });
  const taskPage = async (input: Omit<TaskPageRequest, 'limit'> & { limit?: number }) => {
    const query = input.query?.trim();
    const pattern = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'iu') : null;
    const tasks = state.tasks
      .filter(
        (task) =>
          (!input.projectId || task.projectId === input.projectId) &&
          (!input.taskId || task.id === input.taskId),
      )
      .flatMap((task) => {
        const fields = [
          task.title,
          state.projects.find((project) => project.id === task.projectId)?.name ?? '',
          task.outcome,
          ...task.criteria,
          task.id,
          task.projectId,
        ];
        if (pattern && !fields.some((text) => pattern.test(text))) return [];
        const { id, projectId, title, state: status, waitingReason, revision, runId, next } = task;
        return [
          {
            id,
            projectId,
            title,
            state: status,
            waitingReason,
            revision,
            runId,
            next,
            chatActivity: 'idle' as const,
          },
        ];
      });
    return {
      kind: 'task-page' as const,
      version: 1 as const,
      stamp: currentStamp(),
      cursor: state.cursor,
      tasks,
      next: null,
      complete: true,
      scanned: state.tasks.length,
    };
  };
  return {
    workspaceState,
    projectPage,
    taskPage,
    getSnapshot: async (scope) => {
      if (!scope || !('taskId' in scope) || !scope.taskId)
        throw new Error('Choose a task to read its detail.');
      const detail = structuredClone(state);
      detail.tasks = detail.tasks.filter((task) => task.id === scope.taskId);
      return detail;
    },
    command,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onConnection(listener) {
      listener('connected');
      return () => {};
    },
    // The export as main answers it. The state picks the answer: a save that went through, a
    // dialog that was cancelled, or a write that failed.
    saveResults: async () => {
      if (named === 'recipes-results-cancelled') return 'cancelled';
      if (named === 'recipes-results-failed')
        throw new Error('The file could not be written there. Choose another place.');
      return { records: 43, file: 'crewkite-results.json' };
    },
    // The feedback report as main builds it, from what was written and the lines ticked.
    feedbackDraft: async (draft) => {
      const versions = [
        ...(draft.app ? [`App: ${CREWKITE_VERSION}`] : []),
        ...(draft.os ? ['OS: Darwin 25.1.0 arm64'] : []),
        ...(draft.clients && draft.clientVersions.length
          ? [`Clients: ${draft.clientVersions.join(', ')}`]
          : []),
      ];
      return [
        '## What happened',
        '',
        draft.what.trim() || '(nothing written yet)',
        ...(versions.length ? ['', '## Versions', '', ...versions] : []),
      ].join('\n');
    },
    // The browser preview has no main process, so it opens the checked address itself.
    openLink: async (url) => {
      const target = externalLink(url);
      if (!target) return 'refused';
      window.open(target.href, '_blank', 'noopener,noreferrer');
      return 'opened';
    },
  };
}

function apiSpendPreview(): ConnectionsRead {
  const connection = {
    backend: 'native-client',
    billingMode: 'api',
    keepConnected: true,
    readiness: 'ready',
    proofGeneration: 1,
    observedMode: 'api',
    observedAt: DEMO_TIME,
  } as const;
  const openai = 'con_01KA0000000000000000000001';
  const anthropic = 'con_01KA0000000000000000000002';
  return {
    loginLines: [],
    connections: [
      { ...connection, connectionId: openai, family: 'openai', profileId: 'openai-api' },
      {
        ...connection,
        connectionId: anthropic,
        family: 'anthropic',
        profileId: 'anthropic-api',
        label: 'Team key',
        readiness: 'needs-attention',
        observedMode: 'subscription',
      },
    ],
    assignments: [],
    spend: [
      { connectionId: openai, spend: { reported: null, estimated: null, unreportedTurns: 2 } },
      {
        connectionId: anthropic,
        spend: {
          reported: { amountMicros: 420_000, currency: 'USD' },
          estimated: null,
          unreportedTurns: 0,
        },
      },
    ],
  };
}
