import { anthropicInstructionFile } from './anthropic/instructions.ts';
import { googleInstructionFile } from './google/instructions.ts';

/**
 * The instruction files the product detects at the root of a scratch copy. These are the literal
 * names on disk, so they stay together here under providers/. The composer chip lists whichever
 * of them exist. The cursor rules file is shown for visibility only, since no client turn reads
 * it through the controller.
 */
export const instructionFileNames = [
  'AGENTS.md',
  anthropicInstructionFile,
  googleInstructionFile,
  '.cursorrules',
] as const;
