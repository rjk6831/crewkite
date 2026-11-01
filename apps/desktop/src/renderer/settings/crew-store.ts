import type { CrewChoiceId, SavedCrew, SavedCrewsRead } from '@crewkite/contracts';
import {
  deleteCrew as deleteCrewCommand,
  importCrews,
  readCrews,
  saveCrew as saveCrewCommand,
  setDefaultCrew as setDefaultCrewCommand,
  type ThreadSource,
} from '../thread/commands.ts';
import { clearLegacyCrews, readLegacyCrews, setSavedCrews } from './preferences.ts';

// Saved crews and the default crew go through the controller, so the desktop and the command line
// share them. The window keeps the last list the controller sent for the views that read it while
// they draw, and each change takes the list the controller answers with.

let connected: ThreadSource | null = null;

type LegacyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const browserStore = (): LegacyStore | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

/**
 * Reads the crews from the controller. On the first launch after the move, the crews this window
 * kept go to the controller once, and their keys are removed after the controller holds them.
 */
export async function loadCrews(
  source: ThreadSource,
  store: LegacyStore | null = browserStore(),
): Promise<SavedCrewsRead> {
  connected = source;
  let read = await readCrews(source);
  if (!read.imported) {
    const legacy = readLegacyCrews(store);
    read = await importCrews(source, legacy.crews, legacy.defaultCrew);
    clearLegacyCrews(store);
  }
  setSavedCrews(read);
  return read;
}

const source = () => {
  if (!connected) throw new Error('The controller is offline. Crews could not be changed.');
  return connected;
};

/** Saving an id that exists replaces that crew in its place. */
export const saveCrew = async (crew: SavedCrew) =>
  setSavedCrews(await saveCrewCommand(source(), crew));
/** The default goes back to Solo when it was this crew. */
export const deleteCrew = async (id: string) =>
  setSavedCrews(await deleteCrewCommand(source(), id));
export const setDefaultCrew = async (id: CrewChoiceId) =>
  setSavedCrews(await setDefaultCrewCommand(source(), id));
