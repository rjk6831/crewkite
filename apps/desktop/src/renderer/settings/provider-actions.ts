import type { Snapshot } from '@crewkite/contracts';
import { useState } from 'react';
import type { Workspace } from '../source.ts';

type Family = 'openai' | 'anthropic' | 'google';
type Trust = NonNullable<Snapshot['usageReaders'][number]['trust']>;
const applied = (outcome: string) => outcome === 'applied' || outcome === 'already-applied';
const refusal = (result: { outcome: string; reason?: string; next?: string }) =>
  [result.reason ?? result.outcome, result.next].filter(Boolean).join('. ');

/**
 * The quota and sign-in commands the provider cards send, with the status line each one leaves
 * behind. Every command goes through the workspace, which refreshes the snapshot afterwards.
 */
export function useProviderActions(workspace: Workspace) {
  const [messages, setMessages] = useState<Partial<Record<Family, string>>>({});
  const [busy, setBusy] = useState<Partial<Record<Family, boolean>>>({});
  const [trust, setTrust] = useState<Trust | null>(null);
  const say = (family: Family, message: string) =>
    setMessages((current) => ({ ...current, [family]: message }));
  const work = (family: Family, on: boolean) =>
    setBusy((current) => ({ ...current, [family]: on }));

  async function refreshAnthropic(accepted?: Trust) {
    setTrust(null);
    work('anthropic', true);
    say('anthropic', 'Reading the native local usage report.');
    try {
      const result = await workspace.metadataCommand({
        command: 'RefreshAnthropicUsage',
        expectedRevision: 0,
        payload: accepted
          ? { trust: { scopeHash: accepted.scopeHash, nativeTrust: 'accepted' } }
          : {},
      });
      say(
        'anthropic',
        applied(result.outcome)
          ? 'Native usage report retained. Report age is unknown.'
          : refusal(result),
      );
    } catch (failure) {
      say('anthropic', failure instanceof Error ? failure.message : 'The usage refresh failed.');
    } finally {
      work('anthropic', false);
    }
  }
  async function stopAnthropicUsage(operationId: string) {
    const result = await workspace.metadataCommand({
      command: 'StopAnthropicUsage',
      expectedRevision: 0,
      payload: { operationId },
    });
    say('anthropic', result.reason ?? result.outcome);
  }
  async function checkAnthropic() {
    work('anthropic', true);
    say('anthropic', 'Checking Anthropic sign-in.');
    try {
      const result = await workspace.metadataCommand({
        command: 'CheckNativeConnection',
        expectedRevision: 0,
        payload: { family: 'anthropic', consent: 'explicit' },
      });
      say(
        'anthropic',
        applied(result.outcome) ? 'Anthropic sign-in check completed.' : refusal(result),
      );
    } catch (failure) {
      say(
        'anthropic',
        failure instanceof Error ? failure.message : 'Anthropic sign-in could not be checked.',
      );
    } finally {
      work('anthropic', false);
    }
  }
  async function observeUsage(family: 'google' | 'openai') {
    work(family, true);
    say(family, 'Quota read in progress.');
    try {
      const result = await workspace.metadataCommand({
        command: 'ObserveUsage',
        expectedRevision: 0,
        payload: { family },
      });
      say(family, applied(result.outcome) ? 'Quota read successful.' : refusal(result));
    } catch (failure) {
      say(family, failure instanceof Error ? failure.message : 'The quota command failed.');
    } finally {
      work(family, false);
    }
  }
  return {
    messages,
    busy,
    trust,
    setTrust,
    refreshAnthropic,
    stopAnthropicUsage,
    checkAnthropic,
    observeUsage,
  };
}
export type ProviderActions = ReturnType<typeof useProviderActions>;
