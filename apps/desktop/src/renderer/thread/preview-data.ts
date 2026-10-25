import type {
  AgentEvent,
  ChatCatalogRead,
  ChatFailure,
  ChatModelSelection,
} from '@crewkite/contracts';

// Fixtures for the scripted preview thread. Model names are placeholders. The preview never names a
// real model.

export const DIFF = [
  'diff --git a/net.mjs b/net.mjs',
  '--- a/net.mjs',
  '+++ b/net.mjs',
  '@@ -1,3 +1,6 @@',
  '-export function netMinor() {',
  "-  throw new Error('netMinor is not implemented.');",
  '+export function netMinor(subtotalMinor, discountMinor) {',
  '+  if (![subtotalMinor, discountMinor].every((value) => Number.isSafeInteger(value) && value >= 0)) {',
  "+    throw new RangeError('Amounts must be non-negative safe integers.');",
  '+  }',
  '+  return Math.max(0, subtotalMinor - discountMinor);',
  ' }',
].join('\n');

export const familyNames = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  local: 'Local',
} as const;

export const BASE = '3f2a9c14d0b7e58a61c2f9047d3be1a85c60e2d7';
export const SELECTION: ChatModelSelection = {
  family: 'anthropic',
  model: 'large-2',
  effort: 'medium',
};
export const FIRST_SELECTION: ChatModelSelection = {
  family: 'openai',
  model: 'large-1',
  effort: 'medium',
};

export function usageLimit(): ChatFailure {
  return {
    stage: 'prompt',
    kind: 'usage-limit',
    message: 'OpenAI stopped this turn. The five-hour limit is reached.',
    providerMessage: 'You have reached your five-hour usage limit. Try again after it resets.',
    method: 'turn/start',
    code: 429,
    resetsAt: new Date(Date.now() + 100 * 60_000).toISOString(),
    nextAction: 'Continue on another provider, or wait for the reset.',
  };
}

export function catalog(): ChatCatalogRead {
  const now = Date.now();
  const reading = (windowId: string, label: string, percent: number, minutes: number) => ({
    windowId,
    label,
    percent,
    resetsAt: new Date(now + minutes * 60_000).toISOString(),
    observedAt: new Date(now - 60_000).toISOString(),
  });
  const pair = (large: string, fast: string) => [
    {
      model: large,
      label: label(large),
      efforts: ['low', 'medium', 'high'] as const,
      defaultEffort: 'medium' as const,
    },
    {
      model: fast,
      label: label(fast),
      efforts: ['low', 'medium'] as const,
      defaultEffort: 'low' as const,
    },
  ];
  const label = (model: string) =>
    model.replace(/^./, (first) => first.toUpperCase()).replace('-', ' ');
  const fill = (models: ReturnType<typeof pair>) =>
    models.map((m) => ({ ...m, efforts: [...m.efforts] }));
  return {
    families: [
      {
        family: 'openai',
        connected: true,
        reason: null,
        models: fill(pair('large-1', 'fast-1')),
        defaultModel: 'large-1',
        remaining: [
          reading('five-hour', 'Five-hour', 0, 100),
          reading('weekly', 'Weekly', 80, 2880),
        ],
        accepts: null,
      },
      {
        family: 'anthropic',
        connected: true,
        reason: null,
        models: fill(pair('large-2', 'fast-2')),
        defaultModel: 'large-2',
        remaining: [reading('weekly', 'Weekly', 30, 120)],
        accepts: null,
      },
      {
        family: 'google',
        connected: false,
        reason: 'Sign in to the Google client to use it.',
        models: [],
        defaultModel: null,
        remaining: [],
        accepts: null,
      },
      {
        family: 'local',
        connected: true,
        reason: null,
        models: [{ model: 'local-27b', label: 'Local 27B', efforts: [], defaultEffort: 'default' }],
        defaultModel: 'local-27b',
        remaining: [],
        accepts: null,
      },
    ],
  };
}

/** The turn in progress when the preview thread opens: it has edited a file and asks to run tests. */
export function openingEvents(turnId: string, selection: ChatModelSelection): AgentEvent[] {
  const t = turnId;
  return [
    {
      type: 'turn.started',
      turnId: t,
      family: selection.family,
      model: selection.model,
      effort: selection.effort,
      role: 'assistant',
    },
    {
      type: 'thinking.delta',
      turnId: t,
      itemId: 'th1',
      text: 'The request names net.mjs, so I read it first.\nAmounts are minor units, so safe integers only.',
    },
    {
      type: 'tool.started',
      turnId: t,
      callId: 'c1',
      kind: 'read',
      title: 'Read net.mjs',
      input: { path: 'net.mjs' },
    },
    {
      type: 'tool.output',
      turnId: t,
      callId: 'c1',
      chunk:
        "export function netMinor() {\n  throw new Error('netMinor is not implemented.');\n}\n",
    },
    { type: 'tool.completed', turnId: t, callId: 'c1', status: 'ok' },
    {
      type: 'text.delta',
      turnId: t,
      itemId: 'a1',
      text: 'netMinor is a stub today. I am replacing it with a version that checks both inputs are non-negative safe integers and returns the subtotal minus the discount, never below zero.',
    },
    {
      type: 'tool.started',
      turnId: t,
      callId: 'c2',
      kind: 'edit',
      title: 'Edit net.mjs',
      input: { path: 'net.mjs' },
    },
    {
      type: 'tool.completed',
      turnId: t,
      callId: 'c2',
      status: 'ok',
      diff: { path: 'net.mjs', additions: 5, deletions: 2, patch: DIFF },
    },
    {
      type: 'permission.requested',
      turnId: t,
      requestId: 'p1',
      callId: 'c3',
      question: 'Run the tests in the scratch copy?',
      detail: 'node --test',
      options: [
        { id: 'once', label: 'Allow once', kind: 'allow-once' },
        { id: 'thread', label: 'Allow for this thread', kind: 'allow-thread' },
        { id: 'deny', label: 'Deny', kind: 'deny' },
      ],
    },
    { type: 'usage.context', turnId: t, usedTokens: 18_400, capacityTokens: 200_000 },
  ];
}

export const TEST_OUTPUT = [
  'TAP version 13',
  '# netMinor accepts safe integers',
  'ok 1 - returns 2500 for 3000 and 500',
  'ok 2 - returns 0 for 3000 and 4000',
  'ok 3 - rejects negative and fractional input',
  '# pass 3',
  '# fail 0',
];
