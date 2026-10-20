import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type ControllerClient,
  connectController,
  createCommandKey,
  readControllerEndpoint,
} from '@crewkite/client/node';
import {
  ArtifactSchema,
  type Command,
  type CommandResult,
  CommandSchema,
  ConversationContextRefsSchema,
  type ConversationEntry,
  ConversationModelRequestSchema,
  ConversationPlanningSelectionSchema,
  canonicalJson,
  LocalAuthModeSchema,
  LocalEndpointSchema,
  LocalModelSelectionSchema,
  MAX_FRAME_BYTES,
  NativeHandoffTargetsSchema,
  NativeTargetContextLinesSchema,
  PolicySchema,
  PrepareCombinedRunPayloadSchema,
  ProjectNodeTestFilesSchema,
  ProjectSchema,
  type Snapshot,
  type Task,
  type TaskConversationState,
  TaskSchema,
  type WorkspaceContinuation,
} from '@crewkite/contracts';

const googleAcpLabel =
  'Google’s published ACP agent, signed in with your own Google account. Google documents this agent for editors; CrewKite is not named.';

const help = `Usage: crewkite project add <path> [--json] [--home path]
       crewkite task create <project-id> --title text --outcome text --criterion text [--criterion text ...] [--json] [--home path]
       crewkite task <list|show|watch|start|pause|stop|resume|switch|approve|deny> [id] [--json] [--home path]
       crewkite task list [--pages --json] [--home path]
       crewkite task amend <task-id> --title text --outcome text --criterion text [--criterion text ...] [--json] [--home path]
       crewkite task switch <task-id> <route-id> [--json] [--home path]
       crewkite conversation <create|configure> <id> --role lead|orchestrator --profile openai-file-v1 --credit-policy ordinary|existing-credits --attempts N --minutes N --concurrency N --consent [--text goal]
       crewkite conversation create <project-id> --text goal --role lead|orchestrator --profile openai-file-v1 --credit-policy ordinary|existing-credits --attempts N --minutes N --concurrency N --consent [--context-refs file]
       crewkite conversation configure <task-id> --role lead|orchestrator --profile openai-file-v1 --credit-policy ordinary|existing-credits --attempts N --minutes N --concurrency N --consent [--model-request file]
       crewkite conversation show <task-id> [--before-cursor cursor] [--json] [--home path]
       crewkite conversation <send|guide> <task-id> --text text [--context-refs file] [--json] [--home path]
       crewkite conversation answer <task-id> --question-id message-id --text text [--context-refs file] [--json] [--home path]
       crewkite conversation adopt <task-id> --proposal-id message-id --proposal-hash hash [--json] [--home path]
       crewkite local status [--json] [--home path]
       crewkite local configure --endpoint ws://127.0.0.1:port [--authentication token|none] [--json] [--home path]
       crewkite local <connect|refresh-models> --consent [--json] [--home path]
       crewkite local cancel-input <operation-id> [--json] [--home path]
       crewkite local disconnect [--json] [--home path]
       crewkite local select-model <selection-id> --observation-hash hash [--json] [--home path]
       crewkite combined prepare <parent-task-id> --plan file [--json] [--home path]
       crewkite combined <status|assemble> <parent-task-id> [--json] [--home path]
       crewkite native profiles [--json] [--home path]
       crewkite native import-google --consent [--json] [--home path]
       crewkite native setup <show|initialize|authenticate|discover|stop> --family google [--consent] [--json] [--home path]
       crewkite usage show [--json] [--home path]
       crewkite usage refresh --family google [--json] [--home path]
       crewkite task prepare-native <task-id> <profile-id> <path> --policy file [--native-trust --source-consent] [--existing-credits] [--confirm-subscription-only] [--maximum-task-ms 300000|600000] [--context-lines START:END] [--permission-mode mode] [--handoff-target profile[:existing-credits] ...]
       crewkite task prepare-handoff <task-id> <profile-id> --native-trust --source-consent [--existing-credits] [--confirm-subscription-only] [--permission-mode mode]
       crewkite task start-handoff <task-id> [--json] [--home path]
       crewkite task prepare-repository <task-id> <profile-id> --policy file [--native-trust --source-consent] [--existing-credits]
       crewkite task prepare-evaluation <task-id> <profile-id> --grants file [--recipe node-tests-v1|project-node-tests-v1|crewkite-verify-v1] [--test-file path ...] [--native-trust --source-consent] [--existing-credits]
       crewkite task <start-checks|start-review> <task-id> [--json] [--home path]
       crewkite task accept <task-id> <destination-ref> [--json] [--home path]
       crewkite task changes <task-id> [--json] [--home path]
       crewkite task export <task-id> --output new-file [--json] [--home path]
       crewkite health [--json] [--home path]
       crewkite retry <receipt-file> [--output new-file] [--json] [--home path]

Approval commands take an approval ID. Task creation takes a project ID. Other task commands take a task ID.
Conversation creation takes a project ID and a goal, and can start a counted planning turn under its explicit finite consent. Other conversation commands take a task ID.
Project registration and task create start no work. Native preparation uses explicit consent or the controller's exact saved consent.
For an Anthropic or Google writer, --confirm-subscription-only confirms subscription login and disabled paid extra usage.
File handoff targets are optional and permit only later explicit manual transfers within the original budget.
Handoff preparation requires fresh consent; it starts no writer. Start is a separate command.
Repository work needs an explicit run-native-tools policy grant. It permits local commands during the bounded task.
For Google, --permission-mode must match the existing client setting: request-review, strict, always-proceed or proceed-in-sandbox.
`;
interface Output {
  out: (text: string) => void;
  err: (text: string) => void;
}

const terminalText = (value: string) =>
  value.replace(/\p{Cc}/gu, (character) =>
    ['\n', '\t'].includes(character)
      ? character
      : `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

export async function runCli(
  args: string[],
  output: Output = {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
): Promise<number> {
  let client: ControllerClient | undefined;
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        pages: { type: 'boolean' },
        home: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        text: { type: 'string' },
        role: { type: 'string' },
        profile: { type: 'string' },
        'credit-policy': { type: 'string' },
        'model-request': { type: 'string' },
        'context-refs': { type: 'string' },
        attempts: { type: 'string' },
        minutes: { type: 'string' },
        concurrency: { type: 'string' },
        'before-cursor': { type: 'string' },
        'question-id': { type: 'string' },
        'proposal-id': { type: 'string' },
        'proposal-hash': { type: 'string' },
        title: { type: 'string' },
        outcome: { type: 'string' },
        criterion: { type: 'string', multiple: true },
        policy: { type: 'string' },
        plan: { type: 'string' },
        grants: { type: 'string' },
        recipe: { type: 'string' },
        'test-file': { type: 'string', multiple: true },
        'native-trust': { type: 'boolean' },
        'source-consent': { type: 'boolean' },
        'existing-credits': { type: 'boolean' },
        'confirm-subscription-only': { type: 'boolean' },
        'permission-mode': { type: 'string' },
        'maximum-task-ms': { type: 'string' },
        'context-lines': { type: 'string', multiple: true },
        'handoff-target': { type: 'string', multiple: true },
        output: { type: 'string' },
        endpoint: { type: 'string' },
        authentication: { type: 'string' },
        'observation-hash': { type: 'string' },
        family: { type: 'string' },
        consent: { type: 'boolean' },
        'model-id': { type: 'string' },
        'thought-level-id': { type: 'string' },
        'confirm-quota-account': { type: 'boolean' },
      },
    });
    if (values.help || positionals.length === 0) {
      output.out(help);
      return 0;
    }
    const [area, action, id, ...extra] = positionals;
    if (
      (extra.length &&
        !(
          area === 'task' &&
          ((['switch', 'accept'].includes(action) && extra.length === 1) ||
            (action === 'prepare-native' && extra.length === 2) ||
            (['prepare-evaluation', 'prepare-repository', 'prepare-handoff'].includes(action) &&
              extra.length === 1))
        )) ||
      ![
        'project',
        'task',
        'conversation',
        'combined',
        'local',
        'native',
        'usage',
        'health',
        'retry',
      ].includes(area)
    )
      throw new Error('Unknown command. Use --help.');
    if (values.pages !== undefined && !(area === 'task' && action === 'list' && values.json))
      throw new Error('--pages requires task list --json.');
    const combined = area === 'combined';
    if (combined) {
      if (!['prepare', 'status', 'assemble'].includes(action) || !id)
        throw new Error('Use combined prepare, status or assemble with one parent task ID.');
      const allowed = new Set(['json', 'home', ...(action === 'prepare' ? ['plan'] : [])]);
      if (Object.keys(values).some((key) => !allowed.has(key)))
        throw new Error('This option does not apply to the combined action. Use --help.');
      if (action === 'prepare' && !values.plan)
        throw new Error('Supply the explicit --plan JSON file.');
    } else if (values.plan !== undefined) throw new Error('Plan input requires combined prepare.');
    const combinedPlan =
      combined && action === 'prepare'
        ? PrepareCombinedRunPayloadSchema.parse(readJson(values.plan as string))
        : undefined;
    if (combinedPlan && combinedPlan.taskId !== id)
      throw new Error('The plan must name the same parent task ID.');
    const local = area === 'local';
    if (local) {
      const takesId = action === 'cancel-input' || action === 'select-model';
      if (
        ![
          'status',
          'configure',
          'connect',
          'cancel-input',
          'disconnect',
          'refresh-models',
          'select-model',
        ].includes(action) ||
        (takesId ? !id : id !== undefined)
      )
        throw new Error(
          'Use local status, configure, connect, cancel-input, disconnect, refresh-models or select-model.',
        );
      const allowed = new Set([
        'json',
        'home',
        ...(action === 'configure' ? ['endpoint', 'authentication'] : []),
        ...(['connect', 'refresh-models'].includes(action) ? ['consent'] : []),
        ...(action === 'select-model' ? ['observation-hash'] : []),
      ]);
      if (Object.keys(values).some((key) => !allowed.has(key)))
        throw new Error('This option does not apply to the Local action. Use --help.');
      if (['connect', 'refresh-models'].includes(action) && !values.consent)
        throw new Error('This Local action requires explicit --consent.');
      if (action === 'configure') {
        LocalEndpointSchema.parse(values.endpoint);
        if (values.authentication !== undefined) LocalAuthModeSchema.parse(values.authentication);
      }
      if (action === 'select-model')
        LocalModelSelectionSchema.parse({
          selectionId: id,
          observationHash: values['observation-hash'],
        });
    } else if (
      values.endpoint !== undefined ||
      values.authentication !== undefined ||
      values['observation-hash'] !== undefined
    )
      throw new Error('Endpoint, authentication and observation options require a Local action.');
    const conversation = area === 'conversation';
    const planning = conversation && ['create', 'configure'].includes(action);
    const conversationOptions = [
      'text',
      'role',
      'profile',
      'credit-policy',
      'model-request',
      'context-refs',
      'attempts',
      'minutes',
      'concurrency',
      'before-cursor',
      'question-id',
      'proposal-id',
      'proposal-hash',
    ];
    if (conversation) {
      if (
        !['create', 'show', 'send', 'answer', 'guide', 'adopt', 'configure'].includes(action) ||
        !id
      )
        throw new Error(
          'Use conversation create, show, send, answer, guide, adopt or configure with one ID.',
        );
      const allowed = new Set([
        'json',
        'home',
        ...(planning
          ? ['role', 'profile', 'credit-policy', 'attempts', 'minutes', 'concurrency', 'consent']
          : []),
        ...(['create', 'send', 'answer', 'guide'].includes(action) ? ['text', 'context-refs'] : []),
        ...(action === 'configure' ? ['model-request'] : []),
        ...(action === 'show' ? ['before-cursor'] : []),
        ...(action === 'answer' ? ['question-id'] : []),
        ...(action === 'adopt' ? ['proposal-id', 'proposal-hash'] : []),
      ]);
      if (Object.keys(values).some((key) => !allowed.has(key)))
        throw new Error('This option does not apply to the conversation action. Use --help.');
      if (['create', 'send', 'answer', 'guide'].includes(action) && !values.text?.trim())
        throw new Error('Supply nonblank --text.');
      if (action === 'answer' && !values['question-id'])
        throw new Error('Answer requires --question-id.');
      if (action === 'adopt' && (!values['proposal-id'] || !values['proposal-hash']))
        throw new Error('Adopt requires the exact --proposal-id and --proposal-hash.');
      if (planning && !values.consent) throw new Error('Planning requires explicit --consent.');
    } else if (conversationOptions.some((key) => values[key as keyof typeof values] !== undefined))
      throw new Error('Conversation options require a conversation action.');
    const contextRefs =
      values['context-refs'] !== undefined
        ? ConversationContextRefsSchema.parse(readJson(values['context-refs']))
        : undefined;
    const planningSelection = planning
      ? ConversationPlanningSelectionSchema.parse({
          role: values.role,
          profileId: values.profile,
          creditPolicy: values['credit-policy'],
          limits: Object.fromEntries(
            ['attempts', 'minutes', 'concurrency'].map((key) => {
              const value = values[key as 'attempts' | 'minutes' | 'concurrency'];
              if (!value || !/^[1-9][0-9]*$/.test(value))
                throw new Error(
                  'Supply finite positive integer --attempts, --minutes and --concurrency.',
                );
              return [key, Number(value)];
            }),
          ),
          consent: 'explicit',
          ...(values['model-request'] !== undefined
            ? {
                modelRequest: ConversationModelRequestSchema.parse(
                  readJson(values['model-request']),
                ),
              }
            : {}),
        })
      : undefined;
    const supported = [
      'create',
      'amend',
      'pause',
      'list',
      'show',
      'watch',
      'start',
      'stop',
      'resume',
      'switch',
      'accept',
      'approve',
      'deny',
      'prepare-native',
      'prepare-repository',
      'prepare-handoff',
      'start-handoff',
      'prepare-evaluation',
      'start-checks',
      'start-review',
      'changes',
      'export',
    ];
    if (
      area === 'task' &&
      (!action ||
        !supported.includes(action) ||
        (['switch', 'accept'].includes(action) && extra.length !== 1) ||
        (action === 'prepare-native' && extra.length !== 2) ||
        (['prepare-evaluation', 'prepare-repository', 'prepare-handoff'].includes(action) &&
          extra.length !== 1) ||
        (action === 'list' ? id !== undefined : id === undefined))
    )
      throw new Error('Invalid task command. Use --help.');
    if (area === 'project' && (action !== 'add' || id === undefined))
      throw new Error('Use project add with one repository path.');
    const creatingTask = area === 'task' && action === 'create';
    const amendingTask = area === 'task' && action === 'amend';
    if (amendingTask || (area === 'task' && action === 'pause')) {
      const allowed = new Set([
        'json',
        'home',
        ...(amendingTask ? ['title', 'outcome', 'criterion'] : []),
      ]);
      if (Object.keys(values).some((key) => !allowed.has(key)))
        throw new Error('This option does not apply to the task action. Use --help.');
    }
    const addingProject = area === 'project' && action === 'add';
    if (
      !creatingTask &&
      !amendingTask &&
      (values.title !== undefined || values.outcome !== undefined || values.criterion !== undefined)
    )
      throw new Error('Title, outcome and criteria require task create or amend.');
    if (
      (creatingTask || amendingTask) &&
      (!values.title?.trim() ||
        !values.outcome?.trim() ||
        !values.criterion?.length ||
        values.criterion.some((criterion) => !criterion.trim()))
    )
      throw new Error(
        'Task create and amend require a title, outcome and at least one nonblank criterion.',
      );
    if (addingProject && !id?.trim()) throw new Error('Supply a nonblank repository path.');
    if (area === 'health' && action !== undefined)
      throw new Error('Health takes no positional arguments.');
    if (area === 'retry' && (!action || id !== undefined))
      throw new Error('Retry takes one receipt file.');
    const settingUpGoogle = area === 'native' && action === 'setup';
    const importingGoogle = area === 'native' && action === 'import-google';
    if (
      area === 'native' &&
      !(
        (action === 'profiles' && id === undefined) ||
        (importingGoogle && id === undefined) ||
        (settingUpGoogle &&
          ['show', 'initialize', 'authenticate', 'discover', 'stop'].includes(id ?? ''))
      )
    )
      throw new Error('Use native profiles, import-google or setup.');
    if (
      settingUpGoogle &&
      (values.family !== 'google' || (['show', 'stop'].includes(id ?? '') && values.consent))
    )
      throw new Error(
        'Use native setup with --family google. Consent applies only to initialize, authenticate or discover.',
      );
    if (
      ((settingUpGoogle && !['show', 'stop'].includes(id ?? '')) || importingGoogle) &&
      !values.consent
    )
      throw new Error('This action requires explicit --consent.');
    const refreshingUsage = area === 'usage' && action === 'refresh';
    if (area === 'usage' && (!['show', 'refresh'].includes(action) || id !== undefined))
      throw new Error('Use usage show or usage refresh --family google.');
    if (
      !refreshingUsage &&
      !settingUpGoogle &&
      !importingGoogle &&
      !planning &&
      !local &&
      (values.family !== undefined || values.consent !== undefined)
    )
      throw new Error('Family and consent options do not apply to this command.');
    if (refreshingUsage && values.family !== 'google')
      throw new Error('Quota refresh requires --family google.');
    if (refreshingUsage && values.consent !== undefined)
      throw new Error('Quota refresh does not take consent.');
    if (importingGoogle && values.family !== undefined)
      throw new Error('Use native import-google --consent.');
    const preparingFile = area === 'task' && action === 'prepare-native';
    const preparingRepository = area === 'task' && action === 'prepare-repository';
    const preparing = preparingFile || preparingRepository;
    const preparingHandoff = area === 'task' && action === 'prepare-handoff';
    if (
      !preparingFile &&
      (values['model-id'] !== undefined ||
        values['thought-level-id'] !== undefined ||
        values['confirm-quota-account'])
    )
      throw new Error(
        'Observed configuration and quota account confirmation require task prepare-native.',
      );
    if (values['handoff-target'] && !preparingFile)
      throw new Error('Manual handoff targets require task prepare-native.');
    const handoffTargets = values['handoff-target']
      ? NativeHandoffTargetsSchema.parse(
          values['handoff-target'].map((value) => {
            const [profileId, credits, ...extra] = value.split(':');
            if (extra.length || (credits !== undefined && credits !== 'existing-credits'))
              throw new Error('Use a file profile, optionally followed by :existing-credits.');
            return { profileId, creditPolicy: credits ?? 'ordinary' };
          }),
        )
      : undefined;
    const evaluating = area === 'task' && action === 'prepare-evaluation';
    if (values['confirm-subscription-only'] && !preparingFile && !preparingHandoff)
      throw new Error('Subscription confirmation requires task prepare-native or prepare-handoff.');
    if (values['context-lines'] !== undefined && !preparingFile)
      throw new Error('Target context lines require task prepare-native.');
    if (values['maximum-task-ms'] !== undefined && !preparingFile)
      throw new Error('The task deadline option requires task prepare-native.');
    if (values['permission-mode'] !== undefined && !preparingFile && !preparingHandoff)
      throw new Error('Permission mode requires task prepare-native or prepare-handoff.');
    if (!evaluating && (values.recipe !== undefined || values['test-file'] !== undefined))
      throw new Error('Check recipe options require task prepare-evaluation.');
    const recipe = values.recipe ?? 'node-tests-v1';
    if (!['node-tests-v1', 'project-node-tests-v1', 'crewkite-verify-v1'].includes(recipe))
      throw new Error('Choose node-tests-v1, project-node-tests-v1 or crewkite-verify-v1.');
    if (recipe !== 'project-node-tests-v1' && values['test-file'] !== undefined)
      throw new Error('Test files require --recipe project-node-tests-v1.');
    const checkRecipe =
      recipe === 'project-node-tests-v1'
        ? {
            checkRecipeId: 'project-node-tests-v1' as const,
            testFiles: ProjectNodeTestFilesSchema.parse(values['test-file'] ?? []),
          }
        : recipe === 'crewkite-verify-v1'
          ? { checkRecipeId: 'crewkite-verify-v1' as const }
          : { checkRecipeId: 'node-tests-v1' as const };
    if (
      !preparing &&
      !evaluating &&
      !preparingHandoff &&
      (values.policy ||
        values['native-trust'] ||
        values['source-consent'] ||
        values['existing-credits'])
    )
      throw new Error('Native consent options require native or evaluation preparation.');
    if (preparingHandoff && (!values['native-trust'] || !values['source-consent']))
      throw new Error('Handoff preparation requires fresh --native-trust and --source-consent.');
    if (values.policy && !preparing)
      throw new Error('Policy requires task prepare-native or prepare-repository.');
    if (values.grants && !evaluating) throw new Error('Grants require task prepare-evaluation.');
    if (
      preparing &&
      (!values.policy || Boolean(values['native-trust']) !== Boolean(values['source-consent']))
    )
      throw new Error(
        'Supply a policy file and both native consent flags, or neither consent flag for saved consent.',
      );
    if (
      evaluating &&
      (!values.grants || Boolean(values['native-trust']) !== Boolean(values['source-consent']))
    )
      throw new Error(
        'Supply a grants file and both native consent flags, or neither consent flag for saved consent.',
      );
    if (
      values.output &&
      !(area === 'retry' || (area === 'task' && ['export', 'approve'].includes(action ?? '')))
    )
      throw new Error('Output requires an export action or its saved receipt.');
    if (area === 'task' && action === 'export' && !values.output)
      throw new Error('Export requires --output with a new file path.');
    const home = resolve(values.home ?? process.env.CREWKITE_HOME ?? join(homedir(), '.crewkite'));
    if (importingGoogle) {
      const provider = await import(
        new URL('../../controller/src/providers/google/acp/import.ts', import.meta.url).href
      );
      const result = await provider.importGoogleAcp({ home, consent: 'explicit' });
      const client = result.client
        ? {
            version: result.client.version,
            sha256: result.client.sha256,
            signerTeamId: result.client.signerTeamId,
          }
        : null;
      output.out(
        values.json
          ? `${JSON.stringify({ imported: result.imported, reason: result.reason, client })}\n`
          : `${result.reason}\n`,
      );
      return result.imported ? 0 : 2;
    }
    const actor = { id: 'terminal', kind: 'cli' as const };
    const creation =
      addingProject || creatingTask || (conversation && action === 'create')
        ? CommandSchema.safeParse({
            protocol: 1,
            key: createCommandKey(),
            actor,
            expectedRevision: 0,
            command: addingProject
              ? 'RegisterProject'
              : creatingTask
                ? 'CreateTask'
                : 'CreateTaskDiscussion',
            payload: addingProject
              ? { path: resolve(id) }
              : conversation
                ? {
                    projectId: id,
                    text: values.text,
                    planning: planningSelection,
                    ...(contextRefs !== undefined ? { context: contextRefs } : {}),
                  }
                : {
                    projectId: id,
                    title: values.title,
                    outcome: values.outcome,
                    criteria: values.criterion,
                  },
          })
        : undefined;
    if (creation && !creation.success)
      throw new Error(
        addingProject
          ? 'Repository paths must contain 1 to 4096 characters.'
          : conversation
            ? 'Use a project ID, a goal up to 4096 encoded bytes and the explicit planning selection.'
            : 'Use a project ID, a title up to 200 characters, an outcome up to 4096 characters and 1 to 100 criteria up to 4096 characters each.',
      );
    const connected = await connectController({ ...readControllerEndpoint(home), actor });
    client = connected;
    let sent: Command | undefined;
    const request = (
      command: string,
      payload: Record<string, unknown>,
      expectedRevision?: number,
    ) => {
      sent = CommandSchema.parse({
        protocol: 1,
        key: createCommandKey(),
        actor,
        command,
        payload,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      });
      return connected.command(sent);
    };
    const print = (data: unknown, text: string) =>
      output.out(values.json ? `${JSON.stringify(data)}\n` : `${terminalText(text)}\n`);
    const receipt = (
      result: CommandResult,
      command = sent,
      savedTo?: string,
      nextCommand?: string[],
    ) => {
      const created =
        succeeded(result) && command?.command === 'RegisterProject'
          ? ProjectSchema.safeParse(result.entity)
          : succeeded(result) &&
              (command?.command === 'CreateTask' || command?.command === 'CreateTaskDiscussion')
            ? TaskSchema.safeParse(result.entity)
            : undefined;
      print(
        {
          command,
          result,
          ...(savedTo ? { savedTo } : {}),
          ...(nextCommand ? { nextCommand } : {}),
        },
        `${nextCommand ? (command?.command === 'AcceptCandidate' ? 'Local branch approval required.' : 'Export approval required.') : (result.reason ?? result.outcome)}${created?.success ? `\n${command?.command === 'RegisterProject' ? 'Project' : 'Task'} ${created.data.id}` : ''}\nCommand key ${command?.key}${savedTo ? `\nPatch saved to ${savedTo}` : ''}${nextCommand ? `\nNext: ${nextCommand.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' ')}` : ''}`,
      );
    };
    const finishAction = async (result: CommandResult) => {
      const command = sent;
      let savedTo: string | undefined;
      try {
        const pending = TaskSchema.safeParse(result.entity);
        if (
          command &&
          (command.command === 'AcceptCandidate' || command.command === 'ExportPatch') &&
          succeeded(result) &&
          pending.success &&
          pending.data.state === 'waiting' &&
          pending.data.waitingReason === 'approval'
        ) {
          const fresh = await connected.snapshot({ taskId: command.payload.taskId });
          const task = fresh.tasks.find((value) => value.id === command.payload.taskId);
          const candidate = fresh.candidates.filter((value) => value.taskId === task?.id).at(-1);
          const action =
            command.command === 'AcceptCandidate' ? 'accept-candidate' : 'export-patch';
          const target =
            command.command === 'AcceptCandidate'
              ? command.payload.destinationRef
              : command.payload.taskId;
          const matches = fresh.approvals.filter((approval) => {
            const attempt = fresh.attempts.find((value) => value.id === approval.attemptId);
            return (
              approval.status === 'pending' &&
              approval.taskId === command.payload.taskId &&
              approval.action === action &&
              approval.target === target &&
              attempt?.runId === task?.runId &&
              attempt?.generation === approval.generation
            );
          });
          if (
            pending.data.id !== command.payload.taskId ||
            !task?.runId ||
            !fresh.runs.some((run) => run.id === task.runId && run.taskId === task.id) ||
            canonicalJson(task) !== canonicalJson(pending.data) ||
            candidate?.id !== command.payload.candidateId ||
            matches.length !== 1
          )
            throw new Error(
              'The pending action changed. Inspect the current task and approval before retrying.',
            );
          receipt(result, command, undefined, [
            'crewkite',
            'task',
            'approve',
            matches[0].approvalId,
            ...(command.command === 'ExportPatch' && values.output
              ? ['--output', resolve(values.output)]
              : []),
            '--home',
            home,
            ...(values.json ? ['--json'] : []),
          ]);
          return 0;
        }
        if (values.output && succeeded(result)) {
          const artifact = ArtifactSchema.parse(result.entity);
          if (artifact.bytes > 64 * 1024 * 1024)
            throw new Error('The patch exceeds the save bound.');
          const chunks: Buffer[] = [];
          let offset = 0;
          while (offset < artifact.bytes || offset === 0) {
            const part = await request('GetArtifact', {
              artifactId: artifact.id,
              offset,
              limit: 65536,
            });
            if (!succeeded(part) || part.data?.kind !== 'artifact')
              throw new Error('The patch is unavailable.');
            const data = part.data;
            if (
              canonicalJson(data.artifact) !== canonicalJson(artifact) ||
              data.offset !== offset ||
              data.encoding !== 'base64'
            )
              throw new Error('The patch identity changed.');
            const bytes = Buffer.from(data.content, 'base64');
            if (
              bytes.toString('base64') !== data.content ||
              bytes.length > 65536 ||
              (bytes.length === 0 && offset !== artifact.bytes)
            )
              throw new Error('The patch chunk is invalid.');
            chunks.push(bytes);
            offset += bytes.length;
            if (offset > artifact.bytes || data.eof !== (offset === artifact.bytes))
              throw new Error('The patch length changed.');
            if (data.eof) break;
          }
          const bytes = Buffer.concat(chunks);
          if (
            bytes.length !== artifact.bytes ||
            createHash('sha256').update(bytes).digest('hex') !== artifact.hash
          )
            throw new Error('The patch checksum changed.');
          savedTo = resolve(values.output);
          const file = openSync(
            savedTo,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            writeFileSync(file, bytes);
            fsyncSync(file);
          } finally {
            closeSync(file);
          }
        }
      } catch (error) {
        receipt(result, command);
        throw error;
      }
      receipt(result, command, savedTo);
      return succeeded(result) ? 0 : 2;
    };
    if (creation?.success) {
      sent = creation.data;
      return await finishAction(await connected.command(sent));
    }
    if (area === 'retry') {
      const value = readJson(action);
      if (value === null || typeof value !== 'object' || !('command' in value))
        throw new Error('Receipt has no saved command.');
      sent = CommandSchema.parse(value.command);
      if (values.output && !['ExportPatch', 'ResolveApproval'].includes(sent.command))
        throw new Error('This receipt cannot export a patch.');
      if (
        values.output &&
        sent.command === 'ResolveApproval' &&
        sent.payload.binding.action !== 'export-patch'
      )
        throw new Error('This approval does not export a patch.');
      const result = await connected.command(sent);
      return await finishAction(result);
    }
    if (area === 'health') {
      const result = await request('GetHealth', {});
      print(
        result,
        result.data?.kind === 'health' ? result.data.status : (result.reason ?? result.outcome),
      );
      return succeeded(result) ? 0 : 2;
    }
    if (refreshingUsage) {
      const result = await request('ObserveUsage', { family: 'google' }, 0);
      print(
        { command: sent, result },
        terminalText(
          `${result.reason ?? result.outcome}${result.next ? `\n${result.next}` : ''}\nCommand key ${sent?.key}`,
        ),
      );
      return succeeded(result) ? 0 : 2;
    }
    if (area === 'usage' || local || area === 'native') {
      const workspace = await client.workspaceState();
      if (area === 'usage') {
        print(
          {
            cursor: workspace.cursor,
            usageReaders: workspace.usageReaders,
            usage: workspace.usage,
          },
          terminalText(
            [
              ...workspace.usageReaders.map(
                (reader) =>
                  `${reader.family} quota reader  ${reader.reason}  last attempt ${reader.lastAttemptAt ?? 'none'}  last observed ${reader.lastObservedAt ?? 'none'}`,
              ),
              ...workspace.usage.map(
                ({ observation, state }) =>
                  `${observation.routeId}  ${observation.windowId}  ${observation.remaining ? `${observation.remaining.value} ${observation.remaining.unit} remaining` : 'remaining unknown'}  ${state}  source ${observation.source}  observed ${observation.observedAt}  resets ${observation.resetsAt ?? 'unknown'}`,
              ),
            ].join('\n') || 'No usage observations or readers.',
          ),
        );
        return 0;
      }

      if (local) {
        const setup = workspace.localSetup;
        if (action === 'status') {
          const profile =
            workspace.nativeProfiles.find((value) => value.id === 'local-file-v1') ?? null;
          print(
            { cursor: workspace.cursor, setup: setup ?? null, profile },
            setup
              ? [
                  `Local revision ${setup.revision}, connection revision ${setup.connectionRevision}`,
                  `Endpoint ${setup.endpoint ?? 'not configured'}`,
                  `Authentication ${setup.authMode === 'none' ? 'No authentication, this device only' : 'Dedicated token'}`,
                  `Connection ${(setup.connected ?? setup.secretConfigured) ? 'connected' : 'required'}`,
                  `Operation ${setup.operation ? `${setup.operation.kind} ${setup.operation.state} ${setup.operation.operationId}` : 'none'}`,
                  `Generation ${setup.generation}`,
                  `Reason ${setup.reason ?? 'none'}`,
                  `Observation ${setup.observation?.observationHash ?? 'none'}`,
                  `Selected ${setup.selection?.selectionId ?? 'none'}`,
                  ...(setup.observation?.models.map(
                    (choice) =>
                      `${choice.selectionId}  ${choice.identity.displayName}  ${choice.identity.format}  ${choice.state}  ${choice.qualification}${choice.reasons.length ? `  ${choice.reasons.join(', ')}` : ''}`,
                  ) ?? []),
                ].join('\n')
              : 'Local controls are unavailable in this controller.',
          );
          return 0;
        }
        if (!setup) throw new Error('Local controls are unavailable in this controller.');
        if (
          action === 'cancel-input' &&
          (setup.operation?.kind !== 'input' || setup.operation.operationId !== id)
        )
          throw new Error(
            'The input operation changed. Read Local status and cancel its exact operation ID.',
          );
        if (
          action === 'select-model' &&
          (!setup.observation ||
            setup.observation.observationHash !== values['observation-hash'] ||
            !setup.observation.models.some((choice) => choice.selectionId === id))
        )
          throw new Error(
            'The observed model choice changed. Read Local status before selecting it.',
          );
        const names = {
          configure: 'ConfigureLocal',
          connect: 'BeginLocalConnectionInput',
          'cancel-input': 'CancelLocalConnectionInput',
          disconnect: 'DisconnectLocal',
          'refresh-models': 'RefreshLocalModels',
          'select-model': 'SelectLocalModel',
        } as const;
        const result = await request(
          names[action as keyof typeof names],
          action === 'configure'
            ? {
                endpoint: values.endpoint,
                ...(values.authentication !== undefined ? { authMode: values.authentication } : {}),
              }
            : action === 'cancel-input'
              ? { operationId: id }
              : action === 'select-model'
                ? { selectionId: id, observationHash: values['observation-hash'] }
                : action === 'disconnect'
                  ? {}
                  : { consent: 'explicit' },
          setup.revision,
        );
        print(
          { command: sent, result },
          `${result.reason ?? result.outcome}${result.next ? `\nNext: ${result.next}` : ''}\nCommand key ${sent?.key}`,
        );
        return succeeded(result) ? 0 : 2;
      }
      if (settingUpGoogle) {
        const setup = workspace.googleAcpSetup;
        if (id === 'show') {
          const profile =
            workspace.nativeProfiles.find((value) => value.id === 'google-acp-v1') ?? null;
          print(
            { cursor: workspace.cursor, setup, profile },
            terminalText(
              `${googleAcpLabel}\nSetup ${setup?.state ?? 'uninitialized'}, revision ${setup?.revision ?? 0}\nReason ${setup?.reason ?? profile?.reason ?? 'not-configured'}\nProof ${setup?.proofId ?? 'none'}\nOperation ${setup?.operationId ?? 'none'}${profile && 'configOptions' in profile ? `\nModels ${profile.configOptions?.model.supported.join(', ') ?? 'unknown'}\nThought levels ${profile.configOptions?.thoughtLevel?.supported.join(', ') ?? 'unknown'}` : ''}`,
            ),
          );
          return 0;
        }
        if ((id === 'authenticate' || id === 'discover') && !setup?.proofId)
          throw new Error('Initialize Google ACP and inspect its retained proof first.');
        if (id === 'stop' && !setup?.operationId)
          throw new Error('No exact setup operation is active. Read setup status first.');
        const names = {
          initialize: 'InitializeGoogleAcp',
          authenticate: 'AuthenticateGoogleAcp',
          discover: 'DiscoverGoogleAcp',
          stop: 'StopGoogleAcpSetup',
        } as const;
        const result = await request(
          names[id as keyof typeof names],
          {
            profileId: 'google-acp-v1',
            ...(id === 'stop' ? { operationId: setup?.operationId } : { consent: 'explicit' }),
            ...(id === 'authenticate' || id === 'discover' ? { proofId: setup?.proofId } : {}),
            ...(id === 'authenticate' ? { method: 'oauth-personal' } : {}),
          },
          setup?.revision ?? 0,
        );
        receipt(result);
        return succeeded(result) ? 0 : 2;
      }
      if (area === 'native') {
        print(
          { profiles: workspace.nativeProfiles },
          workspace.nativeProfiles
            .map((profile) =>
              profile.family === 'local'
                ? `${profile.id}  ${profile.model}  local resources  ${profile.available ? 'available' : profile.reason}  ${profile.qualifiedAt ? `qualified ${profile.qualifiedAt}` : 'qualification pending'}`
                : profile.family !== 'openai'
                  ? `${profile.id}  ${profile.model}  ${profile.effort} requested effort  effective effort unknown  account class unknown  service tier unknown  ${profile.available ? 'available' : profile.reason}  ${profile.qualifiedAt ? `qualified ${profile.qualifiedAt}` : 'qualification pending'}  billing requires user attestation${profile.family === 'google' ? `  permission modes ${profile.permissionModes.join(', ')}` : ''}`
                  : profile.id === 'openai-repository-v1'
                    ? `${profile.id}  ${profile.model}  ${profile.effort}  ${profile.available ? 'available' : profile.reason}  ${profile.qualifiedAt ? `qualified ${profile.qualifiedAt}` : 'qualification pending'}  workspace-write  approval never  network off`
                    : `${profile.id}  ${profile.model}  ${profile.effort}  ${profile.available ? 'available' : profile.reason}`,
            )
            .join('\n') +
            (workspace.nativeProfiles.some((profile) => profile.id === 'google-acp-v1')
              ? `\n${googleAcpLabel}`
              : '') || 'No native profiles.',
        );
        return 0;
      }
    }
    if (area === 'task' && action === 'list' && (!values.json || values.pages)) {
      let received = 0;
      try {
        const header = await client.workspaceState();
        let after: WorkspaceContinuation | undefined;
        do {
          const page = await client.taskPage({ stamp: header.stamp, ...(after ? { after } : {}) });
          if (values.json) output.out(`${JSON.stringify(page)}\n`);
          else
            for (const task of page.tasks)
              output.out(`${terminalText(`${task.id}  ${task.state}  ${task.title}`)}\n`);
          received += page.tasks.length;
          after = page.next ?? undefined;
          if (after) await setImmediate();
        } while (after);
        if (!values.json && received === 0) output.out('No tasks.\n');
        return 0;
      } catch (error) {
        throw new Error(
          `Task list incomplete after ${received} rows. ${error instanceof Error ? error.message : 'Read failed.'}`,
        );
      }
    }
    const snapshot = await client.snapshot(
      (area === 'task' || conversation || combined) && id
        ? action === 'approve' || action === 'deny'
          ? { approvalId: id }
          : { taskId: id }
        : undefined,
    );
    if (combined) {
      const task = requireTask(snapshot, id as string);
      const group =
        snapshot.combinedRuns.find(
          (value) => value.taskId === task.id && value.runId === task.runId,
        ) ?? null;
      if (action === 'status') {
        print(
          { cursor: snapshot.cursor, combined: group },
          group
            ? [
                `Combined run ${group.runId}, revision ${group.revision}, generation ${group.generation}`,
                `Preparation ${group.preparationId}, manifest ${group.manifestHash}`,
                `Phase ${group.phase}, blocker ${group.blocker ?? 'none'}`,
                ...group.members.map(
                  (member) =>
                    `Child ${member.taskId}, run ${member.runId}, scope ${member.scope[0]}, start ${member.start.reason}`,
                ),
                ...group.dispatches.map(
                  (dispatch) =>
                    `${dispatch.phase}: ${dispatch.state}, ${dispatch.maximumMinutes} minutes, attempt ${dispatch.attemptId ?? 'none'}, check ${dispatch.checkArtifactId ?? 'none'}`,
                ),
                `Candidate ${group.candidate ? `${group.candidate.id} ${group.candidate.hash}` : 'none'}`,
                `Remaining ${group.remainingBudgets.attempts} attempts, ${group.remainingBudgets.minutes} minutes, ${group.remainingBudgets.concurrency} slots`,
                ...(['start', 'assemble', 'evaluate', 'review', 'accept'] as const).map(
                  (name) => `${name}: ${group[name].reason}`,
                ),
              ].join('\n')
            : 'No combined run is prepared for the current task.',
        );
        return 0;
      }
      if (combinedPlan)
        return await finishAction(await request('PrepareCombinedRun', combinedPlan, task.revision));
      if (!group?.assemble.available)
        throw new Error(`Assembly unavailable: ${group?.assemble.reason ?? 'not-prepared'}.`);
      return await finishAction(
        await request(
          'AssembleCombinedCandidate',
          {
            taskId: task.id,
            runId: group.runId,
            preparationId: group.preparationId,
          },
          task.revision,
        ),
      );
    }
    if (action === 'list') {
      print(
        { cursor: snapshot.cursor, tasks: snapshot.tasks },
        snapshot.tasks.length
          ? snapshot.tasks.map((task) => `${task.id}  ${task.state}  ${task.title}`).join('\n')
          : 'No tasks.',
      );
      return 0;
    }
    if (action === 'approve' || action === 'deny') {
      const approval = snapshot.approvals.find((item) => item.approvalId === id);
      if (!approval) throw new Error('Approval was not found.');
      const task = requireTask(snapshot, approval.taskId);
      const {
        approvalId,
        taskId,
        attemptId,
        generation,
        action: effect,
        target,
        revision,
      } = approval;
      if (values.output && effect !== 'export-patch')
        throw new Error('This approval does not export a patch.');
      const result = await request(
        'ResolveApproval',
        {
          binding: {
            approvalId,
            taskId,
            attemptId,
            generation,
            action: effect,
            target,
            revision,
            ...(approval.acpTarget ? { acpTarget: approval.acpTarget } : {}),
          },
          decision: action === 'approve' ? 'approved' : 'denied',
        },
        task.revision,
      );
      return await finishAction(result);
    }
    if (!id) throw new Error('A task ID is required.');
    const task = requireTask(snapshot, id);
    if (amendingTask) {
      const result = await request(
        'AmendTask',
        {
          taskId: task.id,
          title: values.title,
          outcome: values.outcome,
          criteria: values.criterion,
        },
        task.revision,
      );
      receipt(result);
      return succeeded(result) ? 0 : 2;
    }
    if (conversation) {
      if (action === 'show') {
        const status = await request('GetTaskConversationState', { taskId: task.id });
        if (!succeeded(status) || status.data?.kind !== 'conversation-state') {
          receipt(status);
          return 2;
        }
        const history = await request('GetTaskConversation', {
          taskId: task.id,
          ...(values['before-cursor'] !== undefined
            ? { beforeCursor: values['before-cursor'] }
            : {}),
        });
        if (!succeeded(history) || history.data?.kind !== 'conversation') {
          receipt(history);
          return 2;
        }
        if (status.data.state.taskId !== task.id || history.data.taskId !== task.id)
          throw new Error('The conversation response belongs to a different task.');
        print(
          { state: status.data.state, conversation: history.data },
          [
            conversationStateText(status.data.state),
            ...history.data.entries.map(conversationEntryText),
            `Older page before ${history.data.nextBeforeCursor ?? 'none'}`,
          ].join('\n'),
        );
        return 0;
      }
      const names = {
        configure: 'ConfigureTaskConversation',
        send: 'SendTaskMessage',
        answer: 'AnswerTaskQuestion',
        guide: 'QueueTaskGuidance',
        adopt: 'AdoptTaskPlan',
      } as const;
      const result = await request(
        names[action as keyof typeof names],
        {
          taskId: task.id,
          ...(planningSelection ? { planning: planningSelection } : {}),
          ...(values.text !== undefined ? { text: values.text } : {}),
          ...(contextRefs !== undefined ? { context: contextRefs } : {}),
          ...(action === 'answer' ? { questionId: values['question-id'] } : {}),
          ...(action === 'adopt'
            ? { proposalId: values['proposal-id'], proposalHash: values['proposal-hash'] }
            : {}),
        },
        task.revision,
      );
      return await finishAction(result);
    }
    if (action === 'prepare-evaluation') {
      const profile = snapshot.nativeProfiles.find((profile) => profile.id === extra[0]);
      if (profile && profile.id !== 'openai-file-v1')
        throw new Error('Choose a supported OpenAI reviewer profile.');
      const run = snapshot.runs.find((run) => run.id === task.runId);
      const candidate = snapshot.candidates.filter((value) => value.taskId === task.id).at(-1);
      const methods = run?.policy.policy.methods ?? [];
      const combined = snapshot.combinedRuns.find(
        (value) => value.taskId === task.id && value.runId === run?.id,
      );
      if (
        !profile?.available ||
        !run ||
        !candidate ||
        task.state !== 'stopped' ||
        (combined
          ? run.taskId !== task.id ||
            combined.phase !== 'awaiting-evaluation' ||
            !combined.evaluate.available ||
            combined.candidate?.id !== candidate.id ||
            combined.candidate.hash !== candidate.hash
          : !snapshot.nativeRuns.some((value) => value.runId === run.id))
      )
        throw new Error(
          'A stopped native or current combined candidate and available reviewer profile are required.',
        );
      if (methods.length !== 1 || methods[0].id !== 'keep-it-simple' || methods[0].cycles !== 1)
        throw new Error(
          'Evaluation requires the saved single keep-it-simple method and one cycle.',
        );
      const creditPolicy = values['existing-credits'] ? 'existing-credits' : 'ordinary';
      if (!profile.creditPolicies.some((value) => value === creditPolicy))
        throw new Error('This reviewer profile does not support the selected credit policy.');
      if (
        combined &&
        canonicalJson({
          recipeId: checkRecipe.checkRecipeId,
          testFiles: 'testFiles' in checkRecipe ? checkRecipe.testFiles : [],
          reviewer: { profileId: profile.id, methodId: methods[0].id, cycles: 1 },
          creditPolicy,
        }) !== canonicalJson(combined.evaluationSelection)
      )
        throw new Error('Use the combined run’s saved recipe, test files and reviewer selection.');
      return await finishAction(
        await request(
          'PrepareCandidateEvaluation',
          {
            taskId: task.id,
            candidateId: candidate.id,
            ...checkRecipe,
            reviewer: { profileId: profile.id, methodId: methods[0].id, cycles: 1 },
            creditPolicy,
            consent: values['native-trust'] && values['source-consent'] ? 'explicit' : 'saved',
            grants: readJson(values.grants as string),
          },
          task.revision,
        ),
      );
    }
    if (action === 'start-checks' || action === 'start-review') {
      const evaluation = snapshot.candidateEvaluations.find((value) => value.taskId === task.id);
      if (!evaluation) throw new Error('Prepare a candidate evaluation first.');
      return await finishAction(
        await request(
          action === 'start-checks' ? 'StartCandidateEvaluation' : 'StartCandidateReview',
          {
            taskId: task.id,
            candidateId: evaluation.candidateId,
            preparationId: evaluation.preparationId,
          },
          task.revision,
        ),
      );
    }
    if (action === 'prepare-handoff' || action === 'start-handoff') {
      const native = snapshot.nativeRuns.find((value) => value.runId === task.runId);
      const handoff = native?.handoff;
      if (!task.runId || !handoff)
        throw new Error('This run has no saved manual file handoff recipients.');
      if (action === 'start-handoff') {
        if (!handoff.pending?.start.available)
          throw new Error(
            `Handoff start unavailable: ${handoff.pending?.start.reason ?? 'not-prepared'}.`,
          );
        return await finishAction(
          await request(
            'StartNativeHandoff',
            {
              taskId: task.id,
              runId: task.runId,
              preparationId: handoff.pending.preparationId,
            },
            task.revision,
          ),
        );
      }
      if (!handoff.prepare.available)
        throw new Error(`Handoff preparation unavailable: ${handoff.prepare.reason}.`);
      const creditPolicy = values['existing-credits'] ? 'existing-credits' : 'ordinary';
      const recipient = handoff.targets.find(
        (value) => value.profileId === extra[0] && value.creditPolicy === creditPolicy,
      );
      if (!recipient)
        throw new Error('Choose a previously allowed file recipient and its exact credit policy.');
      const profile = snapshot.nativeProfiles.find((value) => value.id === recipient.profileId);
      if (!profile?.available)
        throw new Error(`Native profile unavailable: ${profile?.reason ?? 'not-found'}.`);
      if (values['confirm-subscription-only'] && profile.family === 'openai')
        throw new Error(
          'Subscription confirmation is supported only for an Anthropic or Google writer.',
        );
      if (values['permission-mode'] !== undefined && profile.family !== 'google')
        throw new Error('Permission mode is supported only for a Google writer.');
      if (profile.family !== 'openai' && !values['confirm-subscription-only'])
        throw new Error(
          'Confirm the recipient subscription login and disabled paid extra usage with --confirm-subscription-only.',
        );
      const permissionMode =
        profile.family === 'google'
          ? profile.permissionModes.find((mode) => mode === values['permission-mode'])
          : undefined;
      if (profile.family === 'google' && !permissionMode)
        throw new Error('Choose the current Google client setting with --permission-mode.');
      return await finishAction(
        await request(
          'PrepareNativeHandoff',
          {
            taskId: task.id,
            runId: task.runId,
            fromAttemptId: handoff.currentAttemptId,
            ...recipient,
            consent: 'explicit',
            ...(profile.family !== 'openai'
              ? {
                  billingAttestation: {
                    source: 'user-attested',
                    subscriptionLoginConfirmed: true,
                    paidExtraUsageDisabled: true,
                  },
                }
              : {}),
            ...(permissionMode ? { permissionMode } : {}),
          },
          task.revision,
        ),
      );
    }
    if (action === 'prepare-repository') {
      const profile = snapshot.nativeProfiles.find((profile) => profile.id === extra[0]);
      if (profile?.id !== 'openai-repository-v1')
        throw new Error('Choose a supported repository profile for repository work.');
      if (!profile.available) throw new Error(`Native profile unavailable: ${profile.reason}.`);
      const creditPolicy = values['existing-credits'] ? 'existing-credits' : 'ordinary';
      if (!profile.creditPolicies.some((value) => value === creditPolicy))
        throw new Error('This profile does not support the selected credit policy.');
      const policy = PolicySchema.parse(readJson(values.policy as string));
      const project = snapshot.projects.find((value) => value.id === task.projectId);
      if (
        !policy.effects.some(
          (grant) =>
            grant.action === 'run-native-tools' &&
            grant.taskId === task.id &&
            grant.target === project?.name &&
            !grant.revoked &&
            grant.usesRemaining > 0 &&
            Date.parse(grant.expiresAt) > Date.now(),
        )
      )
        throw new Error(
          'Repository work requires an unexpired one-use run-native-tools grant for this task and project.',
        );
      return await finishAction(
        await request(
          'PrepareNativeRun',
          {
            taskId: task.id,
            profileId: 'openai-repository-v1',
            policy,
            creditPolicy,
            consent: values['native-trust'] && values['source-consent'] ? 'explicit' : 'saved',
          },
          task.revision,
        ),
      );
    }
    if (action === 'prepare-native') {
      const profile = snapshot.nativeProfiles.find((profile) => profile.id === extra[0]);
      if (values['context-lines'] !== undefined && profile?.id !== 'google-acp-v1')
        throw new Error('Target context lines require the Google ACP profile.');
      if (values['maximum-task-ms'] !== undefined && profile?.id !== 'google-acp-v1')
        throw new Error('The task deadline option requires the Google ACP profile.');
      if (profile?.family === 'local') {
        if (!profile.available) throw new Error(`Native profile unavailable: ${profile.reason}.`);
        if (
          values['existing-credits'] ||
          values['confirm-subscription-only'] ||
          values['permission-mode'] !== undefined ||
          handoffTargets ||
          values['model-id'] !== undefined ||
          values['thought-level-id'] !== undefined ||
          values['confirm-quota-account']
        )
          throw new Error(
            'Local preparation uses the selected observed model, with no billing, effort or handoff options.',
          );
        return await finishAction(
          await request(
            'PrepareNativeRun',
            {
              taskId: task.id,
              profileId: profile.id,
              targetPath: extra[1],
              policy: PolicySchema.parse(readJson(values.policy as string)),
              consent: values['native-trust'] && values['source-consent'] ? 'explicit' : 'saved',
            },
            task.revision,
          ),
        );
      }
      if (profile?.id === 'openai-repository-v1')
        throw new Error('Use task prepare-repository for repository work.');
      if (!profile?.available)
        throw new Error(`Native profile unavailable: ${profile?.reason ?? 'not-found'}.`);
      const acp = profile.family === 'google' && profile.id === 'google-acp-v1';
      if (
        !acp &&
        (values['model-id'] !== undefined ||
          values['thought-level-id'] !== undefined ||
          values['confirm-quota-account'])
      )
        throw new Error('These configuration choices require the Google ACP profile.');
      if (acp) {
        const contextValues = values['context-lines'];
        if (
          contextValues &&
          (contextValues.length !== 1 || !/^[1-9][0-9]*:[1-9][0-9]*$/.test(contextValues[0] ?? ''))
        )
          throw new Error('Choose one inclusive target line window as START:END.');
        const contextLines = contextValues
          ? NativeTargetContextLinesSchema.parse({
              start: Number(contextValues[0]?.split(':')[0]),
              end: Number(contextValues[0]?.split(':')[1]),
            })
          : undefined;
        const maximumTaskMs = values['maximum-task-ms'];
        if (maximumTaskMs !== undefined && !['300000', '600000'].includes(maximumTaskMs))
          throw new Error('Choose a Google task deadline of 300000 or 600000 milliseconds.');
        const setup = snapshot.googleAcpSetup;
        const configuration = profile.configOptions;
        const saved = snapshot.nativeRuns.find(
          (value) => value.runId === task.runId && value.profileId === profile.id,
        );
        const explicit = !!values['native-trust'] && !!values['source-consent'];
        const modelId = values['model-id'] ?? (!explicit ? saved?.acp?.modelId : undefined);
        const thoughtLevelId =
          values['thought-level-id'] ?? (!explicit ? saved?.acp?.thoughtLevelId : null);
        const policy = PolicySchema.parse(readJson(values.policy as string));
        const savedAttestation =
          !explicit &&
          saved?.billingAttestation &&
          'quotaAccountConfirmed' in saved.billingAttestation
            ? saved.billingAttestation
            : undefined;
        const attestation =
          values['confirm-subscription-only'] && values['confirm-quota-account']
            ? {
                source: 'user-attested',
                subscriptionLoginConfirmed: true,
                paidExtraUsageDisabled: true,
                quotaAccountConfirmed: true,
              }
            : savedAttestation;
        if (
          setup?.state !== 'ready' ||
          !setup.proofId ||
          !configuration ||
          !modelId ||
          !configuration.model.supported.includes(modelId) ||
          (configuration.thoughtLevel
            ? !thoughtLevelId || !configuration.thoughtLevel.supported.includes(thoughtLevelId)
            : thoughtLevelId !== null)
        )
          throw new Error('Choose advertised model and thought-level IDs from ready Google setup.');
        if (
          !explicit &&
          (!saved?.acp ||
            saved.acp.proofId !== setup.proofId ||
            saved.acp.modelId !== modelId ||
            saved.acp.thoughtLevelId !== thoughtLevelId)
        )
          throw new Error('Saved consent requires the exact retained proof and configuration.');
        if (!attestation)
          throw new Error(
            'Confirm subscription-only billing and that quota and ACP use the same Google account.',
          );
        if (
          policy.authority === 'autopilot' ||
          values['existing-credits'] ||
          handoffTargets ||
          (values['permission-mode'] !== undefined &&
            values['permission-mode'] !== 'request-review')
        )
          throw new Error(
            'Google ACP requires guided or balanced authority, ordinary billing and request-review, with no handoff.',
          );
        return await finishAction(
          await request(
            'PrepareNativeRun',
            {
              taskId: task.id,
              profileId: profile.id,
              targetPath: extra[1],
              policy,
              creditPolicy: 'ordinary',
              consent: explicit ? 'explicit' : 'saved',
              proofId: setup.proofId,
              ...(maximumTaskMs === undefined ? {} : { maximumTaskMs: Number(maximumTaskMs) }),
              ...(contextLines === undefined ? {} : { contextLines }),
              modelId,
              thoughtLevelId,
              billingAttestation: attestation,
              permissionMode: 'request-review',
            },
            task.revision,
          ),
        );
      }
      const creditPolicy = values['existing-credits'] ? 'existing-credits' : 'ordinary';
      if (!profile.creditPolicies.some((value) => value === creditPolicy))
        throw new Error('This profile does not support the selected credit policy.');
      if (values['confirm-subscription-only'] && profile.family === 'openai')
        throw new Error(
          'Subscription confirmation is supported only for an Anthropic or Google writer.',
        );
      const explicit = !!values['native-trust'] && !!values['source-consent'];
      const savedNative = snapshot.nativeRuns.find(
        (value) => value.runId === task.runId && value.profileId === profile.id,
      );
      const billingAttestation =
        profile.family !== 'openai'
          ? values['confirm-subscription-only']
            ? {
                source: 'user-attested' as const,
                subscriptionLoginConfirmed: true as const,
                paidExtraUsageDisabled: true as const,
              }
            : !explicit
              ? savedNative?.billingAttestation
              : undefined
          : undefined;
      if (profile.family !== 'openai' && !billingAttestation)
        throw new Error(
          'Confirm subscription login and disabled paid extra usage with --confirm-subscription-only, or use exact saved billing confirmations.',
        );
      if (values['permission-mode'] !== undefined && profile.family !== 'google')
        throw new Error('Permission mode is supported only for a Google writer.');
      const permissionMode =
        profile.family === 'google'
          ? profile.permissionModes.find(
              (mode) =>
                mode ===
                (values['permission-mode'] ??
                  (!explicit ? savedNative?.permissionMode : undefined)),
            )
          : undefined;
      if (profile.family === 'google' && !permissionMode)
        throw new Error(
          'Choose the current Google client setting with --permission-mode: request-review, strict, always-proceed or proceed-in-sandbox. Exact saved consent can reuse its saved mode.',
        );
      return await finishAction(
        await request(
          'PrepareNativeRun',
          {
            taskId: task.id,
            profileId: profile.id,
            targetPath: extra[1],
            policy: readJson(values.policy as string),
            creditPolicy,
            consent: explicit ? 'explicit' : 'saved',
            ...(handoffTargets ? { handoffTargets } : {}),
            ...(billingAttestation ? { billingAttestation } : {}),
            ...(permissionMode ? { permissionMode } : {}),
          },
          task.revision,
        ),
      );
    }
    if (action === 'accept') {
      const candidate = snapshot.candidates.filter((value) => value.taskId === task.id).at(-1);
      if (!candidate) throw new Error('No retained candidate is available.');
      return await finishAction(
        await request(
          'AcceptCandidate',
          { taskId: task.id, candidateId: candidate.id, destinationRef: extra[0] },
          task.revision,
        ),
      );
    }
    if (action === 'changes' || action === 'export') {
      const changes = await request('GetChanges', { taskId: task.id });
      if (action === 'changes') {
        if (!values.json && changes.data?.kind === 'changes' && changes.data.truncated)
          output.out('Diff preview is truncated. Export retains the complete patch.\n');
        print(
          changes,
          changes.data?.kind === 'changes'
            ? terminalText(changes.data.diff)
            : (changes.reason ?? changes.outcome),
        );
        return succeeded(changes) ? 0 : 2;
      }
      if (changes.data?.kind !== 'changes' || !changes.data.candidateId) {
        print(changes, changes.reason ?? 'No retained candidate is available.');
        return 2;
      }
      return await finishAction(
        await request(
          'ExportPatch',
          { taskId: task.id, candidateId: changes.data.candidateId },
          task.revision,
        ),
      );
    }
    if (action === 'show') {
      const approvals = snapshot.approvals.filter(
        (value) => value.taskId === task.id && value.status === 'pending',
      );
      const nativeRun = snapshot.nativeRuns.find((value) => value.runId === task.runId);
      const run = nativeRun
        ? snapshot.runs.find((value) => value.id === nativeRun.runId)
        : undefined;
      const billingText = nativeRun?.billingAttestation
        ? '\nBilling: user-attested subscription login, paid extra usage disabled'
        : '';
      const permissionText = nativeRun?.permissionMode
        ? `\nExpected native permission mode: ${nativeRun.permissionMode}`
        : '';
      const repositoryText = nativeRun?.repository
        ? `\nRepository ${nativeRun.repository.files} files, ${nativeRun.repository.bytes} bytes\nSource base ${nativeRun.repository.sourceBase}\nManifest ${nativeRun.repository.manifestHash}\nNative sandbox ${nativeRun.execution?.sandbox}\nNative approval ${nativeRun.execution?.approvalPolicy}\nNative network ${nativeRun.execution?.networkAccess === false ? 'off' : 'unknown'}\nExpires ${nativeRun.expiresAt ?? 'unknown'}`
        : '';
      const localModel = nativeRun?.localModel;
      const localModelText = localModel
        ? `\nModel ${localModel.modelKey}\nInstance ${localModel.instanceReference}\nModel bytes ${localModel.modelSizeBytes}\nSetup ${localModel.setupHash}${'identityKind' in localModel ? `\nIdentity runtime metadata, ${localModel.format}\nMetadata ${localModel.metadataHash}\nConnection ${localModel.connectionHash}, revision ${localModel.connectionRevision}` : `\nIdentity retained artifact, ${localModel.artifactSha256}\nQuantization ${localModel.quantization}`}`
        : '';
      const preview = nativeRun?.repository
        ? `\nNative ${nativeRun.profileId}, ${nativeRun.stage}${repositoryText}`
        : nativeRun
          ? `\nNative ${nativeRun.profileId}, ${nativeRun.stage}\nTarget ${nativeRun.target?.path ?? 'unknown'}\nBase hash ${nativeRun.target?.baseHash ?? 'unknown'}\nBytes ${nativeRun.target?.bytes ?? 'unknown'}\nExpires ${nativeRun.expiresAt ?? 'unknown'}\nSource base ${run?.source.base ?? 'unknown'}${billingText}${permissionText}${localModelText}`
          : '';
      const handoffText = nativeRun?.handoff
        ? `\nManual handoff generation ${nativeRun.handoff.generation}\nAllowed recipients ${nativeRun.handoff.targets.map((value) => `${value.profileId}:${value.creditPolicy}`).join(', ')}\nPrepare ${nativeRun.handoff.prepare.reason}\nOriginal limits ${run?.policy.policy.limits.attempts ?? 'unknown'} attempts, ${run?.policy.policy.limits.minutes ?? 'unknown'} minutes${nativeRun.handoff.pending ? `\nPending recipient ${nativeRun.handoff.pending.recipient.profileId}:${nativeRun.handoff.pending.recipient.creditPolicy}\nPreparation ${nativeRun.handoff.pending.preparationId}\nPacket ${nativeRun.handoff.pending.packetId}\nRetained unverified base ${nativeRun.handoff.pending.baseHash}, ${nativeRun.handoff.pending.bytes} bytes\nExpires ${nativeRun.handoff.pending.expiresAt}\nStart ${nativeRun.handoff.pending.start.reason}` : ''}`
        : '';
      const evaluation = snapshot.candidateEvaluations.find((value) => value.taskId === task.id);
      const evidence = evaluation
        ? snapshot.evidence.filter((value) => value.candidateId === evaluation.candidateId)
        : [];
      const evaluationText = evaluation
        ? [
            '',
            `Evaluation ${evaluation.stage}`,
            `Preparation ${evaluation.preparationId}`,
            `Recipe ${evaluation.recipe}`,
            ...evaluation.testFiles.map(
              (file) =>
                `Test file ${terminalText(file.path)}, ${file.hash}, ${file.bytes} bytes, ${file.mode}`,
            ),
            ...(evaluation.verification
              ? [
                  `Stages ${evaluation.verification.stages.join(', ')}`,
                  `Maximum ${evaluation.verification.maximumMinutes} minutes including staging and cleanup`,
                  `Platform ${evaluation.verification.platform}, ${evaluation.verification.arch}`,
                  `Toolchain ${evaluation.verification.toolchainHash}`,
                  `Baseline ${evaluation.verification.baselineHash}`,
                  `Lockfile ${evaluation.verification.lockHash}`,
                  ...Object.entries(evaluation.verification.executables).map(
                    ([name, executable]) =>
                      `${name} ${terminalText(executable.version)}, ${executable.sha256}`,
                  ),
                ]
              : []),
            `Candidate ${evaluation.candidateHash}`,
            ...(evaluation.repository
              ? [
                  `Repository ${evaluation.repository.files} files, ${evaluation.repository.bytes} bytes`,
                  `Source base ${evaluation.repository.sourceBase}`,
                  `Source manifest ${evaluation.repository.manifestHash}`,
                ]
              : [
                  `Target ${evaluation.target?.path}`,
                  `Original file hash ${evaluation.target?.baseHash}`,
                  `Candidate content hash ${evaluation.target?.candidateContentHash}`,
                ]),
            `Check definition ${evaluation.definitionHash}`,
            `Reviewer ${evaluation.reviewer.profileId}, ${evaluation.reviewer.assignedRole}, ${evaluation.reviewer.methodId}, cycle ${evaluation.reviewer.cycle}, process-only`,
            `Credits ${evaluation.creditPolicy}`,
            `Expires ${evaluation.expiresAt}`,
            `Remaining total attempts ${evaluation.remainingBudgets.attempts}, minutes ${evaluation.remainingBudgets.minutes}`,
            `Checks ${evaluation.check?.passed ?? 'unrecorded'}, ${evaluation.checkStart.reason}, artifact ${evaluation.check?.artifactId ?? 'unrecorded'}`,
            `Review ${evaluation.review?.outcome ?? 'unrecorded'}, ${evaluation.reviewStart.reason}, artifact ${evaluation.review?.artifactId ?? 'unrecorded'}`,
            'Supplemental allowance: one local check and one additional native review.',
            `Local acceptance ${evaluation.localAcceptance.available ? 'available' : 'unavailable'}, ${evaluation.localAcceptance.reason}. The destination needs its own grant or approval.`,
            ...evidence.flatMap((value) =>
              value.review
                ? [
                    terminalText(value.review.summary),
                    ...value.review.findings.map(
                      (finding) => `${finding.severity}: ${terminalText(finding.message)}`,
                    ),
                  ]
                : [],
            ),
          ].join('\n')
        : '';
      print(
        {
          cursor: snapshot.cursor,
          task,
          approvals,
          ...(nativeRun ? { nativeRun, run } : {}),
          ...(evaluation ? { evaluation, evidence } : {}),
        },
        terminalText(
          `${task.id}\n${task.title}\n${task.state}, revision ${task.revision}${task.next ? `\nNext: ${task.next}` : ''}${approvalText(approvals)}${preview}${handoffText}${evaluationText}`,
        ),
      );
      return 0;
    }
    if (action === 'watch') {
      const waiting = Promise.withResolvers<number>();
      let stopped = false;
      const stop = () => {
        stopped = true;
        waiting.resolve(0);
        // Closing the client also settles a subscription still being initialized.
        client?.close();
      };
      let unsubscribe: (() => void) | undefined;
      let stopConnection: (() => void) | undefined;
      let stopExhausted: (() => void) | undefined;
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        const approvals = snapshot.approvals.filter(
          (value) => value.taskId === task.id && value.status === 'pending',
        );
        print(
          { type: 'snapshot', cursor: snapshot.cursor, task, approvals },
          terminalText(
            `${snapshot.cursor} ${task.state}, revision ${task.revision}${task.next ? `\nNext: ${task.next}` : ''}${approvalText(approvals)}`,
          ),
        );
        unsubscribe = await client.subscribe(
          snapshot.cursor,
          (event) => {
            if (event.taskId === task.id)
              print(
                event,
                terminalText(
                  `${event.cursor} ${event.type}, revision ${event.revision}${event.type === 'approval.requested' ? approvalText([event.payload]) : event.type === 'task.updated' && event.payload.next ? `\nNext: ${event.payload.next}` : ''}`,
                ),
              );
          },
          (fresh) => {
            const current = fresh.tasks.find((item) => item.id === task.id);
            if (current) {
              const approvals = fresh.approvals.filter(
                (value) => value.taskId === current.id && value.status === 'pending',
              );
              print(
                { type: 'snapshot', cursor: fresh.cursor, task: current, approvals },
                terminalText(
                  `${fresh.cursor} ${current.state}, revision ${current.revision}${current.next ? `\nNext: ${current.next}` : ''}${approvalText(approvals)}`,
                ),
              );
            }
          },
        );
        stopConnection = client.onConnection((state) => {
          if (state === 'offline' && !stopped)
            output.err('Controller offline. The last event cursor is retained.\n');
        });
        stopExhausted = client.onReconnectExhausted(() => {
          output.err(
            'Reconnect attempts ended. Start the controller, then run task watch again.\n',
          );
          waiting.resolve(1);
        });
        return await waiting.promise;
      } catch (error) {
        if (stopped) return 0;
        throw error;
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        stopExhausted?.();
        unsubscribe?.();
        stopConnection?.();
      }
    }
    if (!task.runId)
      throw new Error('Prepare this task in the desktop before controlling its run.');
    if (action === 'switch') {
      const result = await request(
        'SwitchRoute',
        { taskId: task.id, runId: task.runId, routeId: extra[0] },
        task.revision,
      );
      receipt(result);
      return succeeded(result) ? 0 : 2;
    }
    const names = {
      start: 'StartRun',
      pause: 'PauseAdmissions',
      stop: 'StopRun',
      resume: 'ResumeRun',
    } as const;
    const result = await request(
      names[action as keyof typeof names],
      { taskId: task.id, runId: task.runId },
      task.revision,
    );
    receipt(result);
    return succeeded(result) ? 0 : 2;
  } catch (error) {
    output.err(`${terminalText(error instanceof Error ? error.message : 'CLI command failed.')}\n`);
    return 1;
  } finally {
    client?.close();
  }
}

function conversationStateText(state: TaskConversationState) {
  const configuration = state.configuration;
  const choices = state.modelChoices;
  return [
    `${state.taskId} ${state.phase}, revision ${state.revision}, contract ${state.contractStatus}`,
    configuration
      ? `Primary ${configuration.selection.role}, ${configuration.selection.profileId}, ${configuration.routeId ?? 'route unknown'}, credits ${configuration.selection.creditPolicy}\nRequested model ${configuration.requestedModel ?? 'unknown'}, effective model ${configuration.effectiveModel ?? 'unknown'}\nRequested effort ${configuration.requestedEffort ?? 'unknown'}, effective effort ${configuration.effectiveEffort ?? 'unknown'}`
      : 'Primary not configured',
    `Model choices ${choices?.status ?? 'not-observed'}: ${choices?.reason ?? 'not-observed'}`,
    `Choices observed at ${choices?.observedAt ?? 'none'}`,
    choices?.observation
      ? `Observation artifact ${choices.observation.artifactId}, hash ${choices.observation.hash}`
      : 'Observation none',
    ...(choices?.models.map(
      (choice) =>
        `Observed model ${choice.model}, efforts ${JSON.stringify(choice.efforts)}, default effort ${choice.defaultEffort}`,
    ) ?? []),
    state.budget
      ? `Task limits ${JSON.stringify(state.budget.limits)}\nRemaining ${JSON.stringify(state.budget.remaining)}`
      : 'Task budget not configured',
    `Send ${state.send.available ? state.send.disposition : 'unavailable'}: ${state.send.reason}`,
    `Adopt ${state.adopt.available ? 'available' : 'unavailable'}: ${state.adopt.reason}`,
    `Current run ${state.currentRunId ?? 'none'}`,
    ...(state.activeAttempt
      ? [
          `Active attempt ${state.activeAttempt.id}, generation ${state.activeAttempt.generation}, ${state.activeAttempt.state}`,
        ]
      : []),
    `Queued inputs ${state.queuedInputCount}`,
    ...state.pendingQuestions.map((question) => `Pending question ${question.id}`),
    ...(state.proposal ? [`Proposal ${state.proposal.id}, hash ${state.proposal.hash}`] : []),
    ...(state.adoptedProposal
      ? [`Adopted proposal ${state.adoptedProposal.id}, hash ${state.adoptedProposal.hash}`]
      : []),
  ].join('\n');
}

function conversationEntryText(entry: ConversationEntry) {
  return `${entry.cursor} ${entry.id} ${entry.kind} ${entry.author.kind === 'agent' ? `${entry.author.role} ${entry.author.routeId}` : entry.author.kind}\n${entry.text}${'replyTo' in entry ? `\nReply to ${entry.replyTo}` : ''}${entry.kind === 'plan-proposal' ? `\n${JSON.stringify(entry.proposal, null, 2)}` : ''}`;
}

function approvalText(approvals: Snapshot['approvals']) {
  return approvals
    .map(
      (approval) =>
        `\nApproval ${approval.approvalId}: ${approval.action} ${approval.target}\n${approval.consequence}\nApprove: crewkite task approve ${approval.approvalId}\nDeny: crewkite task deny ${approval.approvalId}`,
    )
    .join('');
}

function readJson(path: string): unknown {
  const file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const state = fstatSync(file);
    if (!state.isFile() || state.size > MAX_FRAME_BYTES)
      throw new Error('Input must be a bounded JSON file.');
    return JSON.parse(readFileSync(file, 'utf8'));
  } finally {
    closeSync(file);
  }
}

function requireTask(snapshot: Snapshot, id: string): Task {
  const task = snapshot.tasks.find((item) => item.id === id);
  if (!task) throw new Error('Task was not found.');
  return task;
}
function succeeded(result: CommandResult) {
  return result.outcome === 'applied' || result.outcome === 'already-applied';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runCli(process.argv.slice(2));
