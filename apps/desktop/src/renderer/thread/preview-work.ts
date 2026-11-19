import type {
  AcceptanceAttempt,
  ChatCheckRun,
  ChatPlanState,
  ChatThread,
  CommandResult,
  DependencyPreparation,
  RemoteEffect,
} from '@crewkite/contracts';
import { preparedCopy } from './preview-accept.ts';

// The Work tab in the browser preview. A `state` query parameter that starts with work- picks
// one: work-queued, work-running, work-blocked and work-finished. Each starts the demo thread on
// a four-slice plan in that state, with the checks each slice ran and the records the tab reads
// beside the thread, in the shapes the controller writes. work-held starts it held by a check
// whose process CrewKite lost track of, and Release the thread opens the panel that releases it.
// Nothing leaves the window.

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const mint = (prefix: string, n: number) => `${prefix}_0${String(n).padStart(25, '0')}`;
const hex = (digit: string, length: number) => digit.repeat(length);
const BRANCH = 'feat/net-minor';
const HEAD = 'c41f9a2e7b0d58361fa2c9e04b7d3a1586e2f09c';

const OPENAI = { family: 'openai', model: 'large-1', effort: 'medium' } as const;
const ANTHROPIC = { family: 'anthropic', model: 'large-2', effort: 'medium' } as const;
const GOOGLE = { family: 'google', model: 'large-3', effort: 'medium' } as const;
const CREW: NonNullable<ChatThread['crew']> = {
  name: 'Full crew',
  members: [
    { role: 'builder', selection: OPENAI },
    { role: 'reviewer', selection: ANTHROPIC },
    { role: 'fixer', selection: GOOGLE },
    { role: 'orchestrator', selection: ANTHROPIC },
  ],
};

type Slice = ChatPlanState['slices'][number];
const SLICES: [string, Slice['difficulty'], number[], typeof OPENAI | typeof GOOGLE][] = [
  ['Add netMinor to net.mjs', 'medium', [], OPENAI],
  ['Reject negative and fractional input in cart.mjs', 'medium', [], GOOGLE],
  ['Test netMinor and the input checks', 'easy', [1, 2], OPENAI],
  ['Describe netMinor in the README', 'easy', [3], GOOGLE],
];

function plan(
  phase: ChatPlanState['phase'],
  statuses: Slice['status'][],
  lane?: Slice['lane'],
): ChatPlanState {
  return {
    planId: 'net-minor',
    orchestratorTurnId: mint('trn', 90),
    goal: 'Add netMinor(subtotalMinor, discountMinor) to net.mjs, reject bad input and cover both with tests.',
    phase,
    slices: SLICES.map(([title, difficulty, depends, selection], index) => ({
      id: index + 1,
      title,
      difficulty,
      depends,
      readOnly: false,
      status: statuses[index],
      assignment: {
        family: selection.family,
        model: selection.model,
        reason: difficulty === 'easy' ? 'Builder, easy slice' : "Builder, the crew's model",
      },
      candidates: [],
      turnId:
        statuses[index] === 'queued' || statuses[index] === 'not-run'
          ? null
          : mint('trn', 91 + index),
      ...(statuses[index] === 'running' && lane ? { lane } : {}),
    })),
  };
}

const ITEMS: NonNullable<ChatThread['checks']>['items'] = [
  ['test', 'test', 'node --test'],
  ['lint', 'lint', 'biome check .'],
].map(([id, label, resolved]) => ({
  id: `package.json:${id}`,
  label,
  kind: id === 'test' ? 'test' : 'lint',
  source: 'package.json',
  command: `npm run ${id}`,
  resolved,
  enabled: true,
  pin: hex('b', 64),
}));

let runs = 0;
/** A finished run that started `minutes` ago and took `seconds`. */
function run(
  slice: number,
  trigger: 'after-write' | 'combined',
  check: 'test' | 'lint',
  status: ChatCheckRun['status'],
  minutes: number,
  seconds = 4,
): ChatCheckRun {
  return {
    id: `chk_${String(++runs).padStart(32, '0')}`,
    checkId: `package.json:${check}`,
    label: check,
    command: `npm run ${check}`,
    trigger,
    slice,
    status,
    reason: status === 'failed' ? 'Exit code 1.' : null,
    startedAt: ago(minutes * 60_000),
    durationMs: status === 'running' ? null : seconds * 1000,
    exitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : null,
    tail: status === 'failed' ? 'not ok 3 - netMinor rejects a fractional discount' : '',
    stdout: null,
    stderr: null,
  };
}

/** The same run started by Run tests, outside any plan slice. */
const manual = ({ slice: _slice, ...value }: ChatCheckRun): ChatCheckRun => ({
  ...value,
  trigger: 'manual',
});

// The controller keeps the nine newest runs, so a long plan shows only its later slices' gates.
function scene(state: string): Partial<ChatThread> | null {
  const checks = (list: ChatCheckRun[]) => ({
    items: ITEMS,
    ask: null,
    approved: hex('c', 64),
    runs: list,
    detectedAt: ago(40 * 60_000),
  });
  const base = { crew: CREW, selection: OPENAI, scratchReady: true };
  switch (state) {
    case 'work-queued':
      return {
        ...base,
        flightMode: 'balanced',
        plan: plan('proposed', ['queued', 'queued', 'queued', 'queued']),
      };
    case 'work-running':
      return {
        ...base,
        flightMode: 'glide',
        plan: plan('running', ['done', 'running', 'queued', 'queued'], {
          step: 'fix',
          pending: false,
          rounds: 1,
          fixes: 1,
          build: mint('trn', 92),
        }),
        checks: checks([
          run(1, 'after-write', 'test', 'passed', 14),
          run(1, 'after-write', 'lint', 'passed', 14, 2),
          run(1, 'combined', 'test', 'passed', 9),
          run(1, 'combined', 'lint', 'passed', 9, 2),
          run(2, 'after-write', 'test', 'failed', 6),
          run(2, 'after-write', 'lint', 'passed', 6, 2),
        ]),
      };
    case 'work-blocked':
      return {
        ...base,
        flightMode: 'glide',
        plan: plan('stopped', ['done', 'failed', 'not-run', 'not-run']),
        checks: checks([
          run(1, 'after-write', 'test', 'passed', 30),
          run(1, 'combined', 'test', 'passed', 26),
          run(2, 'after-write', 'test', 'failed', 22),
          run(2, 'after-write', 'lint', 'passed', 22, 2),
          run(2, 'after-write', 'test', 'failed', 15),
          run(2, 'after-write', 'test', 'failed', 8),
        ]),
      };
    case 'work-finished':
      return {
        ...base,
        flightMode: 'glide',
        plan: plan('finished', ['done', 'done', 'done', 'done']),
        checks: checks([
          run(1, 'combined', 'test', 'passed', 38),
          run(2, 'combined', 'test', 'passed', 31),
          run(3, 'after-write', 'test', 'passed', 24),
          run(3, 'after-write', 'lint', 'passed', 24, 2),
          run(3, 'combined', 'test', 'passed', 19),
          run(4, 'after-write', 'test', 'passed', 12),
          run(4, 'after-write', 'lint', 'passed', 12, 2),
          run(4, 'combined', 'test', 'passed', 7),
          run(4, 'combined', 'lint', 'passed', 7, 2),
        ]),
      };
    // The controller restarted while Run tests ran, before the check recorded its process.
    case 'work-held':
      return {
        ...base,
        flightMode: 'balanced',
        ownershipUnknown: true,
        checks: checks([
          manual(run(1, 'combined', 'test', 'passed', 30)),
          {
            ...manual(run(1, 'combined', 'test', 'unknown', 12)),
            reason: 'CrewKite restarted while this check ran. Its process may still be running.',
          },
        ]),
      };
    default:
      return null;
  }
}

export type WorkPreview = {
  /** The thread fields the state starts from. Null outside the Work states. */
  thread: Partial<ChatThread> | null;
  command: (name: string, payload: Record<string, unknown>) => CommandResult | null;
};

export function workPreview(state: string | null, taskId: string): WorkPreview {
  const thread = state?.startsWith('work-') ? scene(state) : null;
  if (!state || !thread) return { thread: null, command: () => null };
  // The finished plan waits on an Accept that is running its required checks.
  const accept: AcceptanceAttempt | null =
    state === 'work-finished'
      ? {
          id: mint('acc', 1),
          taskId,
          state: 'checking',
          baseCommit: hex('3', 40),
          candidateTree: hex('4', 40),
          commandsDigest: hex('d', 64),
          choicesDigest: hex('e', 64),
          preparationId: null,
          requiredChecks: [
            { checkId: 'package.json:test', label: 'test', runId: null, status: 'running' },
            { checkId: 'package.json:lint', label: 'lint', runId: null, status: 'pending' },
          ],
          mutatedPaths: [],
          mutatedCount: 0,
          refusal: null,
          branch: BRANCH,
          commit: null,
        }
      : null;
  // The stopped plan's thread pushed an earlier accepted commit, and git ended with no result.
  const effects: RemoteEffect[] =
    state === 'work-blocked'
      ? [
          {
            id: mint('rfx', 1),
            taskId,
            kind: 'push',
            state: 'unknown',
            target: {
              repo: { host: 'github.com', owner: 'crew-kite', name: 'demo-shop' },
              branch: BRANCH,
              pr: null,
              headSha: HEAD,
              baseRef: null,
            },
            request: { kind: 'push', remote: 'origin', commit: HEAD, expectedRemote: null },
            confirmation: { at: ago(20 * 60_000), by: 'person' },
            observed: null,
            reason: 'git push ended without a result CrewKite can trust.',
          },
        ]
      : [];
  // The same thread's own copy went stale when the lockfile changed after it was prepared.
  // Prepare dependencies prepares it again, and the next read finds it current.
  const preparations: DependencyPreparation[] =
    state === 'work-blocked'
      ? [
          {
            id: mint('prp', 1),
            taskId,
            scope: 'thread',
            scopeKey: taskId,
            state: 'stale',
            layout: 'npm',
            inputs: {
              manifestDigests: { 'package.json': hex('5', 64) },
              lockfileDigest: hex('6', 64),
              workspaceDigest: null,
              runtime: 'node@24.22.0',
              packageManager: 'npm@10.9.0',
              platform: 'darwin',
              arch: 'arm64',
            },
            treeDigest: hex('7', 64),
            bytes: 48_211_456,
            limitBytes: 2 * 1024 ** 3,
            reason: 'stale-lockfile',
            preparedAt: ago(50 * 60_000),
          },
        ]
      : [];
  const read = (data: unknown) => ({ outcome: 'applied', data }) as CommandResult;
  return {
    thread,
    command(name) {
      switch (name) {
        case 'ReadAcceptance':
          return read({ kind: 'acceptance', taskId, current: accept, last: null });
        case 'ReadRemoteEffects':
          return read({ kind: 'remote-effects', taskId, effects });
        case 'ReadDependencyPreparation':
          return read({ kind: 'dependency-preparations', taskId, preparations });
        // The finished plan drafts a recipe from the crew and checks the scene shows.
        case 'DraftRecipe':
          return state === 'work-finished'
            ? read({
                kind: 'recipe-draft',
                recipe: {
                  schema: 1,
                  name: 'Add netMinor to net.mjs',
                  description: '',
                  shape: 'change',
                  crew: CREW,
                  run: {
                    flightMode: 'glide',
                    permissionPolicy: 'ask',
                    handoff: { auto: true, mode: 'most-left' },
                    maxSlices: SLICES.length,
                  },
                  checks: ITEMS.map((item) => ({ command: item.command })),
                  trigger: { kind: 'manual' },
                  budget: null,
                  work: null,
                },
                defaults: [],
              })
            : null;
        case 'ReleaseChatCheck':
          return state === 'work-held'
            ? read({ kind: 'chat-check-released', taskId, released: 1, held: false })
            : null;
        case 'PrepareDependencies': {
          preparations.push(preparedCopy(taskId));
          return read({
            kind: 'dependency-preparations',
            taskId,
            preparations: preparations.slice(-1),
          });
        }
        default:
          return null;
      }
    },
  };
}
