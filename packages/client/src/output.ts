import { createHash } from 'node:crypto';
import { type Artifact, type ArtifactRange, ArtifactRangeSchema } from '@crewkite/contracts';

// A receiver may stage bytes as they arrive. Only the returned proof verifies the complete content.
export async function transferArtifact(
  artifact: Artifact,
  read: (input: { artifactId: string; offset: number; limit: number }) => Promise<ArtifactRange>,
  receive: (bytes: Uint8Array) => void | Promise<void>,
  options: { signal?: AbortSignal } = {},
): Promise<{ integrity: 'whole-verified'; hash: string; bytes: number }> {
  const digest = createHash('sha256');
  let offset = 0;
  do {
    options.signal?.throwIfAborted();
    const page = ArtifactRangeSchema.parse(
      await read({ artifactId: artifact.id, offset, limit: 65536 }),
    );
    options.signal?.throwIfAborted();
    const bytes = Buffer.from(page.content, 'base64');
    if (
      page.offset !== offset ||
      page.artifact.id !== artifact.id ||
      page.artifact.hash !== artifact.hash ||
      page.artifact.bytes !== artifact.bytes ||
      page.artifact.mediaType !== artifact.mediaType ||
      bytes.toString('base64') !== page.content
    )
      throw Error('Artifact range identity changed.');
    digest.update(bytes);
    await receive(bytes);
    offset += bytes.length;
    if (page.eof) break;
  } while (offset < artifact.bytes);
  options.signal?.throwIfAborted();
  if (offset !== artifact.bytes || digest.digest('hex') !== artifact.hash)
    throw Error('Artifact checksum failed.');
  return { integrity: 'whole-verified', hash: artifact.hash, bytes: offset };
}
