import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export type InstalledState = { root: string; home: string; profile: string };

const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};

/** Installed clients share paths independently of the application location. */
export function resolveInstalledState(
  environment: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  personHome: string = homedir(),
): InstalledState {
  if (platform !== 'darwin' && platform !== 'linux')
    throw new Error('Installed workspaces support macOS and Linux.');
  if (!isAbsolute(personHome)) throw new Error('Your home folder must be an absolute path.');
  const homeOverride = environment.CREWKITE_HOME;
  const profileOverride = environment.CREWKITE_PROFILE;
  if (homeOverride !== undefined || profileOverride !== undefined) {
    if (
      !homeOverride ||
      !profileOverride ||
      !isAbsolute(homeOverride) ||
      !isAbsolute(profileOverride)
    )
      throw new Error('Set both absolute CrewKite home and profile paths for isolated state.');
    const home = resolve(homeOverride);
    const profile = resolve(profileOverride);
    const root = dirname(home);
    if (home !== join(root, 'home') || profile !== join(root, 'profile'))
      throw new Error('Isolated state needs sibling home and profile folders under one root.');
    return { root, home, profile };
  }
  const data = environment.XDG_DATA_HOME;
  if (platform === 'linux' && data && !isAbsolute(data))
    throw new Error('XDG_DATA_HOME must be an absolute path.');
  const root =
    platform === 'darwin'
      ? join(personHome, 'Library/Application Support/CrewKite')
      : join(data || join(personHome, '.local/share'), 'crewkite');
  return { root, home: join(root, 'home'), profile: join(root, 'profile') };
}

/** State is writable only in real, private directories outside the application payload. */
export function prepareInstalledState(state: InstalledState, payloadRoot?: string): InstalledState {
  const { root, home, profile } = state;
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    home !== join(root, 'home') ||
    profile !== join(root, 'profile') ||
    root === parse(root).root
  )
    throw new Error('The installed state layout is invalid.');
  if (payloadRoot) {
    const payload = realpathSync(payloadRoot);
    if (inside(payload, root) || inside(root, payload))
      throw new Error('Installed state must stay separate from application files.');
  }
  for (const destination of [root, home, profile]) preparePrivateStateDirectory(root, destination);
  return state;
}

/** Private state never follows linked parents or leaves its selected root. */
export function preparePrivateStateDirectory(root: string, destination: string): string {
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    root === parse(root).root ||
    !isAbsolute(destination) ||
    resolve(destination) !== destination ||
    !inside(root, destination)
  )
    throw new Error('Private state must stay inside its selected root.');
  let current = parse(destination).root;
  for (const part of relative(current, destination).split(sep)) {
    current = join(current, part);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const entry = lstatSync(current);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('Installed state paths must contain real directories without links.');
    if (
      inside(root, current) &&
      (entry.uid !== process.getuid?.() || (entry.mode & 0o777) !== 0o700)
    )
      throw new Error('Installed state directories must be private to their owner.');
  }
  if (realpathSync(destination) !== destination)
    throw new Error('The installed state path changed.');
  return destination;
}
