import { z } from 'zod';

// Thread export. The controller renders a thread as Markdown or as a read-only share page, and the
// desktop and the command line write the result to a file the person chose. Nothing here uploads.

const taskId = z.string().regex(/^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

export const ExportFormatSchema = z.enum(['markdown', 'html']);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

/**
 * The most bytes of rendered text one export carries. A command result has to fit one 1 MiB frame
 * after JSON escaping, which can double what a line break or a quote costs. The renderer leaves
 * out the oldest messages to stay under it and says how many.
 */
export const EXPORT_CONTENT_BYTES = 400 * 1024;

export const ExportChatThreadPayloadSchema = z.strictObject({
  taskId,
  format: ExportFormatSchema,
});

export const ChatExportSchema = z.strictObject({
  taskId,
  format: ExportFormatSchema,
  /** A name the save dialog offers. It holds only lower case letters, digits and hyphens. */
  filename: z.string().regex(/^crewkite-[a-z0-9-]{1,60}\.(md|html)$/),
  content: z
    .string()
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= EXPORT_CONTENT_BYTES,
      'An export stays within its byte bound.',
    ),
  /** Turns in the thread. */
  turns: z.number().int().nonnegative(),
  /** Messages left out of the file because the whole thread did not fit the bound. */
  omitted: z.number().int().nonnegative(),
});
export type ChatExport = z.infer<typeof ChatExportSchema>;
