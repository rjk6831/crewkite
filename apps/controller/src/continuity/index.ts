import {
  type Attempt,
  AttemptSchema,
  type HandoffPacket,
  HandoffPacketSchema,
  type Run,
  RunSchema,
} from '@crewkite/contracts';
import { hashCanonical, sealHandoff } from '@crewkite/contracts/hash';

export { verifyHandoff } from '@crewkite/contracts/hash';

export function buildHandoff(input: {
  packet: HandoffPacket;
  outgoing: Attempt;
  run: Run;
  quiescent: boolean;
}) {
  const packet = HandoffPacketSchema.parse(input.packet);
  const outgoing = AttemptSchema.parse(input.outgoing);
  const run = RunSchema.parse(input.run);
  if (!input.quiescent || outgoing.state !== 'stopped') {
    throw new Error('Handoff requires a stopped attempt and confirmed quiescence.');
  }
  if (
    packet.runId !== run.id ||
    packet.taskId !== run.taskId ||
    packet.runId !== outgoing.runId ||
    packet.attemptId !== outgoing.id ||
    packet.generation !== outgoing.generation
  ) {
    throw new Error('Handoff lineage does not match the outgoing attempt.');
  }
  if (hashCanonical(packet.policy.policy) !== packet.policy.hash) {
    throw new Error('Handoff policy hash does not match its content.');
  }
  if (
    hashCanonical(packet.source) !== hashCanonical(run.source) ||
    hashCanonical(packet.policy) !== hashCanonical(run.policy)
  ) {
    throw new Error('Handoff source and policy must match the admitted run.');
  }
  if (packet.policy.policy.effects.some((grant) => grant.taskId !== packet.taskId)) {
    throw new Error('Handoff grants must belong to this task.');
  }
  for (const key of ['attempts', 'minutes', 'concurrency'] as const) {
    if (packet.remainingBudgets[key] > run.policy.policy.limits[key]) {
      throw new Error('Handoff remaining budgets cannot exceed the admitted limits.');
    }
  }
  const allowedRoutes = new Set(
    run.roles.flatMap((role) => [role.routeId, ...role.approvedFallbacks]),
  );
  if (packet.allowedRouteIds.some((id) => !allowedRoutes.has(id))) {
    throw new Error('Handoff cannot add a route outside the admitted roster.');
  }
  if (new Set(packet.allowedRouteIds).size !== packet.allowedRouteIds.length) {
    throw new Error('Handoff routes must be unique.');
  }
  if (new Set(packet.artifacts.map(({ id }) => id)).size !== packet.artifacts.length) {
    throw new Error('Handoff artifact identities must be unique.');
  }
  if (packet.candidate !== null) {
    const artifact = packet.artifacts.find(({ id }) => id === packet.candidate?.artifactId);
    if (packet.candidate.taskId !== packet.taskId || artifact?.hash !== packet.candidate.hash) {
      throw new Error('Handoff candidate is not backed by its task artifact.');
    }
  }
  return sealHandoff(packet);
}
