import { z } from 'zod';

// Composer parity: mentions, instruction files and saved prompts. The desktop and the command
// line composer share these shapes. Every result is bounded here.

const taskId = z.string().regex(/^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

/** The most candidates one completion returns. */
export const MENTION_LIMIT_MAX = 50;
/** Instruction files at the copy root that the chip can show. */
export const INSTRUCTION_VIEW_BYTES = 64 * 1024;

const mentionPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\0') &&
      !value.includes('\\') &&
      !value.split('/').includes('..'),
    'A mention path is relative and stays inside the copy.',
  );

export const CompleteChatMentionPayloadSchema = z.strictObject({
  taskId,
  query: z.string().max(200),
  limit: z.number().int().min(1).max(MENTION_LIMIT_MAX),
});
export const ChatMentionSchema = z.strictObject({
  path: mentionPath,
  kind: z.enum(['file', 'folder']),
});
export type ChatMention = z.infer<typeof ChatMentionSchema>;
export const ChatMentionsReadSchema = z.strictObject({
  taskId,
  mentions: z.array(ChatMentionSchema).max(MENTION_LIMIT_MAX),
});
export type ChatMentionsRead = z.infer<typeof ChatMentionsReadSchema>;

export const ReadChatInstructionsPayloadSchema = z.strictObject({
  taskId,
  /** One of the files `files` listed. Leave out to list only. */
  name: z.string().min(1).max(64).optional(),
});
export const ChatInstructionsReadSchema = z.strictObject({
  taskId,
  files: z.array(z.string().min(1).max(64)).max(8),
  name: z.string().min(1).max(64).nullable(),
  text: z.string().max(INSTRUCTION_VIEW_BYTES).nullable(),
  truncated: z.boolean(),
});
export type ChatInstructionsRead = z.infer<typeof ChatInstructionsReadSchema>;

/** Names are short and lower case so `/prompt name` types easily. */
export const SavedPromptNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export const SavedPromptSchema = z.strictObject({
  name: SavedPromptNameSchema,
  /** Placeholders are written {{name}}. */
  body: z.string().min(1).max(8000),
});
export type SavedPrompt = z.infer<typeof SavedPromptSchema>;
export const MAX_SAVED_PROMPTS = 100;
export const SavedPromptsSchema = z.strictObject({
  prompts: z.array(SavedPromptSchema).max(MAX_SAVED_PROMPTS),
});
export type SavedPrompts = z.infer<typeof SavedPromptsSchema>;
/** The JSON file Settings exports. */
export const SavedPromptsExportSchema = z.strictObject({
  version: z.literal(1),
  prompts: z.array(SavedPromptSchema).max(MAX_SAVED_PROMPTS),
});
export type SavedPromptsExport = z.infer<typeof SavedPromptsExportSchema>;

export const ReadChatPromptsPayloadSchema = z.strictObject({});
export const SaveChatPromptPayloadSchema = SavedPromptSchema;
export const DeleteChatPromptPayloadSchema = z.strictObject({ name: SavedPromptNameSchema });
