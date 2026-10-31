import {
  type CommandResult,
  DIAGNOSTIC_EVENTS,
  type Event,
  type ReadDiagnosticsPayload,
  type Task,
} from '@crewkite/contracts';
import { CREWKITE_VERSION } from '@crewkite/contracts/version';
import type { NativeProfileResolution } from '../providers/openai/profile.ts';
import { taskActivityPage } from '../store/activity.ts';
import type { Store } from '../store/index.ts';
import { buildDiagnostics, type ProviderClientFact } from './bundle.ts';

/** The newest events of a thread, oldest first, from as many activity pages as it takes. */
function newestEvents(store: Store, taskId: string, count: number): Event[] {
  const found: Event[] = [];
  let before: string | undefined;
  while (found.length < count) {
    const page = taskActivityPage(store.db, {
      taskId,
      limit: Math.min(100, count - found.length),
      ...(before ? { beforeCursor: before } : {}),
    });
    found.unshift(...page.events);
    if (!page.nextBeforeCursor || page.events.length === 0) break;
    before = page.nextBeforeCursor;
  }
  return found;
}

const clientFacts = (profiles: NativeProfileResolution[]): ProviderClientFact[] =>
  profiles.map((profile) => ({
    profile: profile.facts.id,
    family: profile.facts.family,
    available: profile.facts.available,
    reason: 'reason' in profile.facts ? String(profile.facts.reason) : null,
    client: profile.client
      ? {
          executable: profile.client.executable,
          sha256: profile.client.sha256,
          version: profile.client.version,
        }
      : null,
  }));

/** The `ReadDiagnostics` command. A thread that does not exist is refused, as every read does. */
export function readDiagnostics(
  deps: {
    home: string;
    store: Store;
    profiles: () => NativeProfileResolution[];
    google?: () => unknown;
  },
  payload: ReadDiagnosticsPayload,
): CommandResult {
  if (payload.taskId && !deps.store.get<Task>('task', payload.taskId))
    return { outcome: 'blocked', reason: 'task-not-found' };
  const files = buildDiagnostics(
    {
      home: deps.home,
      controllerVersion: CREWKITE_VERSION,
      clients: () => clientFacts(deps.profiles()),
      events: (taskId, count) => newestEvents(deps.store, taskId, count ?? DIAGNOSTIC_EVENTS),
      ...(deps.google ? { google: deps.google } : {}),
    },
    payload,
  );
  return { outcome: 'applied', data: { kind: 'diagnostic-files', files } };
}
