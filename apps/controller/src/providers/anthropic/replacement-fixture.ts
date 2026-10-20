/** Deterministic native-protocol output for controller and desktop claims. */
export function replacementFixture(
  args: readonly string[],
  options: {
    content: string;
    mode?: 'success' | 'hold' | 'overage' | 'quota' | 'auth-api';
  },
) {
  if (args[0] === 'auth')
    return `process.stdout.write(JSON.stringify({authMethod:${JSON.stringify(options.mode === 'auth-api' ? 'api_key' : 'claude.ai')}}));`;
  const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  const sessionId = args[args.indexOf('--session-id') + 1];
  const model = args[args.indexOf('--model') + 1];
  return `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
    const data=JSON.parse(input.slice(input.indexOf('\\n')+1));
    const init={type:'system',subtype:'init',session_id:${JSON.stringify(sessionId)},model:${JSON.stringify(model)},tools:[],mcp_servers:[]};
    console.log(JSON.stringify(init));
    ${options.mode === 'overage' ? `console.log(JSON.stringify({type:'rate_limit_event',session_id:init.session_id,uuid:init.session_id,rate_limit_info:{status:'allowed',isUsingOverage:true}}));` : ''}
    ${
      options.mode === 'quota'
        ? `console.log(JSON.stringify({type:'assistant',session_id:init.session_id,message:{role:'assistant',content:[]},is_api_error_message:true,api_error_status:429,api_error:'usage_limit_reached',api_error_origin:'first_party',api_error_params:{rate_limit_info:{status:'rejected',rateLimitType:'five_hour',resetsAt:1792000000}}}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,api_error_status:429,api_error:'usage_limit_reached',api_error_origin:'first_party',session_id:init.session_id}));`
        : options.mode === 'hold'
          ? `setInterval(()=>{},1000);`
          : `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:init.session_id,structured_output:{version:1,attemptId:${JSON.stringify(schema.properties.attemptId.const)},path:data.path,baseHash:data.baseHash,content:${JSON.stringify(options.content)}}}));`
    }
  });`;
}
