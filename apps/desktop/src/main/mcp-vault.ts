import { closeSync, constants, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createCommandKey } from '@crewkite/client/node';
import {
  type Command,
  CommandResultSchema,
  CommandSchema,
  McpPolicySchema,
  type McpServer,
  type McpServerInput,
  McpServerInputSchema,
  McpServerNameSchema,
  type McpState,
  type McpSupply,
} from '@crewkite/contracts';
import { type SecretStorage, storageUsable } from './local-token.ts';

export const NO_KEYCHAIN =
  'This device has no keychain that encrypts stored secrets, so a server with secret arguments or variables cannot be saved here.';

type Secret = { secretArgs: string[]; env: Record<string, string> };
type Stored = Omit<McpServer, 'secretArgs' | 'env'> & {
  secretArgCount: number;
  envKeys: string[];
  /** The secret arguments and variable values, sealed by safeStorage. Empty when there are none. */
  blob: string;
};
type File = {
  version: 1;
  servers: Stored[];
  threads: Record<string, Record<string, 'ask' | 'reads' | 'all'>>;
};

/**
 * The person's MCP servers on this device. Names, commands, plain arguments, tool lists and the
 * per-thread policies sit in one file in the desktop profile. Secret arguments and variable values
 * sit sealed by safeStorage, as the Local token does. Only supply() returns them, and only for the
 * controller port; state() is what the renderer sees.
 */
export class McpVault {
  private readonly path: string;
  private readonly storage: SecretStorage;
  constructor(profile: string, storage: SecretStorage) {
    this.path = join(profile, 'mcp-servers.json');
    this.storage = storage;
  }

  private load(): File {
    try {
      const text = readFileSync(this.path, { encoding: 'utf8' });
      if (text.length > 4 * 1024 * 1024) throw new Error('too large');
      const value = JSON.parse(text) as File;
      if (value?.version === 1 && Array.isArray(value.servers)) return value;
    } catch {}
    return { version: 1, servers: [], threads: {} };
  }

  private store(file: File) {
    const next = `${this.path}.next`;
    const handle = openSync(
      next,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
      0o600,
    );
    try {
      writeSync(handle, JSON.stringify(file));
    } finally {
      closeSync(handle);
    }
    renameSync(next, this.path);
  }

  private open(server: Stored): Secret | null {
    if (!server.blob) return { secretArgs: [], env: {} };
    if (!storageUsable(this.storage)) return null;
    try {
      return JSON.parse(this.storage.decryptString(Buffer.from(server.blob, 'base64'))) as Secret;
    } catch {
      return null;
    }
  }

  state(): McpState {
    const file = this.load();
    const encrypted = storageUsable(this.storage);
    return {
      encrypted,
      ...(encrypted ? {} : { reason: NO_KEYCHAIN }),
      servers: file.servers.map((server) => ({
        name: server.name,
        command: server.command,
        args: server.args,
        secretArgCount: server.secretArgCount,
        envKeys: server.envKeys,
        readTools: server.readTools,
      })),
      threads: file.threads,
    };
  }

  save(input: McpServerInput): McpState {
    const value = McpServerInputSchema.parse(input);
    const file = this.load();
    const old = file.servers.find((server) => server.name === value.name);
    const kept = value.keepSecrets && old ? this.open(old) : null;
    if (value.keepSecrets && old && !kept) throw new Error('The stored secrets cannot be read.');
    const secret: Secret = kept ?? { secretArgs: value.secretArgs, env: value.env };
    const secrets = secret.secretArgs.length + Object.keys(secret.env).length > 0;
    if (secrets && !storageUsable(this.storage)) throw new Error(NO_KEYCHAIN);
    const stored: Stored = {
      name: value.name,
      command: value.command,
      args: value.args,
      readTools: value.readTools,
      secretArgCount: secret.secretArgs.length,
      envKeys: Object.keys(secret.env),
      blob: secrets ? this.storage.encryptString(JSON.stringify(secret)).toString('base64') : '',
    };
    file.servers = [...file.servers.filter((server) => server.name !== value.name), stored];
    this.store(file);
    return this.state();
  }

  remove(name: string): McpState {
    const file = this.load();
    file.servers = file.servers.filter((server) => server.name !== name);
    for (const [taskId, policies] of Object.entries(file.threads)) {
      delete policies[name];
      if (!Object.keys(policies).length) delete file.threads[taskId];
    }
    this.store(file);
    return this.state();
  }

  setThread(taskId: string, name: string, policy: string | null): McpState {
    const file = this.load();
    McpServerNameSchema.parse(name);
    if (!file.servers.some((server) => server.name === name)) throw new Error('No such server.');
    const policies = { ...file.threads[taskId] };
    if (policy === null) delete policies[name];
    else policies[name] = McpPolicySchema.parse(policy);
    if (Object.keys(policies).length) file.threads[taskId] = policies;
    else delete file.threads[taskId];
    this.store(file);
    return this.state();
  }

  /** The resolved set for the controller. A server whose secrets cannot be opened is left out. */
  supply(): McpSupply {
    const file = this.load();
    const servers: McpServer[] = [];
    for (const server of file.servers) {
      const secret = this.open(server);
      if (!secret) continue;
      servers.push({
        name: server.name,
        command: server.command,
        args: server.args,
        readTools: server.readTools,
        secretArgs: secret.secretArgs,
        env: secret.env,
      });
    }
    return { servers, threads: file.threads };
  }
}

/** Gives the controller the resolved set. A read command: no receipt of the desktop holds it. */
export async function supplyMcp(
  vault: McpVault,
  command: (value: Command) => Promise<unknown>,
  actor: Command['actor'],
): Promise<boolean> {
  const result = CommandResultSchema.parse(
    await command(
      CommandSchema.parse({
        protocol: 1,
        key: createCommandKey(),
        actor,
        command: 'SupplyMcpServers',
        payload: vault.supply(),
      }),
    ),
  );
  return result.outcome === 'applied';
}
