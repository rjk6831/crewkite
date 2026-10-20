import { type Run, TimestampSchema } from '@crewkite/contracts';
import type { CombinedDispatch, CombinedGroup, LaunchIntent } from '../store/index.ts';

export function chargedMinutes(
  intent: Pick<LaunchIntent, 'admitted_at' | 'finished_at'>,
  allowance: number,
): number {
  if (
    !TimestampSchema.safeParse(intent.admitted_at).success ||
    !TimestampSchema.safeParse(intent.finished_at).success
  )
    return allowance;
  const elapsed =
    Date.parse(intent.finished_at as string) - Date.parse(intent.admitted_at as string);
  if (elapsed < 0 || !Number.isFinite(elapsed)) return allowance;
  return Math.ceil(elapsed / 60000);
}

export function remainingBudgets(run: Run, intents: LaunchIntent[]) {
  const ledger = intents.filter((intent) => intent.run_id === run.id);
  return {
    attempts: Math.max(0, run.policy.policy.limits.attempts - ledger.length),
    minutes: Math.max(
      0,
      run.policy.policy.limits.minutes -
        ledger.reduce(
          (sum, intent) => sum + chargedMinutes(intent, run.policy.policy.limits.minutes),
          0,
        ),
    ),
    concurrency: Math.max(
      0,
      run.policy.policy.limits.concurrency -
        ledger.filter((intent) => intent.state !== 'stopped').length,
    ),
  };
}

export function chargedIntegrationMinutes(
  group: Pick<
    CombinedGroup,
    'integration_milliseconds' | 'integration_active' | 'integration_maximum_minutes' | 'phase'
  >,
) {
  return group.integration_active || group.phase === 'unknown'
    ? group.integration_maximum_minutes
    : Math.ceil(group.integration_milliseconds / 60000);
}

export function unspentIntegrationMinutes(
  group: Pick<CombinedGroup, 'integration_milliseconds' | 'integration_maximum_minutes'>,
) {
  return Math.max(
    0,
    group.integration_maximum_minutes - Math.ceil(group.integration_milliseconds / 60000),
  );
}

/** Reserved stages share one ledger, even while two child writers are active. */
export function remainingCombinedBudgets(
  owner: Run,
  intents: LaunchIntent[],
  dispatches: CombinedDispatch[],
  group: Parameters<typeof chargedIntegrationMinutes>[0],
  ignoredAttemptIds: ReadonlySet<string> = new Set(),
) {
  const allIds = dispatches.flatMap((slot) => (slot.attempt_id ? [slot.attempt_id] : []));
  const ids = dispatches.flatMap((slot) =>
    slot.attempt_id && !ignoredAttemptIds.has(slot.attempt_id) ? [slot.attempt_id] : [],
  );
  if (
    new Set(allIds).size !== allIds.length ||
    ids.some((id) => !intents.some((intent) => intent.attempt_id === id))
  )
    throw Error('The combined budget has an incomplete dispatch ledger.');
  const ledger = intents.filter((intent) => ids.includes(intent.attempt_id));
  const minutes = ledger.reduce((sum, intent) => {
    const slot = dispatches.find((value) => value.attempt_id === intent.attempt_id);
    if (!slot) throw Error('The combined dispatch has no reserved allowance.');
    return sum + chargedMinutes(intent, slot.maximum_minutes);
  }, chargedIntegrationMinutes(group));
  return {
    attempts: Math.max(0, owner.policy.policy.limits.attempts - ledger.length),
    minutes: Math.max(0, owner.policy.policy.limits.minutes - minutes),
    concurrency: Math.max(
      0,
      owner.policy.policy.limits.concurrency -
        ledger.filter((intent) => intent.state !== 'stopped').length,
    ),
  };
}
