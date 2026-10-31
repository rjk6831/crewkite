import { z } from 'zod';

// The diagnostics bundle. The controller builds every part from its own home and store, redacted,
// and the desktop or the CLI writes the parts into a folder the person chose. Nothing is sent
// anywhere.

const taskId = z.string().regex(/^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

/** Every part of the bundle, in the order the person sees them. The builder writes exactly these. */
export const DIAGNOSTIC_PARTS = [
  {
    name: 'versions.json',
    about: 'The versions of CrewKite, the controller, Electron, Node and the operating system.',
  },
  {
    name: 'clients.json',
    about: 'Each provider client the controller pinned, with its version and SHA-256 digest.',
  },
  {
    name: 'settings.json',
    about: 'The saved command line settings, with secrets removed.',
  },
  {
    name: 'controller.log',
    about:
      'The end of the controller log, with secrets, your home folder and email addresses removed.',
  },
  {
    name: 'thread-events.json',
    about: 'The last 200 events of the open thread, redacted the same way.',
  },
  {
    name: 'system.json',
    about: 'Architecture, memory and free disk space on the volume that holds your home folder.',
  },
  {
    name: 'google-setup.json',
    about:
      'The Google setup and install state, the recent Google client operations and why each Google profile is or is not ready.',
  },
] as const;
export const DIAGNOSTIC_PART_NAMES = DIAGNOSTIC_PARTS.map((part) => part.name) as [
  (typeof DIAGNOSTIC_PARTS)[number]['name'],
  ...(typeof DIAGNOSTIC_PARTS)[number]['name'][],
];
export const DiagnosticPartNameSchema = z.enum(DIAGNOSTIC_PART_NAMES);

/** The most bytes of the controller log the bundle carries. */
export const DIAGNOSTIC_LOG_BYTES = 64 * 1024;
/** The most events the bundle carries for a thread. */
export const DIAGNOSTIC_EVENTS = 200;
/** The most bytes of thread events the bundle carries. The oldest events drop first. */
export const DIAGNOSTIC_EVENT_BYTES = 256 * 1024;
const MAX_PART_BYTES = 262144;
const MAX_TOTAL_BYTES = 786432;

export const DiagnosticFileSchema = z.strictObject({
  name: DiagnosticPartNameSchema,
  about: z.string().min(1).max(200),
  text: z.string().max(MAX_PART_BYTES),
});
export type DiagnosticFile = z.infer<typeof DiagnosticFileSchema>;

/** The desktop adds its own versions. The CLI sends none and the file says so. */
export const DiagnosticsDesktopSchema = z.strictObject({
  app: z.string().min(1).max(64),
  electron: z.string().min(1).max(64),
  chrome: z.string().min(1).max(64),
});
export const ReadDiagnosticsPayloadSchema = z.strictObject({
  taskId: taskId.optional(),
  desktop: DiagnosticsDesktopSchema.optional(),
});
export type ReadDiagnosticsPayload = z.infer<typeof ReadDiagnosticsPayloadSchema>;

export const DiagnosticsReadSchema = z
  .strictObject({
    files: z.array(DiagnosticFileSchema).length(DIAGNOSTIC_PARTS.length),
  })
  .refine(
    (read) =>
      DIAGNOSTIC_PARTS.every((part, index) => read.files[index]?.name === part.name) &&
      read.files.reduce((total, file) => total + new TextEncoder().encode(file.text).length, 0) <=
        MAX_TOTAL_BYTES,
    'The bundle holds each listed part once, within its size bound.',
  );
export type DiagnosticsRead = z.infer<typeof DiagnosticsReadSchema>;
