import type { DesktopAttachmentTarget } from '@crewkite/client';
import { TASK_ID_PATTERN } from './thread-notice.ts';

// The one request shape the page sends main to open a file it stored for a thread. The page names
// the file by thread, hash and name, never by path, and main builds the path under the controller
// home. Main checks the shape on every call because the renderer is not trusted.

export type AttachmentTarget = DesktopAttachmentTarget;
export type AttachmentAction = AttachmentTarget['action'];

/** The extensions that preview. Quick Look and the default viewer handle each of them. */
export const PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.heic',
  '.pdf',
]);

export const ATTACHMENT_ID_PATTERN = /^[a-f0-9]{64}$/;
const ACTIONS: readonly AttachmentAction[] = ['preview', 'reveal', 'save'];

export function attachmentTarget(value: unknown): AttachmentTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const { action, taskId, id, name } = input;
  if (Object.keys(input).length !== 4) return null;
  if (!ACTIONS.includes(action as AttachmentAction)) return null;
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) return null;
  if (typeof id !== 'string' || !ATTACHMENT_ID_PATTERN.test(id)) return null;
  // The controller stores a name with no folder part, so anything else was not stored by it.
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > 255 ||
    name === '.' ||
    name === '..' ||
    /[/\\\p{Cc}]/u.test(name)
  )
    return null;
  return { action: action as AttachmentAction, taskId, id, name };
}
