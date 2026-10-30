import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

// `pnpm desktop` runs the real controller from a source checkout on the person's own CrewKite
// home. This guard keeps the state root equal to the person's home folder, keeps the CrewKite
// home and the desktop profile inside it and apart from each other, and keeps both away from the
// checkout and its internal folder, where the demo and the owner's tools live.

const inside = (base: string, path: string) => path === base || path.startsWith(`${base}${sep}`);

/**
 * The state root, home and profile for a source desktop on the real controller. Throws when the
 * root is not the person's home folder, when a path is the root, outside it or shared with the
 * other, and when a path is, holds or sits inside the checkout or its internal folder.
 */
export function sourceDesktopState(
  checkout: string,
  stateRoot: string,
  homePath: string,
  profilePath: string,
  personHome: string = homedir(),
) {
  if (!isAbsolute(stateRoot)) throw new Error('The CrewKite state root must be an absolute path.');
  const root = realpathSync(stateRoot);
  if (root !== realpathSync(personHome))
    throw new Error('The CrewKite state root must be your home folder.');
  const home = resolve(homePath);
  const profile = resolve(profilePath);
  const kept = [checkout, join(checkout, 'internal')];
  for (const folder of [...kept]) if (existsSync(folder)) kept.push(realpathSync(folder));
  for (const path of [home, profile]) {
    if (kept.some((folder) => inside(folder, path) || inside(path, folder)))
      throw new Error('The desktop must not keep state in or around this checkout.');
    if (!inside(root, path) || path === root)
      throw new Error('Keep the CrewKite home and desktop profile inside your home folder.');
  }
  if (inside(home, profile) || inside(profile, home))
    throw new Error('Choose separate CrewKite home and desktop profile folders.');
  return { root, home, profile };
}
