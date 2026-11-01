import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  type Stats,
} from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import {
  GoogleAcpCapabilitiesSchema,
  GoogleAcpConfigurationSchema,
  GoogleAcpProfileSchema,
  HashSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { z } from 'zod';

const identifier = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.isWellFormed() && !/\p{Cc}/u.test(value));
/**
 * The option ID a configuration carries when the client lists its models in the session reply
 * (`models.availableModels`) and not as a config option. The model then changes with
 * `session/set_model`, which a config option ID cannot name.
 */
export const ACP_SESSION_MODELS = 'session/models';
export const AcpClientPinSchema = z.strictObject({
  version: z.literal('1.4.0'),
  sha256: HashSchema,
  signerTeamId: z.string().regex(/^[A-Z0-9]{10}$/),
});
export type AcpClientPin = z.infer<typeof AcpClientPinSchema>;
export const AcpImportIdentitySchema = AcpClientPinSchema.extend({ harnessSha256: HashSchema });
export const AcpServerMaximumBytes = 384 * 1024 * 1024;
export const AcpHarnessMaximumBytes = 128 * 1024 * 1024;
export type AcpClientIdentity = Readonly<
  z.infer<typeof AcpImportIdentitySchema> & { executable: string }
>;
export const AcpReviewMappingSchema = z.strictObject({
  client: AcpClientPinSchema,
  harnessSha256: HashSchema.optional(),
  surface: z.literal('config'),
  configId: identifier,
  valueId: identifier,
  semantics: z.literal('request-review'),
  evidenceHash: HashSchema,
});
export type AcpReviewMapping = z.infer<typeof AcpReviewMappingSchema>;
export const GoogleAcpReviewMappings: readonly AcpReviewMapping[] = Object.freeze([
  {
    client: {
      version: '1.4.0',
      sha256: '34e0cd2fe6fcafc4b280a81d38026c55689e54c0619c6729a781f1ebfefa1d88',
      signerTeamId: 'EQHXZ8M8AV',
    },
    harnessSha256: 'e7d236a0761ef904cee649e6f42e56861ca953457f8f62bcd0cdf649640d0ff5',
    surface: 'config',
    configId: 'mode',
    valueId: 'default',
    semantics: 'request-review',
    evidenceHash: 'abe9f3af6f37ec81399df78fe1672964f07fe9daf0258398803dd39bc5c2080a',
  },
]);
export const AcpSetupProofSchema = z
  .strictObject({
    version: z.literal(1),
    profileId: z.literal('google-acp-v1'),
    client: AcpClientPinSchema,
    capabilities: GoogleAcpCapabilitiesSchema,
    configOptions: GoogleAcpConfigurationSchema.nullable(),
    auth: z.strictObject({
      method: z.literal('oauth-personal').nullable(),
      status: z.enum(['unknown', 'required', 'authenticated']),
    }),
    reviewMode: z
      .strictObject({
        surface: z.literal('config'),
        configId: identifier,
        valueId: identifier,
        semantics: z.literal('request-review'),
        mappingEvidenceHash: HashSchema,
        discoveryStateHash: HashSchema,
      })
      .nullable(),
    modeValues: z.array(z.strictObject({ optionId: identifier, valueId: identifier })).max(1024),
  })
  .refine(
    (proof) =>
      new Set(proof.modeValues.map((mode) => `${mode.optionId}\0${mode.valueId}`)).size ===
      proof.modeValues.length,
    'Observed mode values must be distinct.',
  );
export type AcpSetupProof = z.infer<typeof AcpSetupProofSchema>;

const signatureSchema = z.strictObject({
  method: z.literal('macos-codesign'),
  verified: z.literal(true),
  requirement: z.string().min(1).max(1024),
  sha256: HashSchema,
  signerTeamId: z.string().regex(/^[A-Z0-9]{10}$/),
});
export const AcpImportPinSchema = z.strictObject({
  version: z.literal(2),
  profileId: z.literal('google-acp-v1'),
  client: AcpClientPinSchema,
  signature: signatureSchema,
  harness: z.strictObject({ sha256: HashSchema, signature: signatureSchema }),
});

export function googleAcpDeveloperIdRequirement(signerTeamId: string): string {
  const team = AcpClientPinSchema.shape.signerTeamId.parse(signerTeamId);
  return `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}"`;
}

export function acpClientPin(client: AcpClientIdentity | AcpClientPin): AcpClientPin {
  return AcpClientPinSchema.parse({
    version: client.version,
    sha256: client.sha256,
    signerTeamId: client.signerTeamId,
  });
}

export function acpReviewMappingMatchesClient(
  value: AcpReviewMapping,
  client: AcpClientIdentity | AcpClientPin,
): boolean {
  const mapping = AcpReviewMappingSchema.parse(value);
  return (
    hashCanonical(mapping.client) === hashCanonical(acpClientPin(client)) &&
    (mapping.harnessSha256 === undefined ||
      ('harnessSha256' in client && mapping.harnessSha256 === client.harnessSha256))
  );
}

function parseAcpClientIdentity(client: AcpClientIdentity): AcpClientIdentity {
  const parsed = z
    .strictObject({ ...AcpImportIdentitySchema.shape, executable: z.string().min(1).max(4096) })
    .parse(client);
  if (!isAbsolute(parsed.executable) || resolve(parsed.executable) !== parsed.executable)
    throw new Error('Invalid managed executable path.');
  return parsed;
}

const harnessPath = (executable: string) => join(dirname(executable), 'localharness_external');

/** Spawn keeps the default full hash. Only profile resolution reuses a matching digest. */
export function validateAcpClientIdentity(
  client: AcpClientIdentity,
  reuse = false,
): AcpClientIdentity {
  const parsed = parseAcpClientIdentity(client);
  if (hashAcpPrivateFile(parsed.executable, AcpServerMaximumBytes, true, reuse) !== parsed.sha256)
    throw new Error('Managed executable changed.');
  if (
    hashAcpPrivateFile(harnessPath(parsed.executable), AcpHarnessMaximumBytes, true, reuse) !==
    parsed.harnessSha256
  )
    throw new Error('Managed harness changed.');
  return parsed;
}

/** The same full check, read in pieces that let other work run between them. */
export async function validateAcpClientIdentityAsync(
  client: AcpClientIdentity,
): Promise<AcpClientIdentity> {
  const parsed = parseAcpClientIdentity(client);
  if (
    (await hashAcpPrivateFileAsync(parsed.executable, AcpServerMaximumBytes, true)) !==
    parsed.sha256
  )
    throw new Error('Managed executable changed.');
  if (
    (await hashAcpPrivateFileAsync(
      harnessPath(parsed.executable),
      AcpHarnessMaximumBytes,
      true,
    )) !== parsed.harnessSha256
  )
    throw new Error('Managed harness changed.');
  return parsed;
}

export function validateAcpSetupProof(
  value: unknown,
  client: AcpClientIdentity | AcpClientPin,
  reviewMappings: readonly AcpReviewMapping[] = GoogleAcpReviewMappings,
): AcpSetupProof {
  const proof = AcpSetupProofSchema.parse(value);
  if (hashCanonical(proof.client) !== hashCanonical(acpClientPin(client)))
    throw new Error('Setup proof belongs to another client.');
  const mode = proof.reviewMode;
  if (mode) {
    const matches = reviewMappings
      .map((entry) => AcpReviewMappingSchema.parse(entry))
      .filter(
        (entry) =>
          acpReviewMappingMatchesClient(entry, client) &&
          entry.surface === mode.surface &&
          entry.configId === mode.configId &&
          entry.valueId === mode.valueId &&
          entry.evidenceHash === mode.mappingEvidenceHash,
      );
    if (
      matches.length !== 1 ||
      !proof.modeValues.some(
        (entry) => entry.optionId === mode.configId && entry.valueId === mode.valueId,
      ) ||
      mode.discoveryStateHash !==
        hashCanonical({ configOptions: proof.configOptions, modeValues: proof.modeValues })
    )
      throw new Error('Setup proof has no verified request-review mapping.');
  }
  if (
    proof.auth.status === 'authenticated' &&
    (proof.auth.method !== 'oauth-personal' ||
      !proof.capabilities.authMethods.includes('oauth-personal'))
  )
    throw new Error('Setup authentication proof is incomplete.');
  return proof;
}

/** Parent links are checked before opening private files with no-follow semantics. */
export function validateAcpDirectory(directory: string, privateRoot?: string): string {
  if (!isAbsolute(directory) || resolve(directory) !== directory)
    throw new Error('Storage requires a canonical absolute path.');
  const root = privateRoot ?? directory;
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    (directory !== root && !directory.startsWith(`${root}/`))
  )
    throw new Error('Storage escapes its root.');
  let current = parse(directory).root;
  for (const part of directory.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    const state = lstatSync(current);
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new Error('Storage contains a linked parent.');
    if (
      (current === root || current.startsWith(`${root}/`)) &&
      (state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0)
    )
      throw new Error('Storage must be private and owned.');
  }
  return directory;
}

const privateFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function checkPrivateFile(state: Stats, maximum: number, executable: boolean) {
  if (
    !state.isFile() ||
    state.nlink !== 1 ||
    state.uid !== process.getuid?.() ||
    state.size < 1 ||
    state.size > maximum ||
    (state.mode & 0o7077) !== 0 ||
    (executable && (state.mode & 0o700) !== 0o500)
  )
    throw new Error('Invalid private file.');
}

function checkPrivateFileHeld(before: Stats, after: Stats, trailing: number, current: Stats) {
  if (
    trailing !== 0 ||
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new Error('Private file changed while reading.');
  if (current.ino !== after.ino || current.dev !== after.dev || current.isSymbolicLink())
    throw new Error('Private file was replaced.');
}

/**
 * The managed client is about 400 MB. One read of the whole file into one buffer, then one hash of
 * it, held the event loop for seconds, and every socket in the controller waited. Reads of large
 * files go in pieces of this size, which take a few milliseconds each.
 */
export const ACP_READ_PIECE_BYTES = 8 * 1024 * 1024;

export function readAcpPrivateFile(path: string, maximum: number, executable = false): Buffer {
  validateAcpDirectory(dirname(path));
  const descriptor = openSync(path, privateFlags);
  try {
    const before = fstatSync(descriptor);
    checkPrivateFile(before, maximum, executable);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) throw new Error('Private file changed while reading.');
      offset += count;
    }
    const after = fstatSync(descriptor);
    const trailing = readSync(descriptor, Buffer.alloc(1), 0, 1, null);
    checkPrivateFileHeld(before, after, trailing, lstatSync(path));
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

/** The sha256 of a private file, read with the same checks as `readAcpPrivateFile`. */
function digestAcpPrivateFile(path: string, maximum: number, executable: boolean): string {
  validateAcpDirectory(dirname(path));
  const descriptor = openSync(path, privateFlags);
  try {
    const before = fstatSync(descriptor);
    checkPrivateFile(before, maximum, executable);
    const hash = createHash('sha256');
    const piece = Buffer.allocUnsafe(Math.min(before.size, ACP_READ_PIECE_BYTES));
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(
        descriptor,
        piece,
        0,
        Math.min(piece.length, before.size - offset),
        null,
      );
      if (count === 0) throw new Error('Private file changed while reading.');
      hash.update(piece.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(descriptor);
    const trailing = readSync(descriptor, Buffer.alloc(1), 0, 1, null);
    checkPrivateFileHeld(before, after, trailing, lstatSync(path));
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

/** The same digest, one awaited piece at a time, so sockets and timers run between pieces. */
async function digestAcpPrivateFileAsync(
  path: string,
  maximum: number,
  executable: boolean,
): Promise<string> {
  validateAcpDirectory(dirname(path));
  const file = await open(path, privateFlags);
  try {
    const before = await file.stat();
    checkPrivateFile(before, maximum, executable);
    const hash = createHash('sha256');
    const piece = Buffer.allocUnsafe(Math.min(before.size, ACP_READ_PIECE_BYTES));
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await file.read(
        piece,
        0,
        Math.min(piece.length, before.size - offset),
        null,
      );
      if (bytesRead === 0) throw new Error('Private file changed while reading.');
      hash.update(piece.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await file.stat();
    const { bytesRead: trailing } = await file.read(Buffer.alloc(1), 0, 1, null);
    checkPrivateFileHeld(before, after, trailing, await lstat(path));
    return hash.digest('hex');
  } finally {
    await file.close();
  }
}

// Profile resolution runs for every ACP notification and snapshot, and the
// managed bundle is about 400 MB. Hashing it each time stalls the event loop.
// A write, chmod, link or replacement changes the inode or ctime, so matching
// metadata reuses the last full digest.
// shortcut: a filesystem with coarse timestamps could hide a same-size rewrite
// inside one tick. Upgrade: skip reuse while ctime is within two seconds of the hash.
const digests = new Map<string, { key: string; sha256: string }>();
function digestKey(path: string, maximum: number, executable: boolean) {
  const state = lstatSync(path, { bigint: true });
  return [
    maximum,
    executable,
    state.dev,
    state.ino,
    state.size,
    state.mtimeNs,
    state.ctimeNs,
    state.mode,
  ].join(':');
}

export function hashAcpPrivateFile(
  path: string,
  maximum: number,
  executable = false,
  reuse = false,
): string {
  validateAcpDirectory(dirname(path));
  const key = digestKey(path, maximum, executable);
  const known = digests.get(path);
  if (reuse && known?.key === key) return known.sha256;
  const sha256 = digestAcpPrivateFile(path, maximum, executable);
  if (digestKey(path, maximum, executable) === key) digests.set(path, { key, sha256 });
  return sha256;
}

/** A full hash that never reuses a digest. It leaves one behind for profile resolution. */
export async function hashAcpPrivateFileAsync(
  path: string,
  maximum: number,
  executable = false,
): Promise<string> {
  validateAcpDirectory(dirname(path));
  const key = digestKey(path, maximum, executable);
  const sha256 = await digestAcpPrivateFileAsync(path, maximum, executable);
  if (digestKey(path, maximum, executable) === key) digests.set(path, { key, sha256 });
  return sha256;
}

/** The pinned identity, checked against its receipts and layout. The files are not hashed yet. */
function readGoogleAcpPinRecord(home: string): AcpClientIdentity {
  validateAcpDirectory(home);
  const root = join(home, 'providers/google-acp-v1');
  validateAcpDirectory(root, home);
  const bytes = readAcpPrivateFile(join(root, 'pin.json'), 4096);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const pin = AcpImportPinSchema.parse(JSON.parse(text));
  if (
    pin.signature.sha256 !== pin.client.sha256 ||
    pin.signature.signerTeamId !== pin.client.signerTeamId ||
    pin.signature.requirement !== googleAcpDeveloperIdRequirement(pin.client.signerTeamId) ||
    pin.harness.signature.sha256 !== pin.harness.sha256 ||
    pin.harness.signature.signerTeamId !== pin.client.signerTeamId ||
    pin.harness.signature.requirement !== googleAcpDeveloperIdRequirement(pin.client.signerTeamId)
  )
    throw new Error('Import signature receipt does not match the pin.');
  const executable = join(root, pin.client.sha256, 'agy_acp_server.par');
  validateAcpDirectory(dirname(executable), home);
  if (
    JSON.stringify(readdirSync(dirname(executable)).sort()) !==
    JSON.stringify(['agy_acp_server.par', 'localharness_external'])
  )
    throw new Error('Managed bundle contains unexpected files.');
  return { ...pin.client, harnessSha256: pin.harness.sha256, executable };
}

export function readGoogleAcpPin(home: string, reuse = false): AcpClientIdentity {
  return validateAcpClientIdentity(readGoogleAcpPinRecord(home), reuse);
}

/** The full check of `readGoogleAcpPin`, for callers that can wait for it. */
export async function readGoogleAcpPinAsync(home: string): Promise<AcpClientIdentity> {
  return validateAcpClientIdentityAsync(readGoogleAcpPinRecord(home));
}

export type AcpProfileResolution = {
  facts: z.infer<typeof GoogleAcpProfileSchema>;
  client?: AcpClientIdentity;
  environment?: NodeJS.ProcessEnv;
};

export function resolveGoogleAcpProfile(
  options: { home: string; proof: AcpSetupProof | null; environment: NodeJS.ProcessEnv },
  dependencies: {
    reviewMappings?: readonly AcpReviewMapping[];
    platform?: NodeJS.Platform;
    arch?: string;
  } = {},
): AcpProfileResolution {
  let client: AcpClientIdentity | undefined;
  let proof: AcpSetupProof | null = null;
  let reason: z.infer<typeof GoogleAcpProfileSchema>['reason'] = 'client-unavailable';
  let environment: NodeJS.ProcessEnv | undefined;
  try {
    if (
      (dependencies.platform ?? process.platform) !== 'darwin' ||
      (dependencies.arch ?? process.arch) !== 'arm64'
    ) {
      reason = 'unsupported-platform';
      throw new Error('Unsupported platform.');
    }
    try {
      lstatSync(join(options.home, 'providers/google-acp-v1/pin.json'));
      reason = 'client-build-mismatch';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    client = readGoogleAcpPin(options.home, true);
    reason = 'acp-capability-missing';
    if (options.environment.HOME !== userInfo().homedir) reason = 'native-home-unavailable';
    else {
      environment = { HOME: options.environment.HOME, LANG: 'C' };
      for (const key of ['USER', 'LOGNAME', 'PATH', 'TERM'])
        if (options.environment[key] !== undefined) environment[key] = options.environment[key];
      if (options.proof)
        proof = validateAcpSetupProof(options.proof, client, dependencies.reviewMappings);
      if (proof && !proof.capabilities.authMethods.includes('oauth-personal'))
        reason = 'auth-method-mismatch';
      else if (proof && proof.auth.status !== 'authenticated') reason = 'authentication-required';
      else if (proof?.configOptions && proof.reviewMode) reason = 'qualification-pending';
    }
  } catch {
    proof = null;
  }
  const config = proof?.configOptions ?? null;
  return {
    facts: GoogleAcpProfileSchema.parse({
      id: 'google-acp-v1',
      family: 'google',
      displayName: 'Google ACP single-file proposal',
      clientVersion: '1.4.0',
      model: config?.model.currentValue ?? 'unknown',
      effort: config?.thoughtLevel?.currentValue ?? 'unknown',
      effortSupported: config?.thoughtLevel?.supported ?? [],
      effectiveEffort: 'unknown',
      accountClass: 'unknown',
      serviceTier: 'unknown',
      billingBasis: 'requires-user-attestation',
      qualifiedAt: null,
      creditPolicies: ['ordinary'],
      permissionModes: ['request-review'],
      maximumTaskMs: 600000,
      maximumFileBytes: 65536,
      maximumSubmissions: 1,
      available: reason === 'qualification-pending',
      reason,
      configOptions: config,
      capabilities: proof?.capabilities ?? null,
    }),
    ...(client ? { client } : {}),
    ...(environment ? { environment } : {}),
  };
}
