import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyRuntimeIntegrity } from '../packages/client/src/runtime-integrity.ts';
import { CREWKITE_VERSION } from '../packages/contracts/src/version.ts';
import {
  assertInventory,
  assessArtifact,
  createReleaseDirectory,
  fileHash,
  notarizeArtifact,
  packageInventory,
  readReleaseRecord,
  releaseDestination,
  releaseEnvironment,
  releaseTools,
  verifyDeveloperSignature,
} from './package-sign.mjs';

const filename = 'CrewKite-macOS-arm64.dmg';
const fail = (phase) => new Error(`Disk image preparation failed during ${phase}.`);
const contains = (root, path) => {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};

/** The image wraps the exact stapled app; its receipt and final digest stay outside the image. */
export async function buildDmg(
  { source, destination, revision, environment = process.env },
  dependencies = {},
) {
  const { identity, profile } = releaseEnvironment(environment);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw fail('macOS arm64 host');
  source = realpathSync(source);
  destination = releaseDestination(source, destination);
  if (
    !/^[0-9a-f]{40}$/.test(revision ?? '') ||
    contains(source, destination) ||
    contains(destination, source)
  )
    throw fail('source selection');
  const inputPath = join(source, 'release-receipt.json');
  const inputRecord = readReleaseRecord(inputPath);
  const inputHash = inputRecord.sha256;
  const input = inputRecord.value;
  if (
    input.version !== 1 ||
    input.kind !== 'signed-app' ||
    input.productVersion !== CREWKITE_VERSION ||
    input.revision !== revision ||
    input.app !== 'CrewKite.app' ||
    input.developerID !== true ||
    input.hardenedRuntime !== true ||
    input.notary?.status !== 'Accepted' ||
    input.notary.stapled !== true ||
    input.assessment?.accepted !== true
  )
    throw fail('signed application receipt');
  const originalApp = join(source, 'CrewKite.app');
  assertInventory(originalApp, input.files);
  verifyRuntimeIntegrity(join(originalApp, 'Contents/Resources/app/runtime'));
  const run = releaseTools(dependencies);
  await verifyDeveloperSignature(originalApp, { identity, executable: true, deep: true }, run);
  await run('source ticket validation', '/usr/bin/xcrun', ['stapler', 'validate', originalApp]);
  createReleaseDirectory(destination);
  const staging = join(destination, 'image-source');
  mkdirSync(staging, { mode: 0o700 });
  const copiedApp = join(staging, 'CrewKite.app');
  await run('application copy', '/usr/bin/ditto', [originalApp, copiedApp]);
  assertInventory(copiedApp, input.files);
  await run('copied ticket validation', '/usr/bin/xcrun', ['stapler', 'validate', copiedApp]);
  // This absolute link is presentation metadata outside the contained app payload.
  symlinkSync('/Applications', join(staging, 'Applications'));
  const image = join(destination, filename);
  await run(
    'image creation',
    '/usr/bin/hdiutil',
    [
      'create',
      '-volname',
      'CrewKite',
      '-srcfolder',
      staging,
      '-format',
      'UDZO',
      '-fs',
      'HFS+',
      image,
    ],
    { timeout: 120000 },
  );
  await run('image signing', '/usr/bin/codesign', [
    '--force',
    '--sign',
    identity,
    '--timestamp',
    image,
  ]);
  await verifyDeveloperSignature(image, { identity }, run);
  const notary = await notarizeArtifact(
    image,
    profile,
    run,
    image,
    join(destination, 'notary-image-state.json'),
  );
  const assessment = await assessArtifact(image, 'dmg', run);
  await run('image verification', '/usr/bin/hdiutil', ['verify', image], { timeout: 120000 });
  const sealedImageHash = fileHash(image);
  const mount = join(destination, 'mounted');
  mkdirSync(mount, { mode: 0o700 });
  await run(
    'image mounting',
    '/usr/bin/hdiutil',
    ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, image],
    { timeout: 120000 },
  );
  let mountedFiles;
  try {
    if (readdirSync(mount).sort().join('\n') !== 'Applications\nCrewKite.app')
      throw fail('mounted payload');
    const mountedApp = join(mount, 'CrewKite.app');
    assertInventory(mountedApp, input.files);
    mountedFiles = packageInventory(mountedApp);
    const link = join(mount, 'Applications');
    if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== '/Applications')
      throw fail('Applications link');
    await run('mounted ticket validation', '/usr/bin/xcrun', ['stapler', 'validate', mountedApp]);
    await run('mounted application integrity', '/usr/bin/codesign', [
      '--verify',
      '--deep',
      '--strict',
      mountedApp,
    ]);
    verifyRuntimeIntegrity(join(mountedApp, 'Contents/Resources/app/runtime'));
  } finally {
    await run('image detach', '/usr/bin/hdiutil', ['detach', mount]);
  }
  assertInventory(originalApp, input.files);
  if (fileHash(inputPath) !== inputHash) throw fail('immutable source receipt');
  const sha256 = fileHash(image);
  if (sha256 !== sealedImageHash) throw fail('immutable notarized image');
  const receipt = {
    version: 1,
    kind: 'disk-image',
    productVersion: CREWKITE_VERSION,
    revision,
    asset: filename,
    sha256,
    inputReceiptSha256: inputHash,
    appFiles: mountedFiles,
    notary,
    assessment,
  };
  const receiptPath = join(destination, 'dmg-receipt.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  writeFileSync(join(destination, 'SHA256SUMS'), `${sha256}  ${filename}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  return { image, receipt: receiptPath, sha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        source: { type: 'string' },
        destination: { type: 'string' },
        revision: { type: 'string' },
      },
    });
    const result = await buildDmg(values);
    console.log(`Disk image receipt: ${result.receipt}`);
  } catch (error) {
    console.error(
      error instanceof Error && error.message.startsWith('Set CREWKITE_')
        ? error.message
        : 'Disk image preparation failed. The signed app was preserved.',
    );
    process.exitCode = 1;
  }
}
