/** Deterministic native output for controller and desktop claims. */
export function replacementFixture(
  args: readonly string[],
  options: {
    content: string;
    permissionMode?: 'request-review' | 'strict' | 'always-proceed' | 'proceed-in-sandbox';
    mode?: 'success' | 'hold' | 'credits' | 'mode-mismatch' | 'config-error';
  },
) {
  const mode = options.permissionMode ?? 'request-review';
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
  };
  if (args[0] === '-p')
    return `console.log(JSON.stringify({status:${JSON.stringify(options.mode === 'config-error' ? 'ERROR' : 'SUCCESS')},num_turns:0,usage:${JSON.stringify(usage)},command:{data:{config:{toolPermission:${JSON.stringify(options.mode === 'mode-mismatch' ? (mode === 'strict' ? 'request-review' : 'strict') : mode)},useG1Credits:${options.mode === 'credits'}}}}}));`;
  const model = args[args.indexOf('--model') + 1];
  const prompt = args[args.indexOf('--print') + 1];
  const file = JSON.parse(prompt.slice(prompt.indexOf('\nFile: ') + '\nFile: '.length));
  return `const session='fixture-session';console.log(JSON.stringify({event:'init',conversation_id:session,init:{cwd:process.cwd(),model:${JSON.stringify(model)},permission_mode:${JSON.stringify(mode)},tools:[]}}));
    ${options.mode === 'hold' ? 'setInterval(()=>{},1000);' : `console.log(JSON.stringify({event:'result',result:{conversation_id:session,status:'SUCCESS',response:'',duration_seconds:0,num_turns:1,usage:${JSON.stringify(usage)},structured_output:{...${JSON.stringify(file)},content:${JSON.stringify(options.content)}}}}));`}`;
}
