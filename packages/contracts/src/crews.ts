import { z } from 'zod';
import { ChatCrewRoleSchema, ChatFlightModeSchema, ChatModelSelectionSchema } from './chat.ts';
import { AllowSubagentsSchema } from './subagents.ts';

// Saved crews: the crews the person builds in the desktop's Settings, and the crew new threads
// start with. The controller keeps them, so the desktop and the command line list the same crews.
// A saved crew is a template. A thread gets its own crew from it when the person picks it, and
// the controller checks that crew again then.

/** The built-in presets, in the order every client lists them. */
export const CREW_PRESET_NAMES = ['Solo', 'Tandem', 'Full crew'] as const;
export type CrewPresetName = (typeof CREW_PRESET_NAMES)[number];
/** Tandem was named Pair before 0.1.0. A default or a pin saved then still names Pair. */
const renamedPresets = new Map<string, CrewPresetName>([['Pair', 'Tandem']]);
export const currentPresetName = (name: string): string => renamedPresets.get(name) ?? name;
export const currentCrewChoice = (id: string): string =>
  id.startsWith('preset:') ? `preset:${currentPresetName(id.slice('preset:'.length))}` : id;
/** The most crews the person can save. */
export const SAVED_CREWS_MAX = 24;

export const SavedCrewIdSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);
/** A crew a thread can start from: `preset:<name>` or `saved:<id>`. */
export const CrewChoiceIdSchema = z
  .string()
  .transform(currentCrewChoice)
  .pipe(z.string().regex(/^(?:preset:(?:Solo|Tandem|Full crew)|saved:[a-z0-9-]{1,40})$/));
export type CrewChoiceId = z.infer<typeof CrewChoiceIdSchema>;
/** The crew new threads start with until the person picks another. */
export const BUILT_IN_DEFAULT_CREW = 'preset:Solo';

/**
 * A crew name is one line of 1 to 60 characters with no blank space at either end. Names are
 * unique across the presets and the saved crews, whatever their case.
 */
export const SavedCrewNameSchema = z
  .string()
  .min(1)
  .max(60)
  .refine(
    (value) => value.isWellFormed() && !/[\p{Cc}]/u.test(value) && value.trim() === value,
    'A crew name is one line of text with no blank space at either end.',
  );

/** One role of a saved crew. A null selection picks the role's model when a thread starts. */
export const SavedCrewMemberSchema = z.strictObject({
  role: ChatCrewRoleSchema,
  selection: ChatModelSelectionSchema.nullable(),
  allowSubagents: AllowSubagentsSchema,
});
export type SavedCrewMember = z.infer<typeof SavedCrewMemberSchema>;

export const SavedCrewSchema = z
  .strictObject({
    id: SavedCrewIdSchema,
    name: SavedCrewNameSchema,
    members: z.array(SavedCrewMemberSchema).min(1).max(5),
    /** The flight mode a thread takes when it starts from this crew. */
    flightMode: ChatFlightModeSchema,
  })
  .refine(
    (crew) => new Set(crew.members.map((member) => member.role)).size === crew.members.length,
    'A crew names each role at most once.',
  )
  .refine(
    (crew) => crew.members.some((member) => member.role === 'builder'),
    'A crew needs a builder.',
  );
export type SavedCrew = z.infer<typeof SavedCrewSchema>;

export const SavedCrewsReadSchema = z.strictObject({
  /** In the order they were first saved. Each crew's roles in crew order. */
  crews: z.array(SavedCrewSchema).max(SAVED_CREWS_MAX),
  /** Always a preset or one of `crews`. */
  defaultCrew: CrewChoiceIdSchema,
  /**
   * Whether the desktop has moved the crews it kept in its own storage before the controller held
   * them. The desktop sends them once, and the controller answers later imports with this list.
   */
  imported: z.boolean(),
});
export type SavedCrewsRead = z.infer<typeof SavedCrewsReadSchema>;

export const ReadSavedCrewsPayloadSchema = z.strictObject({});
/** Saving an ID that exists replaces that crew in its place. */
export const SaveCrewPayloadSchema = z.strictObject({ crew: SavedCrewSchema });
export const DeleteCrewPayloadSchema = z.strictObject({ id: SavedCrewIdSchema });
export const SetDefaultCrewPayloadSchema = z.strictObject({ id: CrewChoiceIdSchema });
/**
 * The crews and the default the desktop kept before the controller held them. Entries that do not
 * fit, such as a name another crew took, are left out, so one bad entry never blocks the rest.
 */
export const ImportSavedCrewsPayloadSchema = z.strictObject({
  crews: z.array(SavedCrewSchema).max(SAVED_CREWS_MAX),
  defaultCrew: CrewChoiceIdSchema.nullable(),
});

const roleOrder = (role: SavedCrewMember['role']) => ChatCrewRoleSchema.options.indexOf(role);

/** The crew with its roles in crew order, the way every client lists them. */
export const orderedCrew = (crew: SavedCrew): SavedCrew => ({
  ...crew,
  members: [...crew.members].sort((a, b) => roleOrder(a.role) - roleOrder(b.role)),
});

/** Whether a name is free: no preset and no other saved crew holds it, whatever the case. */
export function crewNameTaken(
  name: string,
  crews: readonly Pick<SavedCrew, 'id' | 'name'>[],
  editing: string | null,
): boolean {
  const wanted = name.trim().toLowerCase();
  return (
    CREW_PRESET_NAMES.some((preset) => preset.toLowerCase() === wanted) ||
    crews.some((crew) => crew.id !== editing && crew.name.toLowerCase() === wanted)
  );
}
