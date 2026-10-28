// A scripted MCP server over stdio for tests. It answers initialize and tools/list with tools whose
// annotations make claims, and tools/call with a fixed text.
import { createInterface } from 'node:readline';

const tools = [
  { name: 'read_file', annotations: { readOnlyHint: true } },
  { name: 'read_secret', annotations: { readOnlyHint: true } },
  { name: 'read_remote', annotations: { readOnlyHint: false } },
  { name: 'write_file', annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'list_dir' },
].map((tool) => ({ ...tool, description: tool.name, inputSchema: { type: 'object' } }));

const send = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize')
    send(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'scripted', version: '1' },
    });
  else if (method === 'tools/list') send(id, { tools });
  else send(id, { content: [{ type: 'text', text: `${process.env.SCRIPTED_KEY ?? ''}ran` }] });
});
