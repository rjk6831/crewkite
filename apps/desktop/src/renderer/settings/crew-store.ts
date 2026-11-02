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

/** Where the read of the saved crews stands, so Settings can say it is loading or failed. */
export type CrewLoad =
  | { state: 'waiting' }
  | { state: 'loading' }
  | { state: 'loaded' }
  | { state: 'failed'; message: string };

let load: CrewLoad = { state: 'waiting' };
const loadListeners = new Set<() => void>();
const setLoad = (next: CrewLoad) => {
  load = next;
  for (const listener of loadListeners) listener();
};

export const readCrewLoad = (): CrewLoad => load;

/** Calls `listener` when the read of the saved crews starts, ends or fails. */
export function onCrewLoad(listener: () => void): () => void {
  loadListeners.add(listener);
  return () => void loadListeners.delete(listener);
}

/**
 * Reads the crews from the controller. On the first launch after the move, the crews this window
 * kept go to the controller once, and their keys are removed after the controller holds them.
 * A failed read or import is kept for Settings to show, and the promise rejects with it.
 */
export async function loadCrews(
  source: ThreadSource,
  store: LegacyStore | null = browserStore(),
): Promise<SavedCrewsRead> {
  connected = source;
  setLoad({ state: 'loading' });
  try {
    let read = await readCrews(source);
    if (!read.imported) {
      const legacy = readLegacyCrews(store);
      read = await importCrews(source, legacy.crews, legacy.defaultCrew);
      clearLegacyCrews(store);
    }
    setSavedCrews(read);
    setLoad({ state: 'loaded' });
    return read;
  } catch (failure) {
    setLoad({
      state: 'failed',
      message: failure instanceof Error ? failure.message : 'The controller did not answer.',
    });
    throw failure;
  }
}

/** Reads the crews again from the controller the last read used. */
export const reloadCrews = () => (connected ? loadCrews(connected) : Promise.resolve(null));

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
