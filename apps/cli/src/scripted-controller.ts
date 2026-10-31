import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { AnthropicNativeProfileSchema } from '@crewkite/contracts';
import {
  type ChatScriptStep,
  createScriptedChatAdapter,
} from '../../../packages/testkit/src/chat-adapter.ts';
import { createDemoFixtures } from '../../../packages/testkit/src/index.ts';
import { createSyntheticRepository } from '../../../packages/testkit/src/repository.ts';
import { Controller, type ControllerOptions } from '../../controller/src/commands/controller.ts';
import { unavailableNativeProfile } from '../../controller/src/providers/openai/profile.ts';
import { serve } from '../../controller/src/server/index.ts';

// A real controller on a private socket, with the scripted chat adapter in place of a provider
// client. CLI tests drive it through the same socket client a terminal uses. No provider runs.

const scriptedProfile = {
  facts: AnthropicNativeProfileSchema.parse({
    id: 'anthropic-file-v1',
    family: 'anthropic',
    displayName: 'Scripted chat',
    clientVersion: '0.0.0',
    model: 'fixture-model',
    effort: 'medium',
    effectiveEffort: 'unknown',
    accountClass: 'unknown',
    serviceTier: 'unknown',
    billingBasis: 'requires-user-attestation',
    qualifiedAt: null,
    creditPolicies: ['ordinary'],
    maximumTaskMs: 300000,
    maximumFileBytes: 65536,
    maximumSubmissions: 1,
    available: true,
    reason: 'available',
  }),
};

export async function startScriptedController(
  t: TestContext,
  turns: readonly (readonly ChatScriptStep[])[],
  options: Pick<ControllerOptions, 'gitState'> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-cli-'));
  const home = join(directory, 'home');
  const repository = createSyntheticRepository(join(directory, 'shop')).directory;
  const fixtures = createDemoFixtures(new Date(0).toISOString());
  const controller = new Controller({
    ...options,
    home,
    routes: fixtures.snapshot.routes,
    observations: fixtures.snapshot.usage.map((window) => window.observation),
    identity: { name: 'Fixture owner', email: 'owner@example.invalid' },
    nativeProfiles: () => [unavailableNativeProfile(), scriptedProfile],
    // The scripted adapter takes any model. These rows stand in for the client's picker.
    anthropicModels: [
      { value: 'model-a', model: 'model-a', label: 'Scripted model A', efforts: ['low', 'high'] },
      { value: 'model-b', model: 'model-b', label: 'Scripted model B', efforts: [] },
    ],
    nativeSpawn: () => {
      throw new Error('The scripted chat starts no provider client.');
    },
    chatAdapters: new Map([
      ['anthropic', createScriptedChatAdapter({ family: 'anthropic', turns }) as never],
    ]),
  });
  chmodSync(home, 0o700);
  const server = await serve(controller);
  let closing: Promise<void> | undefined;
  // Stops the controller once, whether a test ends it early or the test ends.
  const stop = () => {
    closing ??= (async () => {
      await server.close();
      await controller.close();
    })();
    return closing;
  };
  t.after(async () => {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return { home, repository, controller, directory, stop };
}
