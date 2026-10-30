// The Biome binary ships as one optional package per platform, all at the same version as
// @biomejs/biome. The trusted build and the package script pick the one for this computer. Linux
// takes the glibc packages for x64 and arm64; the musl packages are not part of the preview.

const PACKAGES: Record<string, Record<string, string>> = {
  darwin: { arm64: '@biomejs/cli-darwin-arm64' },
  linux: { x64: '@biomejs/cli-linux-x64', arm64: '@biomejs/cli-linux-arm64' },
};

/** True when the running Node reports a glibc runtime, which a musl system does not. */
export function hostUsesGlibc(): boolean {
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: unknown } }
      | undefined;
    return typeof report?.header?.glibcVersionRuntime === 'string';
  } catch {
    return false;
  }
}

/** The package that holds the Biome binary for a computer, or null where none is supported. */
export function biomePackageName(
  host: { platform: string; arch: string } = process,
  glibc: boolean = host.platform === 'linux' ? hostUsesGlibc() : true,
): string | null {
  if (host.platform === 'linux' && !glibc) return null;
  return Object.hasOwn(PACKAGES, host.platform)
    ? (PACKAGES[host.platform][host.arch] ?? null)
    : null;
}
