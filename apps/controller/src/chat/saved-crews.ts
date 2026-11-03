import type { DatabaseSync } from 'node:sqlite';
import {
  BUILT_IN_DEFAULT_CREW,
  type Command,
  type CommandResult,
  CREW_PRESET_NAMES,
  crewNameTaken,
  currentCrewChoice,
  orderedCrew,
  SAVED_CREWS_MAX,
  type SavedCrew,
  SavedCrewSchema,
  type SavedCrewsRead,
} from '@crewkite/contracts';

// The crews the person saves in the desktop's Settings, and the crew new threads start with. The
// controller keeps them in SQLite, so the desktop and the command line list the same crews. A
// saved crew is a template: it grants nothing, and a thread's crew is checked again when a client
// applies it.

export class CrewsRefused extends Error {
  reason: 'crew-not-found' | 'crews-full' | 'crew-name-taken' | 'crew-choice-unknown';
  next: string;
  constructor(reason: CrewsRefused['reason'], next: string) {
    super(next);
    this.reason = reason;
    this.next = next;
  }
}

export class SavedCrews {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(db: DatabaseSync, now: () => string) {
    this.db = db;
    this.now = now;
  }

  /** Saved crews in the order they were first saved, with the default and the import mark. */
  read(): SavedCrewsRead {
    const crews = this.list();
    const settings = this.db
      .prepare('SELECT default_crew, imported_at FROM crew_settings WHERE id=1')
      .get() as { default_crew: string; imported_at: string | null };
    const saved = currentCrewChoice(settings.default_crew);
    return {
      crews,
      defaultCrew: this.known(saved, crews) ? saved : BUILT_IN_DEFAULT_CREW,
      imported: settings.imported_at !== null,
    };
  }

  /** Saving an ID that exists replaces that crew in its place. A new crew goes last. */
  save(input: SavedCrew): SavedCrewsRead {
    const crew = orderedCrew(SavedCrewSchema.parse(input));
    const crews = this.list();
    const editing = crews.some(({ id }) => id === crew.id);
    if (crewNameTaken(crew.name, crews, crew.id))
      throw new CrewsRefused('crew-name-taken', 'Another crew has this name. Pick another name.');
    if (!editing && crews.length >= SAVED_CREWS_MAX)
      throw new CrewsRefused(
        'crews-full',
        `Up to ${SAVED_CREWS_MAX} crews can be saved. Delete one before adding another.`,
      );
    this.write(crew, editing);
    return this.read();
  }

  /** A deleted crew that was the default hands the default back to Solo. */
  delete(id: string): SavedCrewsRead {
    const removed = this.db.prepare('DELETE FROM saved_crews WHERE id=?').run(id);
    if (Number(removed.changes) === 0)
      throw new CrewsRefused('crew-not-found', 'That crew no longer exists.');
    this.db
      .prepare('UPDATE crew_settings SET default_crew=? WHERE id=1 AND default_crew=?')
      .run(BUILT_IN_DEFAULT_CREW, `saved:${id}`);
    return this.read();
  }

  setDefault(id: string): SavedCrewsRead {
    if (!this.known(id, this.list()))
      throw new CrewsRefused('crew-choice-unknown', 'That crew no longer exists. Pick another.');
    this.db.prepare('UPDATE crew_settings SET default_crew=? WHERE id=1').run(id);
    return this.read();
  }

  /**
   * The crews the desktop kept in its own storage before the controller held them. They are taken
   * once: a later import answers with the list as it stands. A crew whose ID or name is taken, or
   * one past the limit, is left out, so one bad entry never blocks the rest.
   */
  importOnce(crews: readonly SavedCrew[], defaultCrew: string | null): SavedCrewsRead {
    if (this.read().imported) return this.read();
    for (const input of crews) {
      const parsed = SavedCrewSchema.safeParse(input);
      if (!parsed.success) continue;
      const present = this.list();
      if (
        present.length >= SAVED_CREWS_MAX ||
        present.some(({ id }) => id === parsed.data.id) ||
        crewNameTaken(parsed.data.name, present, null)
      )
        continue;
      this.write(orderedCrew(parsed.data), false);
    }
    if (defaultCrew && this.known(defaultCrew, this.list()))
      this.db.prepare('UPDATE crew_settings SET default_crew=? WHERE id=1').run(defaultCrew);
    this.db.prepare('UPDATE crew_settings SET imported_at=? WHERE id=1').run(this.now());
    return this.read();
  }

  private list(): SavedCrew[] {
    return this.db
      .prepare('SELECT body FROM saved_crews ORDER BY position')
      .all()
      .map((row) => SavedCrewSchema.parse(JSON.parse(row.body as string)));
  }

  private write(crew: SavedCrew, editing: boolean) {
    const body = JSON.stringify(crew);
    if (editing)
      this.db
        .prepare('UPDATE saved_crews SET name=?, body=? WHERE id=?')
        .run(crew.name, body, crew.id);
    else
      this.db
        .prepare(
          'INSERT INTO saved_crews(id, name, position, body) VALUES (?, ?, (SELECT coalesce(max(position) + 1, 0) FROM saved_crews), ?)',
        )
        .run(crew.id, crew.name, body);
  }

  private known(id: string, crews: readonly SavedCrew[]): boolean {
    return (
      CREW_PRESET_NAMES.some((name) => id === `preset:${name}`) ||
      crews.some((crew) => id === `saved:${crew.id}`)
    );
  }
}

export type CrewsCommand = Extract<
  Command,
  {
    command: 'ReadSavedCrews' | 'SaveCrew' | 'DeleteCrew' | 'SetDefaultCrew' | 'ImportSavedCrews';
  }
>;

/** The commands that change saved crews. The controller does not race them on a revision. */
export const crewsMutations = ['SaveCrew', 'DeleteCrew', 'SetDefaultCrew', 'ImportSavedCrews'];

/**
 * Runs one crews command. Every command answers with the whole list, which stays small. A refusal
 * comes back as a blocked result that carries the sentence for the person.
 */
export function crewsCommand(crews: SavedCrews, command: CrewsCommand): CommandResult {
  try {
    const read =
      command.command === 'ReadSavedCrews'
        ? crews.read()
        : command.command === 'SaveCrew'
          ? crews.save(command.payload.crew)
          : command.command === 'DeleteCrew'
            ? crews.delete(command.payload.id)
            : command.command === 'SetDefaultCrew'
              ? crews.setDefault(command.payload.id)
              : crews.importOnce(command.payload.crews, command.payload.defaultCrew);
    return { outcome: 'applied', data: { kind: 'saved-crews', ...read } };
  } catch (failure) {
    if (failure instanceof CrewsRefused)
      return { outcome: 'blocked', reason: failure.reason, next: failure.next };
    throw failure;
  }
}
