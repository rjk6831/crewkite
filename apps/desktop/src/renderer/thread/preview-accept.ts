import type {
  AcceptanceAttempt,
  ChatThread,
  CommandResult,
  DependencyPreparation,
} from '@crewkite/contracts';

// Accept with required checks in the browser preview. A `state` query parameter that starts with
// accept- picks where the Accept stands once Accept to branch is pressed: accept-preparing,
// accept-running, accept-passed, accept-failed, accept-unknown, accept-mutated and accept-stale.
// The last four end the attempt with the refusal the controller writes. Prepare dependencies
// answers with a prepared copy. Nothing leaves the window.

const mint = (prefix: string, n: number) => `${prefix}_0${String(n).padStart(25, '0')}`;
const hex = (digit: string, length: number) => digit.repeat(length);

type Check = AcceptanceAttempt['requiredChecks'][number];
const check = (name: 'test' | 'lint', status: Check['status']): Check => ({
  checkId: `package.json:${name}`,
  label: name,
  runId: status === 'pending' ? null : `chk_${String(name === 'test' ? 81 : 82).padStart(32, '0')}`,
  status,
});

/** Where each state leaves the attempt: still holding the thread, or ended with its refusal. */
const scenes: Record<
  string,
  { held: boolean; patch: Partial<AcceptanceAttempt> & Pick<AcceptanceAttempt, 'requiredChecks'> }
> = {
  'accept-preparing': {
    held: true,
    patch: { requiredChecks: [check('test', 'pending'), check('lint', 'pending')] },
  },
  'accept-running': {
    held: true,
    patch: {
      preparationId: mint('prp', 3),
      requiredChecks: [check('test', 'passed'), check('lint', 'running')],
    },
  },
  'accept-passed': {
    held: true,
    patch: {
      state: 'publishing',
      preparationId: mint('prp', 3),
      requiredChecks: [check('test', 'passed'), check('lint', 'passed')],
    },
  },
  'accept-failed': {
    held: false,
    patch: {
      state: 'refused',
      refusal: 'check-failed',
      preparationId: mint('prp', 3),
      requiredChecks: [check('test', 'failed'), check('lint', 'passed')],
    },
  },
  'accept-unknown': {
    held: false,
    patch: {
      state: 'refused',
      refusal: 'process-unknown',
      preparationId: mint('prp', 3),
      requiredChecks: [check('test', 'unknown'), check('lint', 'pending')],
    },
  },
  'accept-mutated': {
    held: false,
    patch: {
      state: 'refused',
      refusal: 'check-mutated',
      preparationId: mint('prp', 3),
      requiredChecks: [check('test', 'passed'), check('lint', 'mutated')],
      mutatedPaths: ['net.mjs', 'test/net.test.mjs'],
      mutatedCount: 2,
    },
  },
  'accept-stale': {
    held: false,
    patch: {
      state: 'refused',
      refusal: 'preparation-stale',
      requiredChecks: [check('test', 'pending'), check('lint', 'pending')],
    },
  },
};

/** A prepared copy of the thread's dependencies, as PrepareDependencies answers with one. */
export function preparedCopy(taskId: string): DependencyPreparation {
  return {
    id: mint('prp', 2),
    taskId,
    scope: 'thread',
    scopeKey: taskId,
    state: 'prepared',
    layout: 'npm',
    inputs: {
      manifestDigests: { 'package.json': hex('5', 64) },
      lockfileDigest: hex('8', 64),
      workspaceDigest: null,
      runtime: 'node@24.22.0',
      packageManager: 'npm@10.9.0',
      platform: 'darwin',
      arch: 'arm64',
    },
    treeDigest: hex('9', 64),
    bytes: 48_211_456,
    limitBytes: 2 * 1024 ** 3,
    reason: null,
    preparedAt: new Date().toISOString(),
  };
}

export function acceptPreview(state: string | null, taskId: string) {
  const scene = state ? scenes[state] : undefined;
  if (!scene)
    return {
      thread: null,
      command: (_name: string, _payload: Record<string, unknown>): CommandResult | null => null,
    };
  let attempt: AcceptanceAttempt | null = null;
  const read = (data: unknown) => ({ outcome: 'applied', data }) as CommandResult;
  return {
    // The reply has ended, so Accept is open.
    thread: { activeTurnId: null } as Partial<ChatThread>,
    command(name: string, payload: Record<string, unknown>): CommandResult | null {
      switch (name) {
        case 'AcceptChatChanges': {
          attempt = {
            id: mint('acc', 7),
            taskId,
            state: 'checking',
            baseCommit: hex('3', 40),
            candidateTree: hex('4', 40),
            commandsDigest: hex('d', 64),
            choicesDigest: hex('e', 64),
            preparationId: null,
            requiredChecks: [check('test', 'pending'), check('lint', 'pending')],
            mutatedPaths: [],
            mutatedCount: 0,
            refusal: null,
            branch: String(payload.branch),
            commit: null,
          };
          return read({ kind: 'acceptance', taskId, current: attempt, last: null });
        }
        case 'ReadAcceptance': {
          if (!attempt) return read({ kind: 'acceptance', taskId, current: null, last: null });
          const now = { ...attempt, ...scene.patch };
          return read({
            kind: 'acceptance',
            taskId,
            current: scene.held ? now : null,
            last: scene.held ? null : now,
          });
        }
        case 'CancelAcceptance':
          return { outcome: 'applied' };
        case 'PrepareDependencies':
          return read({
            kind: 'dependency-preparations',
            taskId,
            preparations: [preparedCopy(taskId)],
          });
        default:
          return null;
      }
    },
  };
}
