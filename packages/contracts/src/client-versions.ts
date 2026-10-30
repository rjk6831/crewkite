import { z } from 'zod';

// Where an installed provider client stands against the build CrewKite tested. The chat path and
// the quota reader accept a range of builds; the writer profiles keep their exact pins.

/**
 * tested: the exact tested build. newer: above it in the same major version. supported: at or
 * above the minimum and below the tested build. older: below the minimum. new-major: a later
 * major version, which CrewKite has not tested. unreadable: the version flag gave no version.
 * missing: no client on the search path. untrusted: the file failed an owner or mode check.
 * unavailable: this computer or its settings cannot run the client at all.
 */
export const ClientVersionStateSchema = z.enum([
  'tested',
  'newer',
  'supported',
  'older',
  'new-major',
  'unreadable',
  'missing',
  'untrusted',
  'unavailable',
]);
export type ClientVersionState = z.infer<typeof ClientVersionStateSchema>;

export const ClientVersionStatusSchema = z.strictObject({
  state: ClientVersionStateSchema,
  /** True when CrewKite will launch this client. */
  accepted: z.boolean(),
  /** The version the client reported, or null when none was read. */
  version: z.string().min(1).max(200).nullable(),
  tested: z.string().min(1).max(200),
  minimum: z.string().min(1).max(200),
  /** One plain line for Settings and the CLI. */
  message: z.string().min(1).max(1024),
});
export type ClientVersionStatus = z.infer<typeof ClientVersionStatusSchema>;
