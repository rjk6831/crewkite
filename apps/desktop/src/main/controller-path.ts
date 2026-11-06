/**
 * The PATH the controller starts with. An app opened from Finder gets only the system folders, so
 * project checks could not find node or npm from Homebrew or the official installer. macOS adds
 * those install folders after the PATH it was given; a PATH from a terminal keeps its own order.
 */
export function controllerPath(path: string | undefined, platform: string): string | undefined {
  if (platform !== 'darwin') return path;
  const have = (path ?? '').split(':').filter((entry) => entry !== '');
  const extra = ['/opt/homebrew/bin', '/usr/local/bin'].filter((entry) => !have.includes(entry));
  const joined = [...have, ...extra].join(':');
  return joined === '' ? path : joined;
}
