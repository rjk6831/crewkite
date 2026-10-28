import { z } from 'zod';

// The extension seam. A separately licensed module adds commands, event kinds, settings cards,
// thread actions, inspector tabs and crew roles through one manifest and these shapes. The
// controller validates the manifest, grants nothing until the person turns the extension on, and
// runs every extension command through the same checks as a built-in command. See ADR 0047 and
// docs/extensions.md.

/**
 * The contract version this build offers. A manifest names the version it targets. The major
 * must match. A manifest minor above this one needs a newer CrewKite.
 */
export const EXTENSION_CONTRACT_VERSION = '1.0.0';

/** Plain semantic version, three numbers and nothing else. */
export const ExtensionVersionSchema = z
  .string()
  .max(32)
  .regex(/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/);

/**
 * What an extension can ask for. The list is closed: a manifest that names anything else is
 * refused. Nothing here reaches another thread, the scratch copy, the repository, settings,
 * budgets or limits.
 *
 * - `thread.read`: read a bounded copy of the thread the command was run on.
 * - `thread.event`: append the extension's own declared event kinds to that thread's event log.
 */
export const EXTENSION_AUTHORITIES = ['thread.read', 'thread.event'] as const;
export const ExtensionAuthoritySchema = z.enum(EXTENSION_AUTHORITIES);

/** Lower-case kebab name: extension IDs, command IDs, event kinds and slot IDs. */
export const ExtensionNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
const title = z.string().min(1).max(80);
const id = ExtensionNameSchema;
const slot = z.strictObject({ id, title, command: id });
const unique = (values: readonly string[]) => new Set(values).size === values.length;

export const ExtensionManifestSchema = z
  .strictObject({
    id,
    name: title,
    version: ExtensionVersionSchema,
    contract: ExtensionVersionSchema,
    description: z.string().max(500).optional(),
    /** A module file in the extension's folder. It exports `commands`, keyed by command ID. */
    entry: z.string().regex(/^[A-Za-z0-9_-]{1,64}\.(mjs|js)$/),
    authority: z.array(ExtensionAuthoritySchema).max(EXTENSION_AUTHORITIES.length),
    commands: z.array(z.strictObject({ id, title })).max(32),
    eventKinds: z.array(id).max(32).default([]),
    settingsCards: z.array(slot).max(4).default([]),
    threadActions: z.array(slot).max(8).default([]),
    inspectorTabs: z.array(slot).max(4).default([]),
    /** Listed with the extension. The crew chain of ADR 0038 does not schedule them. */
    crewRoles: z
      .array(z.strictObject({ id, title, brief: z.string().min(1).max(500) }))
      .max(4)
      .default([]),
  })
  .refine((manifest) => unique(manifest.authority), 'Each authority appears once.')
  .refine(
    (manifest) =>
      unique(manifest.commands.map((command) => command.id)) &&
      unique(manifest.eventKinds) &&
      unique(
        [...manifest.settingsCards, ...manifest.threadActions, ...manifest.inspectorTabs].map(
          (item) => item.id,
        ),
      ) &&
      unique(manifest.crewRoles.map((role) => role.id)),
    'Commands, event kinds, slots and crew roles have unique IDs.',
  )
  .refine(
    (manifest) =>
      [...manifest.settingsCards, ...manifest.threadActions, ...manifest.inspectorTabs].every(
        (item) => manifest.commands.some((command) => command.id === item.command),
      ),
    'Each slot runs a command the manifest declares.',
  )
  .refine(
    (manifest) => manifest.eventKinds.length === 0 || manifest.authority.includes('thread.event'),
    'Declaring event kinds needs the thread.event authority.',
  );
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
export type ExtensionAuthority = z.infer<typeof ExtensionAuthoritySchema>;

/** Why a manifest was refused. Each one has a plain line in the listing. */
export const ExtensionRefusalSchema = z.enum([
  'manifest-unreadable',
  'invalid-manifest',
  'bad-version',
  'bad-contract',
  'unknown-authority',
  'contract-major-mismatch',
  'contract-too-new',
  'folder-mismatch',
  'entry-missing',
]);
export type ExtensionRefusal = z.infer<typeof ExtensionRefusalSchema>;

/**
 * One folder under the controller home's `extensions` directory, as Settings > Extensions shows
 * it. `off` is the default. `changed` means the manifest differs from the one the person turned
 * on, so it is off until they turn it on again. `refused` covers every manifest the controller
 * cannot accept, with the reason and a plain line.
 */
export const ExtensionListingSchema = z.strictObject({
  folder: z.string().min(1).max(255),
  state: z.enum(['off', 'on', 'changed', 'refused']),
  refusal: ExtensionRefusalSchema.nullable(),
  line: z.string().max(500).nullable(),
  manifest: ExtensionManifestSchema.nullable(),
  /** The canonical hash of the manifest. Turning an extension on names the hash the person saw. */
  manifestHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export type ExtensionListing = z.infer<typeof ExtensionListingSchema>;

const slotFields = { extensionId: id, id, title, command: id };
/**
 * A place in the desktop and the CLI where an extension that is on shows up. A slot carries data
 * only. Clients render its title and the text its command returns, and run no extension code.
 */
export const ExtensionSlotSchema = z.discriminatedUnion('slot', [
  z.strictObject({ slot: z.literal('settings-card'), ...slotFields }),
  z.strictObject({ slot: z.literal('thread-action'), ...slotFields }),
  z.strictObject({ slot: z.literal('inspector-tab'), ...slotFields }),
]);
export type ExtensionSlot = z.infer<typeof ExtensionSlotSchema>;

/** What an extension command returns. Clients show it as plain text, never as markup. */
export const ExtensionCommandOutputSchema = z.strictObject({
  text: z.string().min(1).max(4000),
  rows: z
    .array(z.strictObject({ label: z.string().min(1).max(80), value: z.string().max(400) }))
    .max(32)
    .optional(),
});
export type ExtensionCommandOutput = z.infer<typeof ExtensionCommandOutputSchema>;

export const ReadExtensionsPayloadSchema = z.strictObject({});
/** Turn one extension on or off. Turning on names the manifest hash the person was shown. */
export const ConfigureExtensionPayloadSchema = z.strictObject({
  extensionId: id,
  enabled: z.boolean(),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const RunExtensionCommandPayloadSchema = z.strictObject({
  extensionId: id,
  commandId: id,
  /** The thread the command runs on. A settings card runs with none. */
  taskId: z
    .string()
    .regex(/^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    .optional(),
  input: z.string().max(4096).optional(),
});

export const ExtensionsReadSchema = z.strictObject({
  contract: z.literal(EXTENSION_CONTRACT_VERSION),
  extensions: z.array(ExtensionListingSchema).max(32),
  slots: z.array(ExtensionSlotSchema).max(512),
  crewRoles: z
    .array(z.strictObject({ extensionId: id, id, title, brief: z.string().max(500) }))
    .max(128),
});
export type ExtensionsRead = z.infer<typeof ExtensionsReadSchema>;

export const ExtensionCommandResultSchema = z.strictObject({
  extensionId: id,
  commandId: id,
  taskId: z
    .string()
    .regex(/^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    .nullable(),
  output: ExtensionCommandOutputSchema,
});
export type ExtensionCommandResult = z.infer<typeof ExtensionCommandResultSchema>;

/** An event an extension declared and emitted on the thread its command ran on. */
export const ExtensionEventSchema = z.strictObject({
  extensionId: id,
  kind: id,
  output: ExtensionCommandOutputSchema,
});
export type ExtensionEvent = z.infer<typeof ExtensionEventSchema>;

/** A bounded copy of the one thread a command runs on: the last 50 messages, 2,000 characters each. */
export type ExtensionThreadView = Readonly<{
  taskId: string;
  title: string;
  messages: readonly Readonly<{ author: 'person' | 'assistant' | 'system'; text: string }>[];
}>;

/**
 * What an extension command receives, frozen. A field the manifest has no authority for is
 * absent. The thread reader takes no argument and reads only the thread the command ran on. The
 * command returns an `ExtensionCommandOutput` synchronously.
 */
export type ExtensionContext = Readonly<{
  contract: string;
  extensionId: string;
  commandId: string;
  input: string | null;
  thread: Readonly<{ taskId: string; read?: () => ExtensionThreadView }> | null;
  emit?: (kind: string, output: ExtensionCommandOutput) => void;
}>;

/** The major of a version string, or null when it is not a version. */
export function extensionMajor(version: string): number | null {
  return ExtensionVersionSchema.safeParse(version).success ? Number(version.split('.')[0]) : null;
}
