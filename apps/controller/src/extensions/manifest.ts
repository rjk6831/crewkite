import {
  EXTENSION_AUTHORITIES,
  EXTENSION_CONTRACT_VERSION,
  type ExtensionManifest,
  ExtensionManifestSchema,
  type ExtensionRefusal,
  ExtensionVersionSchema,
  extensionMajor,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';

export type ManifestCheck =
  | { ok: true; manifest: ExtensionManifest; hash: string }
  | { ok: false; refusal: ExtensionRefusal; line: string };

const refuse = (refusal: ExtensionRefusal, line: string): ManifestCheck => ({
  ok: false,
  refusal,
  line,
});

/**
 * Check one manifest against the contract this build offers. The order matters only for which
 * line the person reads: the specific reasons come before the general schema failure, so a bad
 * version reads as a bad version and not as an invalid manifest.
 */
export function checkManifest(
  raw: unknown,
  folder: string,
  host: string = EXTENSION_CONTRACT_VERSION,
): ManifestCheck {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return refuse('invalid-manifest', 'The manifest is not a JSON object.');
  const fields = raw as Record<string, unknown>;
  if (
    typeof fields.version !== 'string' ||
    !ExtensionVersionSchema.safeParse(fields.version).success
  )
    return refuse('bad-version', 'The manifest version is not three numbers such as 1.2.0.');
  if (
    typeof fields.contract !== 'string' ||
    !ExtensionVersionSchema.safeParse(fields.contract).success
  )
    return refuse('bad-contract', 'The manifest does not name a contract version such as 1.0.0.');
  const unknown = Array.isArray(fields.authority)
    ? fields.authority.find(
        (value) => !(EXTENSION_AUTHORITIES as readonly unknown[]).includes(value),
      )
    : undefined;
  if (unknown !== undefined)
    return refuse(
      'unknown-authority',
      `The manifest asks for authority CrewKite does not have: ${String(unknown).slice(0, 80)}.`,
    );
  const wanted = extensionMajor(fields.contract) as number;
  const offered = extensionMajor(host) as number;
  if (wanted !== offered)
    return refuse(
      'contract-major-mismatch',
      `Built for extension contract ${wanted}.x. This CrewKite offers ${offered}.x, so it stays off until the extension is updated.`,
    );
  if (Number(fields.contract.split('.')[1]) > Number(host.split('.')[1]))
    return refuse(
      'contract-too-new',
      `Built for extension contract ${fields.contract}. Update CrewKite to use it.`,
    );
  const parsed = ExtensionManifestSchema.safeParse(raw);
  if (!parsed.success)
    return refuse(
      'invalid-manifest',
      `The manifest does not match the extension contract: ${parsed.error.issues[0]?.message ?? 'unknown field'}.`.slice(
        0,
        500,
      ),
    );
  if (parsed.data.id !== folder)
    return refuse(
      'folder-mismatch',
      `The folder is named ${folder.slice(0, 64)} and the manifest ID is ${parsed.data.id}.`,
    );
  return { ok: true, manifest: parsed.data, hash: hashCanonical(parsed.data) };
}
