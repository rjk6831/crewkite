import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connectController, readControllerEndpoint } from '@crewkite/client/node';
import { TaskIdSchema } from '@crewkite/contracts';
import { BundleSchema, captureContext, MAX_MESSAGE_BYTES, writePrivate } from './connector.ts';

export async function prepare(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      home: { type: 'string' },
      task: { type: 'string' },
      workspace: { type: 'string' },
      client: { type: 'string' },
      'expires-at': { type: 'string' },
      'share-task-context': { type: 'boolean' },
    },
  });
  if (!values.home || !values.workspace || !values['expires-at'] || !values['share-task-context'])
    throw new Error('Supply --home, --task, --workspace, --expires-at and --share-task-context.');
  if (values.client !== 'cli' && values.client !== 'app')
    throw new Error('Select --client cli or --client app.');
  const taskId = TaskIdSchema.parse(values.task);
  const expiresAt = values['expires-at'];
  const remaining = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 3600000)
    throw new Error('Choose an expiry within the next hour.');
  const home = realpathSync(values.home);
  const requested = resolve(values.workspace);
  const workspace = join(realpathSync(dirname(requested)), basename(requested));
  const client = await connectController({
    ...readControllerEndpoint(home),
    actor: { id: 'google-native-context', kind: 'cli' },
    reconnectDelaysMs: [],
  });
  try {
    const context = await captureContext(client, taskId);
    const bundle = BundleSchema.parse({ version: 1, home, workspace, expiresAt, ...context });
    if (Date.now() >= Date.parse(expiresAt))
      throw new Error('The selected expiry elapsed during preparation.');
    const bytes = `${JSON.stringify(bundle)}\n`;
    if (Buffer.byteLength(bytes) > MAX_MESSAGE_BYTES)
      throw new Error('The encoded context exceeds the connector file bound.');
    // A fresh directory keeps this opt-in from changing an existing workspace or plugin.
    mkdirSync(workspace, { mode: 0o700 });
    writePrivate(join(workspace, '.gitignore'), '*\n');
    const state = join(workspace, '.crewkite-context');
    mkdirSync(state, { mode: 0o700 });
    const path = join(state, 'capability.json');
    writePrivate(path, bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const configuration =
      values.client === 'app'
        ? join(workspace, '.agents/plugins/crewkite-context')
        : join(workspace, '.agents');
    mkdirSync(configuration, { recursive: true, mode: 0o700 });
    if (values.client === 'app')
      writePrivate(
        join(configuration, 'plugin.json'),
        `${JSON.stringify(
          {
            name: 'crewkite-context',
            description: 'Read one explicitly shared CrewKite task and save one unverified result.',
          },
          null,
          2,
        )}\n`,
      );
    writePrivate(
      join(configuration, 'mcp_config.json'),
      `${JSON.stringify(
        {
          mcpServers: {
            'crewkite-context': {
              command: realpathSync(process.execPath),
              args: [
                fileURLToPath(new URL('./connector.ts', import.meta.url)),
                '--mcp',
                path,
                digest,
              ],
              cwd: workspace,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    return {
      workspace,
      client: values.client,
      configuration,
      taskId,
      revision: bundle.binding.task.revision,
      runId: bundle.binding.run.id,
      expiresAt,
      result: join(state, 'result.unverified.json'),
      inferenceStarted: false,
      status: 'prepared-source-only',
    };
  } finally {
    client.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  prepare(process.argv.slice(2))
    .then((value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`))
    .catch(() => {
      process.stderr.write(
        'Context preparation failed. Use a current task, a fresh scratch workspace and an expiry within one hour.\n',
      );
      process.exitCode = 1;
    });
