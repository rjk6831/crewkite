import type { ThreadReads } from '../thread-reader.ts';

// A fixed thread for the thread tools tests. Each read carries one value the redaction must
// change, so a test can prove it never crosses as written.

export const fixtureThread = 'tsk_01M51M322B2AEBXD9MA74CBCFM';
export const fixtureTurn = 'trn_01M51M322B2AEBXD9MA74CBCFM';
export const fixtureSecrets = [
  'sk-live0123456789abcdef',
  'Bearer eyJhbGciOiJIUzI1NiJ9.payload',
  'GITHUB_TOKEN=ghp_0123456789abcdef',
] as const;

const trace = [
  { kind: 'command' as const, title: 'Run tests', target: 'pnpm test', outcome: 'ok' as const },
];

export function fixtureReader(overrides: Partial<ThreadReads> = {}): ThreadReads {
  return {
    turns: (args) => ({
      turns: [
        {
          id: fixtureTurn,
          sequence: 1,
          family: args.family ?? 'anthropic',
          model: 'fixture-model',
          role: 'assistant' as const,
          status: 'done' as const,
          startedAt: '2026-10-28T00:00:00.000Z',
          endedAt: '2026-10-28T00:01:00.000Z',
          reply: `Set the key with ${fixtureSecrets[0]} and run it.`,
          changedFiles: 2,
        },
      ].slice(0, args.limit),
    }),
    turn: (args) => ({
      id: args.id,
      reply: `The call sent Authorization: ${fixtureSecrets[1]} to the API.`,
      truncated: false,
      trace,
      files: ['src/index.ts'],
    }),
    diff: () => ({
      diff: `--- a/.env\n+++ b/.env\n@@ -0,0 +1 @@\n+${fixtureSecrets[2]}\n`,
      more: null,
    }),
    checks: () => ({ lines: ['pnpm test passed', `export API_KEY="${fixtureSecrets[0]}"`] }),
    live: () => ({
      state: 'running' as const,
      turnId: fixtureTurn,
      family: 'openai' as const,
      model: 'fixture-model',
      role: 'reviewer' as const,
      elapsedMs: 4200,
      text: `Reading ${fixtureSecrets[2]}`,
      trace,
    }),
    ...overrides,
  };
}
