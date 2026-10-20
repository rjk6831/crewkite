export const configuration = {
  model_provider: 'openai',
  service_tier: 'default',
  approval_policy: 'on-request',
  approvals_reviewer: 'user',
  sandbox_mode: 'read-only',
  web_search: 'disabled',
  chatgpt_base_url: 'https://chatgpt.com/backend-api/',
  openai_base_url: '',
  features: { plugins: false, remote_plugin: false, apps: false, hooks: false, multi_agent: false },
  mcp_servers: { fixture_server: { enabled: false } },
};
export const replies: Record<string, unknown> = {
  initialize: { userAgent: 'private-data', platformFamily: 'unix', platformOs: 'fixture' },
  'account/read': { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true },
  'config/read': { config: configuration },
  'configRequirements/read': { requirements: null },
  'account/rateLimits/read': { ordinaryUsageAllowed: true, rateLimits: {} },
  'model/list': {
    data: [
      {
        id: 'gpt-6.1-sol',
        model: 'gpt-6.1-sol',
        displayName: 'model',
        hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
        defaultReasoningEffort: 'low',
      },
    ],
    nextCursor: null,
  },
};
export const threadResult = (directory: string) => ({
  thread: { id: 'thread-1', ephemeral: true },
  model: 'gpt-6.1-sol',
  modelProvider: 'openai',
  cwd: directory,
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  sandbox: { type: 'readOnly' },
  reasoningEffort: 'low',
  serviceTier: 'default',
});
export const running = { id: 'turn-1', status: 'inProgress', items: [], error: null };
export const fixtureContent = (path: string) =>
  path.endsWith('.md')
    ? '# Updated provider notes\n'
    : 'export function netMinor() { return 0; }\n';
export const fixture = `
const { createInterface } = require('node:readline');
const mode = process.argv[1], phase = process.argv[2];
if (phase === 'features') {
  process.stdout.write(['plugins','remote_plugin','apps','hooks','multi_agent'].map(k => k+' stable false').join('\\n')+'\\n');
  process.exit(0);
}
const replies = ${JSON.stringify(replies)};
const thread = ${threadResult.toString()};
const running = ${JSON.stringify(running)};
const content = ${fixtureContent.toString()};
const input = createInterface({input:process.stdin});
input.on('line', line => {
  const message = JSON.parse(line);
  if (!message.id) return;
  if (message.method === 'turn/interrupt') {
    process.stdout.write(JSON.stringify({id:message.id,result:{}})+'\\n');
    return;
  }
  let result = replies[message.method];
  if (message.method === 'config/read') result = {config:{...replies['config/read'].config,mcp_servers:{fixture_server:{enabled:phase === 'prepare',command:'private-diagnostic-canary',env:{secret:'private-diagnostic-canary'}},...(mode === 'mcp-drift' && phase === 'task' ? {new_server:{enabled:true}} : {})}}};
  if (message.method === 'thread/start') result = thread(process.cwd());
  if (message.method === 'turn/start' && mode === 'rpc-error') {
    process.stdout.write(JSON.stringify({id:message.id,error:{code:-32602,message:'private-diagnostic-canary',data:{account:'private-diagnostic-canary'}}})+'\\n');
    return;
  }
  if (message.method === 'turn/start') result = {turn:running};
  process.stdout.write(JSON.stringify({id:message.id,result})+'\\n');
  if (message.method === 'turn/start' && mode === 'success') {
    const path = message.params.outputSchema.properties.path.const;
    const edit = {version:1,attemptId:message.params.outputSchema.properties.attemptId.const,path,baseHash:message.params.outputSchema.properties.baseHash.const,content:content(path)};
    const item = {id:'message-1',type:'agentMessage',text:JSON.stringify(edit),phase:'final_answer'};
    for (const [method,params] of [
      ['turn/started',{threadId:'thread-1',turn:running}],
      ['item/started',{threadId:'thread-1',turnId:'turn-1',item:{...item,text:''},startedAtMs:1}],
      ['item/completed',{threadId:'thread-1',turnId:'turn-1',item,completedAtMs:2}],
      ['turn/completed',{threadId:'thread-1',turn:{...running,status:'completed'}}],
    ]) process.stdout.write(JSON.stringify({method,params})+'\\n');
  }
});
input.on('close',()=>process.exit(0));
`;

export const fixtureModel = 'gpt-6.1-sol' as const;

/**
 * The child edits only its admitted scratch cwd; transport storage stays separate. Its command
 * streams three output frames of 480,000 bytes, past the 1 MiB bound of other native phases.
 */
export function repositoryFixture(
  files: readonly { path: string; content: string | null }[] = [
    { path: 'net.mjs', content: fixtureContent('net.mjs') },
  ],
) {
  const start = fixture.indexOf("  if (message.method === 'turn/start' && mode === 'success') {");
  const end = fixture.indexOf('\n});', start);
  if (start < 0 || end < 0) throw new Error('The repository fixture template changed.');
  return (
    fixture
      .slice(0, start)
      .replace(
        "if (message.method === 'thread/start') result = thread(process.cwd());",
        "if (message.method === 'thread/start') result = {...thread(message.params.cwd),approvalPolicy:'never',sandbox:{type:'workspaceWrite',writableRoots:[message.params.cwd],networkAccess:false}};",
      ) +
    `
  if (message.method === 'thread/start') globalThis.scratch = message.params.cwd;
  if (message.method === 'turn/start' && mode === 'success') {
    const {mkdirSync,writeFileSync,rmSync} = require('node:fs');
    const {resolve,dirname,relative,isAbsolute} = require('node:path');
    for (const file of ${JSON.stringify(files)}) {
      const target = resolve(globalThis.scratch,file.path);
      const local = relative(globalThis.scratch,target);
      if (!local || local.startsWith('..') || isAbsolute(local)) throw new Error('Fixture path escapes scratch.');
      if (file.content === null) { rmSync(target); continue; }
      mkdirSync(dirname(target),{recursive:true});
      writeFileSync(target,file.content);
    }
    const identity = {threadId:'thread-1',turnId:'turn-1'};
    const command = {id:'command-1',type:'commandExecution',command:'fixture edit',cwd:globalThis.scratch,status:'inProgress',commandActions:[],aggregatedOutput:null,exitCode:null,durationMs:null};
    const change = {id:'change-1',type:'fileChange',changes:[],status:'inProgress'};
    for (const [method,params] of [
      ['turn/started',{threadId:'thread-1',turn:running}],
      ['item/started',{...identity,item:command,startedAtMs:1}],
      ...Array.from({length:3},()=>['item/commandExecution/outputDelta',{...identity,itemId:command.id,delta:'fixture output '.repeat(32000)}]),
      ['item/completed',{...identity,item:{...command,status:'completed',exitCode:0},completedAtMs:2}],
      ['item/started',{...identity,item:change,startedAtMs:3}],
      ['item/completed',{...identity,item:{...change,status:'completed'},completedAtMs:4}],
      ['turn/completed',{threadId:'thread-1',turn:{...running,status:'completed'}}],
    ]) process.stdout.write(JSON.stringify({method,params})+'\\n');
  }` +
    fixture.slice(end)
  );
}
