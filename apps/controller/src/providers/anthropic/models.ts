import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { defaultSchedule, groupAbsent, type Schedule } from '../../host/worker.ts';
import { chatEnvironment, type Spawn, verifiedExecutable } from './chat.ts';

/** One row of the client's own model picker, as the account sees it now. */
export type AnthropicLiveModel = {
  /** The alias the client takes after --model. */
  value: string;
  /** The full model ID the alias resolves to now. */
  model: string;
  label: string;
  /** Empty when the client says the model takes no effort level. */
  efforts: readonly string[];
};

const row = z.object({
  value: z.string().min(1).max(200),
  resolvedModel: z.string().min(1).max(200).optional().catch(undefined),
  displayName: z.string().min(1).max(200).optional().catch(undefined),
  supportsEffort: z.boolean().optional().catch(undefined),
  supportedEffortLevels: z.array(z.string().max(32)).max(16).optional().catch(undefined),
});
const reply = z.object({
  type: z.literal('control_response'),
  response: z.object({
    subtype: z.literal('success'),
    request_id: z.literal('models'),
    response: z.object({ models: z.array(z.unknown()).max(64) }),
  }),
});
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Reads the picker rows the client keeps for this account. The stream-json initialize request
 * answers from local state and the account profile, so no prompt is sent and no inference runs.
 * The client has no list command, and `claude models` would be read as a prompt. Resolves to
 * null when the client does not answer within the limit, so the caller keeps its last rows.
 * Rows hold one alias for each family, so an older model ID still needs to be typed.
 */
export function readAnthropicModels(options: {
  executable: string;
  sha256: string;
  /** The controller's environment. Only the names chatEnvironment passes reach the client. */
  environment: NodeJS.ProcessEnv;
  /** A private folder for the client's working directory and its temporary files. */
  directory: string;
  spawn?: Spawn;
  schedule?: Schedule;
  timeoutMs?: number;
}): Promise<AnthropicLiveModel[] | null> {
  const schedule = options.schedule ?? defaultSchedule;
  return new Promise((resolve) => {
    let finished = false;
    let group = 0;
    let child: ReturnType<Spawn> | null = null;
    const cancels: Array<() => void> = [];
    const finish = (value: AnthropicLiveModel[] | null) => {
      if (finished) return;
      finished = true;
      for (const cancel of cancels) cancel();
      try {
        child?.stdin.end();
      } catch {}
      if (group > 0 && !groupAbsent(group))
        try {
          process.kill(-group, 'SIGKILL');
        } catch {}
      resolve(value);
    };
    try {
      if (!isAbsolute(options.directory)) throw new Error('directory');
      const executable = verifiedExecutable(options.executable, options.sha256);
      const temporary = join(options.directory, 'tmp');
      mkdirSync(temporary, { recursive: true, mode: 0o700 });
      child = (options.spawn ?? (spawn as Spawn))(
        executable,
        [
          '--print',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--setting-sources',
          '',
          '--settings',
          '{"disableAllHooks":true}',
        ],
        {
          cwd: options.directory,
          env: chatEnvironment(options.environment, temporary),
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch {
      return resolve(null);
    }
    group = child.pid ?? 0;
    cancels.push(schedule(() => finish(null), options.timeoutMs ?? 15_000));
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {});
    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      if (pending.length > MAX_BYTES) return finish(null);
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        const parsed = reply.safeParse(value);
        if (!parsed.success) continue;
        const models: AnthropicLiveModel[] = [];
        for (const raw of parsed.data.response.response.models) {
          const entry = row.safeParse(raw);
          if (!entry.success) continue;
          const { value: alias, resolvedModel, displayName, supportsEffort } = entry.data;
          models.push({
            value: alias,
            model: resolvedModel ?? alias,
            label: displayName ?? resolvedModel ?? alias,
            efforts: supportsEffort ? (entry.data.supportedEffortLevels ?? []) : [],
          });
        }
        return finish(models.length ? models : null);
      }
    });
    try {
      child.stdin.write(
        `${JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } })}\n`,
      );
    } catch {
      finish(null);
    }
  });
}
