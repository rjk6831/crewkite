import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The reference extension: one harmless thread action that counts a thread's recent messages. */
export const sampleExtensionId = 'thread-stats';
export const sampleExtensionDirectory = fileURLToPath(
  new URL('./extensions/thread-stats/', import.meta.url),
);

/** Copy the reference extension into a controller home. It stays off until turned on. */
export function installSampleExtension(home: string): string {
  const target = join(home, 'extensions', sampleExtensionId);
  cpSync(sampleExtensionDirectory, target, { recursive: true });
  return target;
}
