import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
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
import { clientFileTrust, newestByVersion, parseClientVersion } from '../../client-versions.ts';
import { DIGEST_PIECE_BYTES, fileDigest, fileDigestSync } from '../../file-digest.ts';

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
/**
 * The agent build a setup proof belongs to. Any build Google signs may serve the chat route once
 * its connect-time reads pass, so the version is the one the build reports, in the form
 * parseClientVersion reads.
 */
export const AcpClientPinSchema = z.strictObject({
  version: z
    .string()
    .max(64)
    .refine((value) => parseClientVersion(value)?.text === value),
  sha256: HashSchema,
  signerTeamId: z.string().regex(/^[A-Z0-9]{10}$/),
});
export type AcpClientPin = z.infer<typeof AcpClientPinSchema>;
/**
 * The 1.4.0 bundle Connect installs. Its pin.json, identity and evidence keep the exact build.
 * The type stays a string so a bundle identity reads as any other pin.
 */
export const AcpBundlePinSchema = AcpClientPinSchema.extend({
  version: z.string().refine((value): boolean => value === '1.4.0'),
});
export const AcpImportIdentitySchema = AcpBundlePinSchema.extend({ harnessSha256: HashSchema });
export const AcpServerMaximumBytes = 384 * 1024 * 1024;
export const AcpHarnessMaximumBytes = 128 * 1024 * 1024;
/** The 1.4.0 bundle in a home: the server and its harness, both checked against the pin. */
export type AcpClientIdentity = Readonly<
  z.infer<typeof AcpImportIdentitySchema> & { executable: string }
>;
/**
 * A Google agent outside the bundle: a copy on the device or one CrewKite fetched. It was found
 * signed by Google on this exact file, and its digest is what every launch checks again. `args`
 * is the launch line, from a closed list. `helpers` are the other programs in a fetched folder.
 */
export type AcpAgentIdentity = Readonly<{
  version: string;
  sha256: string;
  signerTeamId: string;
  executable: string;
  args: readonly string[];
  helpers: readonly { path: string; sha256: string }[];
}>;
/** Any agent the chat route can start. */
export type AcpClient = AcpClientIdentity | AcpAgentIdentity;
export const isAcpBundle = (client: AcpClient | AcpClientPin): client is AcpClientIdentity =>
  'harnessSha256' in client;
/**
 * The only launch lines an agent gets. `acp` is the subcommand a device copy serves the protocol
 * on, and `--stdio` its default transport, which a registry entry may name. CrewKite passes no
 * argument whose meaning it has not read, and never one that skips the permission prompts.
 */
export const ACP_AGENT_ARGS: readonly (readonly string[])[] = [[], ['acp'], ['acp', '--stdio']];
export const AcpReviewMappingSchema = z.strictObject({
  client: AcpBundlePinSchema,
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

/**
 * The evidence hash of a review mode a build earned from its own session, for any build without
 * a digest-keyed mapping. The IDs are the ones the 1.4.0 evidence names: the one `mode` option
 * and its `default` value, which the session must offer and confirm when set. They are protocol
 * facts, like the method names. No version, digest or model name decides them.
 */
export const ACP_EARNED_MODE = { configId: 'mode', valueId: 'default' } as const;
export const ACP_EARNED_REVIEW = hashCanonical({ rule: 'earned-review-v1', ...ACP_EARNED_MODE });

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
  client: AcpBundlePinSchema,
  signature: signatureSchema,
  harness: z.strictObject({ sha256: HashSchema, signature: signatureSchema }),
});

export function googleAcpDeveloperIdRequirement(signerTeamId: string): string {
  const team = AcpClientPinSchema.shape.signerTeamId.parse(signerTeamId);
  return `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}"`;
}

export function acpClientPin(client: AcpClient | AcpClientPin): AcpClientPin {
  return AcpClientPinSchema.parse({
    version: client.version,
    sha256: client.sha256,
    signerTeamId: client.signerTeamId,
  });
}

export function acpReviewMappingMatchesClient(
  value: AcpReviewMapping,
  client: AcpClient | AcpClientPin,
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

function parseAcpAgentIdentity(client: AcpAgentIdentity): AcpAgentIdentity {
  const path = z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => isAbsolute(value) && resolve(value) === value);
  const parsed = z
    .strictObject({
      ...AcpClientPinSchema.shape,
      executable: path,
      args: z.array(z.string().max(16)).max(2),
      helpers: z.array(z.strictObject({ path, sha256: HashSchema })).max(64),
    })
    .parse(client);
  if (!ACP_AGENT_ARGS.some((args) => JSON.stringify(args) === JSON.stringify(parsed.args)))
    throw new Error('Invalid managed launch line.');
  return parsed;
}

/**
 * An agent file runs only while it is the file whose signature was checked: the same real path,
 * still owned by the person or the system and writable by no one else, with the same digest.
 * The digest cache answers an unchanged file without reading it. A changed file is hashed again
 * and refused, so a replaced copy never runs under the earlier signature check. The size bound is
 * the bundle server's, the largest Google program seen: a fetched server is near 281 MB. The scan
 * held a device copy to its own bound, and the digest holds it to those bytes.
 */
function checkAcpAgentFile(path: string, sha256: string, reuse: boolean) {
  if (
    realpathSync(path) !== path ||
    clientFileTrust(
      lstatSync(path),
      AcpServerMaximumBytes,
      process.getuid?.(),
      lstatSync(dirname(path)),
    ) !== 'trusted' ||
    fileDigestSync(path, { reuse }) !== sha256
  )
    throw new Error('Managed executable changed.');
}

/** With reuse true, a file whose identity matches the last full hash is not read again. */
export function validateAcpClientIdentity<T extends AcpClient>(client: T, reuse = false): T {
  if (!isAcpBundle(client)) {
    const agent = parseAcpAgentIdentity(client);
    checkAcpAgentFile(agent.executable, agent.sha256, reuse);
    for (const helper of agent.helpers) checkAcpAgentFile(helper.path, helper.sha256, reuse);
    return agent as T;
  }
  return validateAcpBundleIdentity(client, reuse) as T;
}

function validateAcpBundleIdentity(client: AcpClientIdentity, reuse: boolean): AcpClientIdentity {
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
  reuse = false,
): Promise<AcpClientIdentity> {
  const parsed = parseAcpClientIdentity(client);
  if (
    (await hashAcpPrivateFileAsync(parsed.executable, AcpServerMaximumBytes, true, reuse)) !==
    parsed.sha256
  )
    throw new Error('Managed executable changed.');
  if (
    (await hashAcpPrivateFileAsync(
      harnessPath(parsed.executable),
      AcpHarnessMaximumBytes,
      true,
      reuse,
    )) !== parsed.harnessSha256
  )
    throw new Error('Managed harness changed.');
  return parsed;
}

export function validateAcpSetupProof(
  value: unknown,
  client: AcpClient | AcpClientPin,
  reviewMappings: readonly AcpReviewMapping[] = GoogleAcpReviewMappings,
): AcpSetupProof {
  const proof = AcpSetupProofSchema.parse(value);
  if (hashCanonical(proof.client) !== hashCanonical(acpClientPin(client)))
    throw new Error('Setup proof belongs to another client.');
  const mode = proof.reviewMode;
  // A build with no digest-keyed mapping earns its mode from its own session: one `mode` option
  // that offers `default`. The bundle never takes this path. Its recorded evidence decides.
  if (mode && mode.mappingEvidenceHash === ACP_EARNED_REVIEW && 'args' in client) {
    if (
      mode.configId !== ACP_EARNED_MODE.configId ||
      mode.valueId !== ACP_EARNED_MODE.valueId ||
      !proof.modeValues.length ||
      proof.modeValues.some((entry) => entry.optionId !== ACP_EARNED_MODE.configId) ||
      !proof.modeValues.some((entry) => entry.valueId === ACP_EARNED_MODE.valueId) ||
      mode.discoveryStateHash !==
        hashCanonical({ configOptions: proof.configOptions, modeValues: proof.modeValues })
    )
      throw new Error('Setup proof has no verified request-review mapping.');
  } else if (mode) {
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
export const ACP_READ_PIECE_BYTES = DIGEST_PIECE_BYTES;

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

// Profile resolution runs for every ACP notification and snapshot, and every ACP launch checks the
// bundle again. The shared digest cache answers a matching file identity without reading the
// files. The private file checks run on every call, cache or not, since they are cheap and a
// caller can ask with a different size limit. The digest itself reads with no-follow and checks
// that the file kept its identity from open to close.
function checkedAcpPrivateFile(path: string, maximum: number, executable: boolean) {
  validateAcpDirectory(dirname(path));
  checkPrivateFile(lstatSync(path), maximum, executable);
}

export function hashAcpPrivateFile(
  path: string,
  maximum: number,
  executable = false,
  reuse = false,
): string {
  checkedAcpPrivateFile(path, maximum, executable);
  return fileDigestSync(path, { reuse });
}

/**
 * The same digest for callers that can wait. A file above 16 MB is hashed in a worker thread.
 * With reuse true, a file whose identity matches the last full hash is not read again.
 */
export async function hashAcpPrivateFileAsync(
  path: string,
  maximum: number,
  executable = false,
  reuse = false,
): Promise<string> {
  checkedAcpPrivateFile(path, maximum, executable);
  return fileDigest(path, { reuse });
}

export type AcpHash = { update(chunk: Uint8Array): unknown; digest(encoding: 'hex'): string };

/**
 * Copies a staged file into the managed folder in pieces, hashing the bytes it writes, so one read
 * gives both the source digest and the copy. A source that is not the expected file, changes while
 * it is read, or hashes to another digest leaves no copy behind.
 */
export async function copyAcpPrivateFile(
  source: string,
  path: string,
  expected: { maximum: number; mode: number; sha256: string },
  create: () => AcpHash = () => createHash('sha256'),
): Promise<void> {
  validateAcpDirectory(dirname(source));
  const input = await open(source, privateFlags);
  try {
    const before = await input.stat();
    checkPrivateFile(before, expected.maximum, false);
    const output = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let complete = false;
    try {
      const hash = create();
      const piece = Buffer.allocUnsafe(Math.min(before.size, ACP_READ_PIECE_BYTES));
      let offset = 0;
      while (offset < before.size) {
        const { bytesRead } = await input.read(
          piece,
          0,
          Math.min(piece.length, before.size - offset),
          null,
        );
        if (bytesRead === 0) throw new Error('Private file changed while reading.');
        hash.update(piece.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead)
          written += (await output.write(piece, written, bytesRead - written)).bytesWritten;
        offset += bytesRead;
      }
      const after = await input.stat();
      const { bytesRead: trailing } = await input.read(Buffer.alloc(1), 0, 1, null);
      checkPrivateFileHeld(before, after, trailing, await lstat(source));
      if (hash.digest('hex') !== expected.sha256) throw new Error('Invalid private file.');
      await output.chmod(expected.mode);
      await output.sync();
      complete = true;
    } finally {
      await output.close();
      if (!complete) await unlink(path).catch(() => {});
    }
  } finally {
    await input.close();
  }
  const directory = await open(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
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
export async function readGoogleAcpPinAsync(
  home: string,
  reuse = false,
): Promise<AcpClientIdentity> {
  return validateAcpClientIdentityAsync(readGoogleAcpPinRecord(home), reuse);
}

export type AcpProfileResolution = {
  facts: z.infer<typeof GoogleAcpProfileSchema>;
  client?: AcpClient;
  environment?: NodeJS.ProcessEnv;
};

/** The launch identity of a scanned agent, without what only the scan needs. */
export const acpAgentIdentity = (agent: AcpAgentIdentity): AcpAgentIdentity => ({
  version: agent.version,
  sha256: agent.sha256,
  signerTeamId: agent.signerTeamId,
  executable: agent.executable,
  args: [...agent.args],
  helpers: agent.helpers.map((helper) => ({ path: helper.path, sha256: helper.sha256 })),
});

/**
 * The agent the route uses. The stored proof names the copy that last passed every connect-time
 * read, by digest, so that copy stays in use while it is there. Without one, or when that copy
 * is gone, setup runs on the bundle, the build I tested, and a newer copy is checked from Ready.
 * Only a home with no bundle sets up on the newest copy it has.
 */
function chooseAcpClient(
  bundle: AcpClientIdentity | undefined,
  agents: readonly AcpAgentIdentity[],
  proof: AcpSetupProof | null,
): AcpClient | undefined {
  const pool: AcpClient[] = [...(bundle ? [bundle] : []), ...agents.map(acpAgentIdentity)];
  const named = proof && pool.find((client) => client.sha256 === proof.client.sha256);
  return named ?? bundle ?? newestByVersion(pool, (client) => client.version);
}

export function resolveGoogleAcpProfile(
  options: {
    home: string;
    proof: AcpSetupProof | null;
    environment: NodeJS.ProcessEnv;
    /** Signed agents the last scan found on the device, newest first. */
    agents?: readonly AcpAgentIdentity[];
  },
  dependencies: {
    reviewMappings?: readonly AcpReviewMapping[];
    platform?: NodeJS.Platform;
    arch?: string;
  } = {},
): AcpProfileResolution {
  const agents = options.agents ?? [];
  let client: AcpClient | undefined;
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
    // With no other agent on the device the bundle is the only client, and a missing or changed
    // bundle leaves the route without one, with the reason set above.
    let bundle: AcpClientIdentity | undefined;
    try {
      bundle = readGoogleAcpPin(options.home, true);
    } catch (error) {
      if (!agents.length) throw error;
    }
    client = chooseAcpClient(bundle, agents, options.proof);
    if (!client) throw new Error('No Google agent.');
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
      // The build in use. Without one the bundle Connect installs is what the route would run.
      clientVersion: client?.version ?? '1.4.0',
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
