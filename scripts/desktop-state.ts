import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

// `pnpm desktop` runs the real controller from a source checkout on the person's own CrewKite
// home. This guard keeps that home, the desktop profile and the state root away from the
// checkout's internal folder, where the demo and the owner's tools live, and keeps both state
// folders apart and inside the state root.

const inside = (base: string, path: string) => path === base || path.startsWith(`${base}${sep}`);

/**
 * The state root, home and profile for a source desktop on the real controller. Throws when any
 * of them sits in the checkout's internal folder, outside the state root, or in the other.
 */
export function sourceDesktopState(
  checkout: string,
  stateRoot: string,
  homePath: string,
  profilePath: string,
) {
  const root = realpathSync(stateRoot);
  const home = resolve(homePath);
  const profile = resolve(profilePath);
  const internal = [join(checkout, 'internal')];
  if (existsSync(internal[0])) internal.push(realpathSync(internal[0]));
  if (!isAbsolute(stateRoot)) throw new Error('The CrewKite state root must be an absolute path.');
  for (const path of [home, profile]) {
    if (internal.some((folder) => inside(folder, path)))
      throw new Error('The desktop must not use the internal folder of this checkout for state.');
    if (!inside(root, path) || path === root)
      throw new Error('Keep the CrewKite home and desktop profile inside your home folder.');
  }
  if (inside(home, profile) || inside(profile, home))
    throw new Error('Choose separate CrewKite home and desktop profile folders.');
  return { root, home, profile };
}
