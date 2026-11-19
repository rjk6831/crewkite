import { z } from 'zod';

// One outbound webhook. The person supplies the address, the controller posts a small JSON event to
// it and nothing comes back in.

const MAX_URL = 2048;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** An empty string clears the address. */
export const SetWebhookPayloadSchema = z.strictObject({ url: z.string().max(MAX_URL) });
export const ReadWebhookPayloadSchema = z.strictObject({});
/** The saved address, or null when none is set. */
export const WebhookReadSchema = z.strictObject({ url: z.string().nullable() });
export type WebhookRead = z.infer<typeof WebhookReadSchema>;

// paused and stopped belong to schedules, which carry a name and no thread.
export const WebhookEventKindSchema = z.enum([
  'approval-needed',
  'finished',
  'failed',
  'limit',
  'paused',
  'stopped',
]);
export type WebhookEventKind = z.infer<typeof WebhookEventKindSchema>;

export const WebhookBodySchema = z.strictObject({
  event: WebhookEventKindSchema,
  thread: z.string().max(200).nullable().optional(),
  at: z.iso.datetime(),
  text: z.string().max(300),
  schedule: z.string().max(120).optional(),
});
export type WebhookBody = z.infer<typeof WebhookBodySchema>;

/**
 * The normalized address when it is https, or http to this computer. Null for anything else. The
 * length bound applies to the normalized form, so an address that saves also passes the check
 * before each post.
 */
export function webhookUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  // A password in the address would land in logs and settings reads.
  if (url.username || url.password) return null;
  if (url.href.length > MAX_URL) return null;
  if (url.protocol === 'https:') return url.href;
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname) ? url.href : null;
}
