import { z } from 'zod';

// The Google route gate. A person reads what Google's terms say and chooses the route
// themselves before the controller lets any Google connection step run. The controller stores
// the acknowledgement with its time and the text version it covered. A new version asks again.

/** Change this when the summary or the checkbox text changes. */
export const GOOGLE_TERMS_VERSION = '2026-10-28';

export const GOOGLE_TERMS_SUMMARY = [
  'Google says in its third-party access FAQ that third-party access through its coding client login violates its terms. Its headless FAQ also excludes consumer CLI wrappers.',
  'CrewKite is not named by Google and has no exception.',
  'Using this route is your own choice and your own risk.',
];

export const GOOGLE_TERMS_CHECKBOX =
  'I have read Google’s terms. I choose to use this route and accept the risk to my own account. Roots No Limits LLC is not liable for Google’s actions against it.';

export const GoogleTermsSchema = z.strictObject({
  version: z.string().min(1).max(40),
  at: z.iso.datetime(),
});
export type GoogleTerms = z.infer<typeof GoogleTermsSchema>;

export const AcknowledgeGoogleTermsPayloadSchema = z.strictObject({
  textVersion: z.string().min(1).max(40),
});

/** True when the stored acknowledgement covers the text this build shows. */
export const googleTermsCurrent = (terms: GoogleTerms | null | undefined): boolean =>
  terms?.version === GOOGLE_TERMS_VERSION;
