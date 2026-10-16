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
    const edit = {version:1,attemptId:message.params.outputSchema.properties.attemptId.const,path:'net.mjs',baseHash:message.params.outputSchema.properties.baseHash.const,content:'export function netMinor() { return 0; }\\n'};
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
