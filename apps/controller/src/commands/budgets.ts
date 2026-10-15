import { type Run, TimestampSchema } from '@crewkite/contracts';
import type { LaunchIntent } from '../store/index.ts';

export function chargedMinutes(intent: LaunchIntent, allowance: number): number {
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
