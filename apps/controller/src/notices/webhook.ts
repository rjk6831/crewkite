import { type WebhookBody, type WebhookEventKind, webhookUrl } from '@crewkite/contracts';
import { redactDiagnosticText } from '../diagnostics/redact.ts';
import type { Store } from '../store/index.ts';

// One outbound webhook. The controller posts a small JSON event to the address the person saved and
// nothing comes back in. The code that decides an ending hands it over after the commit, and the
// post is scheduled and never waited on.

const POST_TIMEOUT_MS = 5000;
const MAX_TITLE = 200;
const MAX_TEXT = 300;
const MAX_SCHEDULE = 120;

/** What a thread event says when the thread shows no line of its own for it. */
const SAID: Partial<Record<WebhookEventKind, string>> = {
  'approval-needed': 'waiting for permission',
  finished: 'reply finished',
  failed: 'reply failed',
  limit: 'stopped at a usage limit',
};

export type WebhookNotice = {
  kind: WebhookEventKind;
  /** The thread title. A schedule event has none. */
  title?: string | null;
  line: string;
  schedule?: string;
};

export type WebhookDeps = {
  /** The saved address, read when an event is due. */
  address: () => string | null;
  fetch: typeof fetch;
  now: () => Date;
  log: (line: string) => void;
};

/**
 * One line: control characters out, secrets redacted, then cut to `max` characters. Redacting
 * first means a cut can never leave part of a secret behind.
 */
const oneLine = (value: string, max: number) =>
  Array.from(redactDiagnosticText(value.replace(/\p{Cc}+/gu, ' ').trim()))
    .slice(0, max)
    .join('');

/** One line of title, at most 200 characters, secrets redacted. */
export function webhookTitle(title: string | null | undefined): string {
  return oneLine(title ?? '', MAX_TITLE) || 'Thread';
}

export function webhookBody(notice: WebhookNotice, now: Date): WebhookBody {
  const schedule = notice.schedule ? oneLine(notice.schedule, MAX_SCHEDULE) : '';
  return {
    event: notice.kind,
    ...(notice.title === undefined ? {} : { thread: notice.title && webhookTitle(notice.title) }),
    at: now.toISOString(),
    text: oneLine(notice.line, MAX_TEXT),
    ...(schedule ? { schedule } : {}),
  };
}

export class WebhookNotifier {
  private readonly abort = new AbortController();
  private readonly deps: WebhookDeps;

  constructor(deps: WebhookDeps) {
    this.deps = deps;
  }

  /** Schedules the post and returns. Nothing here waits on the network. */
  notify(notice: WebhookNotice): void {
    if (this.abort.signal.aborted) return;
    let url: string | null;
    try {
      url = webhookUrl(this.deps.address());
    } catch {
      return;
    }
    if (!url) return;
    void this.post(url, JSON.stringify(webhookBody(notice, this.deps.now())));
  }

  /** Pending posts are aborted. Close never waits on the network. */
  close(): void {
    this.abort.abort();
  }

  /**
   * Posts once and, when that fails, once more. A person's endpoint that is down gets two tries and
   * then the event is dropped with a log line. Redirects are refused so the address the person
   * saved is the only place the event goes.
   */
  private async post(url: string, body: string) {
    for (let attempt = 1; attempt <= 2 && !this.abort.signal.aborted; attempt++) {
      try {
        const response = await this.deps.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          redirect: 'error',
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(POST_TIMEOUT_MS)]),
        });
        if (response.ok) return;
        this.deps.log(`Webhook answered ${response.status} on try ${attempt}.`);
      } catch (failure) {
        // Close aborts the post on purpose, so there is nothing to log.
        if (this.abort.signal.aborted) return;
        this.deps.log(
          `Webhook post failed on try ${attempt}: ${failure instanceof Error ? failure.name : 'error'}.`,
        );
      }
    }
  }
}

/**
 * Posts one thread ending the controller decided, with the thread's title in front of its line.
 * The notifier is missing until the controller has finished starting, so nothing that ended
 * before a restart is posted.
 */
export function postThreadNotice(
  store: Pick<Store, 'get'>,
  notifier: WebhookNotifier | undefined,
  event: { kind: WebhookEventKind; taskId: string; line: string },
): void {
  if (!notifier) return;
  const title = webhookTitle(store.get<{ title?: string }>('task', event.taskId)?.title);
  notifier.notify({
    kind: event.kind,
    title,
    line: `${title}: ${event.line || SAID[event.kind] || ''}`,
  });
}
