import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type OnboardingInput,
  type OnboardingStep,
  onboardingView,
  type SetupState,
  stepAfter,
} from './flow.ts';

const setup = (
  connected: string[],
  over: Partial<Omit<SetupState, 'families'>> = {},
): SetupState => ({
  families: (['openai', 'anthropic', 'google', 'local'] as const).map((family) => ({
    family,
    connected: connected.includes(family),
  })),
  googleTermsAcknowledged: false,
  projectCount: 0,
  projectsWithThreads: 0,
  ...over,
});

test('the welcome shows the step the setup allows and ends for anyone who already works here', () => {
  const base: OnboardingInput = {
    flag: 'open',
    setup: setup([]),
    engaged: false,
    reached: 'provider',
  };
  const rows: [
    string,
    Partial<OnboardingInput>,
    (
      | { visible: false; reason: string }
      | { step: OnboardingStep; canContinue: boolean; skip: string }
    ),
  ][] = [
    ['the flag is not read yet', { flag: 'unread' }, { visible: false, reason: 'loading' }],
    ['the catalog is not read yet', { setup: null }, { visible: false, reason: 'loading' }],
    ['it already ended', { flag: 'finished' }, { visible: false, reason: 'finished' }],
    [
      'a first launch with nothing set up',
      {},
      { step: 'provider', canContinue: false, skip: 'Skip for now' },
    ],
    [
      'a family is ready',
      { setup: setup(['openai']) },
      { step: 'provider', canContinue: true, skip: 'Skip' },
    ],
    [
      'Google is connected and its terms are not acknowledged',
      { setup: setup(['google']) },
      { step: 'provider', canContinue: false, skip: 'Skip for now' },
    ],
    [
      'Google is connected and its terms are acknowledged',
      { setup: setup(['google'], { googleTermsAcknowledged: true }) },
      { step: 'provider', canContinue: true, skip: 'Skip' },
    ],
    [
      'a project and a ready family, never shown before',
      { setup: setup(['local'], { projectCount: 1 }) },
      { visible: false, reason: 'existing-user' },
    ],
    [
      'a project and a ready family, asked for again from Settings',
      { setup: setup(['local'], { projectCount: 1 }), engaged: true },
      { step: 'provider', canContinue: true, skip: 'Skip' },
    ],
    [
      'threads exist and the sign-in has lapsed',
      { setup: setup([], { projectCount: 1, projectsWithThreads: 1 }) },
      { visible: false, reason: 'existing-user' },
    ],
    [
      'a project with no ready family',
      { setup: setup([], { projectCount: 1 }) },
      { step: 'provider', canContinue: false, skip: 'Skip for now' },
    ],
    [
      'on the project step with a ready family and no project',
      { setup: setup(['openai']), reached: 'project', engaged: true },
      { step: 'project', canContinue: false, skip: 'Skip' },
    ],
    [
      'the project is added during the flow',
      { setup: setup(['openai'], { projectCount: 1 }), reached: 'project', engaged: true },
      { step: 'project', canContinue: true, skip: 'Skip' },
    ],
    [
      'the last step',
      { setup: setup(['openai'], { projectCount: 1 }), reached: 'message', engaged: true },
      { step: 'message', canContinue: true, skip: 'Skip' },
    ],
    [
      'the family disconnects after the person moved on',
      { setup: setup([], { projectCount: 1 }), reached: 'message', engaged: true },
      { step: 'provider', canContinue: false, skip: 'Skip for now' },
    ],
    [
      'the last step without a project',
      { setup: setup(['openai']), reached: 'message', engaged: true },
      { step: 'project', canContinue: false, skip: 'Skip' },
    ],
  ];
  for (const [name, change, expected] of rows) {
    const view = onboardingView({ ...base, ...change });
    if ('visible' in expected) {
      assert.deepEqual(view, expected, name);
      continue;
    }
    assert.ok(view.visible, name);
    assert.equal(view.step, expected.step, name);
    assert.equal(view.canContinue, expected.canContinue, name);
    assert.equal(view.skipLabel, expected.skip, name);
  }
  assert.equal(stepAfter('provider'), 'project');
  assert.equal(stepAfter('message'), 'message');
});
