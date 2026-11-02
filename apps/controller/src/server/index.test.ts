import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { connectController, readControllerEndpoint } from '@crewkite/client/node';
import { type CommandResult, CommandSchema } from '@crewkite/contracts';
import type { ControllerOptions } from '../commands/controller.ts';
import { checkOwner } from '../host/check-ownership.ts';
import { digestHeldFile, fileDigestSync } from '../providers/file-digest.ts';
import {
  unavailableNativeProfile,
  unavailableRepositoryProfile,
} from '../providers/openai/profile.ts';
import { acknowledgeGoogleTerms, setup } from '../store/controller-fixture.ts';
import { serve } from './index.ts';

test('workspace reads hash each client once per file identity and never leave a Local command outcome unknown during a Google install', async (t) => {
  const root = mkdtempSync(join(realpathSync(checkOwner()?.stateRoot ?? tmpdir()), 'ck-line-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The second variant makes each fresh hash cost what a cold 250 MB client costs on the Mac. The
  // delay is real because the loop stall is the thing under test.
  for (const [variant, holdMs] of [
    ['warm', 0],
    ['cold', 300],
  ] as const) {
    const folder = join(root, variant);
    const clients = [join(root, `${variant}-openai`), join(root, `${variant}-anthropic`)];
    for (const client of clients) writeFileSync(client, randomBytes(1024 * 1024));
    const reads = new Map<string, number>();
    const read = (path: string, identity: string) => {
      reads.set(`${path} ${identity}`, (reads.get(`${path} ${identity}`) ?? 0) + 1);
      if (holdMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
      return digestHeldFile(path, identity);
    };
    const fetching = Promise.withResolvers<void>();
    const options: Partial<ControllerOptions> = {
      home: join(folder, 'home'),
      googleUsageClient: () => ({ available: false, reason: 'client-unavailable' }),
      nativeProfiles: () => {
        for (const client of clients) fileDigestSync(client, { read });
        return [unavailableNativeProfile(), unavailableRepositoryProfile()];
      },
      // The install holds at its download, so it is running for every command below.
      googleAcpInstall: {
        fetch: (async (_url: unknown, init?: RequestInit) => {
          fetching.resolve();
          await new Promise<void>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(Error('cancelled')), {
              once: true,
            }),
          );
          throw Error('No download result was expected.');
        }) as typeof fetch,
      },
    };
    const context = await setup(t, options);
    await acknowledgeGoogleTerms(context);
    const { controller } = context;
    const server = await serve(controller);
    t.after(() => server.close());
    const client = await connectController({
      ...readControllerEndpoint(controller.home),
      actor: { id: 'terminal', kind: 'cli' },
    });
    t.after(() => client.close());
    const send = (name: string, payload: unknown, revision?: number) =>
      client.command(CommandSchema.parse(context.command(name, payload, revision)));
    const install = send(
      'InstallGoogleAcp',
      { profileId: 'google-acp-v1', consent: 'explicit' },
      0,
    );
    void install.catch(() => {});
    await fetching.promise;
    const answers: [string, CommandResult][] = [];
    const revision = () => controller.snapshot().localSetup?.revision ?? 0;
    for (const [name, payload] of [
      ['ConfigureLocal', { endpoint: 'ws://127.0.0.1:9', authMode: 'none' }],
      ['BeginLocalConnectionInput', { consent: 'explicit' }],
      ['RefreshLocalModels', { consent: 'explicit' }],
    ] as const) {
      const before = [0, 1].map(() => send('GetWorkspaceState', {}));
      const local = send(name, payload, revision());
      const after = [0].map(() => send('GetWorkspaceState', {}));
      for (const [index, result] of (await Promise.all([...before, local, ...after])).entries())
        answers.push([index === before.length ? name : 'GetWorkspaceState', result]);
    }
    answers.push(['GetWorkspaceState', await send('GetWorkspaceState', {})]);
    assert.equal(answers.filter(([name]) => name === 'GetWorkspaceState').length, 10);
    assert.deepEqual(
      answers.filter(([, result]) => result.outcome === 'outcome-unknown'),
      [],
      variant,
    );
    assert.equal(answers.find(([name]) => name === 'ConfigureLocal')?.[1].outcome, 'applied');
    assert.deepEqual([...reads.values()], [1, 1], variant);
  }
});
