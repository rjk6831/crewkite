import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { localOpenAiOrigin } from '@crewkite/contracts';
import type { LLMActionOpts, Tool } from '@lmstudio/sdk';
import { setup } from '../../store/controller-fixture.ts';
import {
  connectOpenAiModel,
  OUTSIDE_LOCAL_NETWORK,
  openAiModel,
  readOpenAiObservation,
} from './openai-compat.ts';

// A local server that speaks the OpenAI routes. Each chat request is recorded, and the answers
// are the scripted streams in order.
async function fakeServer(
  t: { after: (done: () => Promise<void>) => void },
  options: { models: object[]; props?: object; streams?: string[][] },
) {
  const chats: { messages: { role: string; content: string | null }[]; tools?: unknown }[] = [];
  const streams = [...(options.streams ?? [])];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ object: 'list', data: options.models }));
    }
    if (request.url === '/props' && options.props) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify(options.props));
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        chats.push(JSON.parse(body));
        response.setHeader('content-type', 'text/event-stream');
        for (const event of streams.shift() ?? []) response.write(`data: ${event}\n\n`);
        response.end('data: [DONE]\n\n');
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, chats };
}

const delta = (value: object, finish: string | null = null) =>
  JSON.stringify({ choices: [{ delta: value, finish_reason: finish }] });

// Claim: Local takes only an address on this machine or the local network, a name included once it
// resolves, and the window comes from the server when it reports one and from the smallest known
// default when it does not.
test('a Local endpoint stays on the local network and the window follows what the server reports', async (t) => {
  for (const [input, origin] of [
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['http://localhost:8080/v1/', 'http://localhost:8080'],
    ['http://192.168.1.20:8080', 'http://192.168.1.20:8080'],
    ['https://studio.local', 'https://studio.local'],
    ['http://8.8.8.8:8080', null],
    ['http://172.32.0.1:8080', null],
    ['http://example.com', null],
    ['http://user:pass@127.0.0.1:8080', null],
    ['http://127.0.0.1:8080/chat', null],
    ['ftp://127.0.0.1', null],
  ] as const)
    assert.equal(localOpenAiOrigin(input), origin, input);

  const reported = await fakeServer(t, {
    models: [{ id: 'qwen-coder' }, { id: 'llama' }],
    props: { default_generation_settings: { n_ctx: 16384 } },
  });
  const observed = await readOpenAiObservation(reported.endpoint);
  assert.deepEqual(
    observed.models.map((model) => [model.identity.modelKey, model.state, model.contextLength]),
    [
      ['qwen-coder', 'loaded-eligible', 16384],
      ['llama', 'loaded-eligible', 16384],
    ],
  );
  const silent = await fakeServer(t, { models: [{ id: 'small' }] });
  const connection = await connectOpenAiModel({ endpoint: silent.endpoint, model: 'other' });
  assert.equal(connection.contextLength, 4096);
  assert.equal(connection.modelKey, 'small');
  assert.equal(connection.fellBack, true);

  // A name can resolve anywhere, so every address it has must be local before anything is sent.
  // The fetch here carries the name's requests to the fake server.
  const named = 'http://studio.local:8080';
  const sent: string[] = [];
  const via: typeof fetch = (url, init) => {
    sent.push(String(url));
    return fetch(String(url).replace(named, reported.endpoint), init);
  };
  const resolving = (addresses: string[]) => async () => addresses;
  await assert.rejects(
    readOpenAiObservation(named, via, undefined, resolving(['192.168.1.20', '8.8.8.8'])),
    {
      message: OUTSIDE_LOCAL_NETWORK,
    },
  );
  assert.deepEqual(sent, []);
  const resolved = await readOpenAiObservation(named, via, undefined, resolving(['192.168.1.20']));
  assert.equal(resolved.models.length, 2);
});

// Claim: a streamed turn keeps the Local adapter's contract. Text arrives as fragments, a native
// tool call passes the guard before it runs, its result goes back to the server, and each round
// reports its own stop reason.
test('a streamed turn runs a guarded tool call and sends its result back', async (t) => {
  const { endpoint, chats } = await fakeServer(t, {
    models: [{ id: 'm' }],
    streams: [
      [
        delta({ content: 'Looking. ' }),
        delta({
          tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"path":' } }],
        }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, 'tool_calls'),
      ],
      [
        delta({ content: 'Done.' }, 'stop'),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 4 } }),
      ],
    ],
  });
  const seen: string[] = [];
  const stops: unknown[] = [];
  const tool = {
    type: 'rawFunction',
    name: 'read',
    description: 'Read a file.',
    parametersJsonSchema: { type: 'object', properties: { path: { type: 'string' } } },
    checkParameters: () => {},
    implementation: async (parameters: Record<string, unknown>) => {
      seen.push(`ran ${parameters.path}`);
      return 'file text';
    },
  } as unknown as Tool;
  const options = {
    maxPredictionRounds: 4,
    onPredictionFragment: (fragment: { content: string }) => seen.push(`text ${fragment.content}`),
    guardToolCall: async (_round: number, _call: number, guard: { allow: () => void }) => {
      seen.push('guarded');
      guard.allow();
    },
    onPredictionCompleted: (result: { stats: { stopReason: string } }) =>
      stops.push(result.stats.stopReason),
  } as unknown as LLMActionOpts;
  await openAiModel(endpoint, 'm').act([{ role: 'user', content: 'go' }], [tool], options);

  assert.deepEqual(seen, ['text Looking. ', 'guarded', 'ran a.ts', 'text Done.']);
  assert.deepEqual(stops, ['toolCalls', 'eosFound']);
  assert.equal(chats.length, 2);
  assert.deepEqual(
    chats[1].messages.slice(-1).map((message) => [message.role, message.content]),
    [['tool', 'file text']],
  );
});

// Claim: a tool call whose arguments do not read is answered with the error's own words when no
// handler gives an answer. The model never gets the word undefined back as a result.
test('a malformed tool call with no handler is answered with its error', async (t) => {
  const { endpoint, chats } = await fakeServer(t, {
    models: [{ id: 'm' }],
    streams: [
      [
        delta(
          {
            tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"path":' } }],
          },
          'tool_calls',
        ),
      ],
      [delta({ content: 'Sorry.' }, 'stop')],
    ],
  });
  const tool = {
    type: 'rawFunction',
    name: 'read',
    description: 'Read a file.',
    parametersJsonSchema: { type: 'object', properties: { path: { type: 'string' } } },
    checkParameters: () => {},
    implementation: async () => 'file text',
  } as unknown as Tool;
  const options = { maxPredictionRounds: 2 } as unknown as LLMActionOpts;
  await openAiModel(endpoint, 'm').act([{ role: 'user', content: 'go' }], [tool], options);
  const answer = chats[1]?.messages.at(-1);
  assert.equal(answer?.role, 'tool');
  assert.notEqual(answer?.content, 'undefined');
  assert.ok((answer?.content ?? '').length > 0);
});

// Claim: the Local card connects an OpenAI-compatible server with no token, lists its models and
// keeps the choice, with no helper window or client process.
test('Local connects an OpenAI-compatible endpoint and keeps the picked model', async (t) => {
  const { endpoint } = await fakeServer(t, { models: [{ id: 'a' }, { id: 'b' }] });
  const { controller, command } = await setup(t, {});
  const revision = () => controller.snapshot().localSetup?.revision ?? 0;
  const local = (name: string, payload: object = {}) =>
    controller.execute(command(name, payload, revision()), 'local-owner');

  assert.equal((await local('ConfigureLocal', { endpoint })).outcome, 'applied');
  assert.equal(controller.snapshot().localSetup?.authMode, 'none');
  assert.equal(
    (await local('BeginLocalConnectionInput', { consent: 'explicit' })).outcome,
    'applied',
  );
  await (controller as unknown as { openAiRead?: Promise<void> }).openAiRead;
  const read = controller.snapshot().localSetup;
  assert.equal(read?.connected, true);
  assert.equal(read?.reason, 'model-selection-required');
  const choice = read?.observation?.models.find((model) => model.identity.modelKey === 'b');
  assert(choice && read?.observation);
  await local('SelectLocalModel', {
    selectionId: choice.selectionId,
    observationHash: read.observation.observationHash,
  });
  assert.equal(controller.snapshot().localSetup?.reason, 'qualification-pending');
});
