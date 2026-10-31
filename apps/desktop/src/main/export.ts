import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ChatExport, ExportFormat } from '@crewkite/contracts';

// Saving an export. The controller renders the text and main holds it, so the window never
// supplies bytes for a file. The share page is saved exactly as the person previewed it, and
// every file goes through the system save dialog. Nothing here uploads.

export type SaveChoice = { canceled: boolean; filePath?: string };
export type ExportDeps = {
  read(taskId: string, format: ExportFormat): Promise<ChatExport>;
  choose(options: {
    title: string;
    defaultPath: string;
    filters: { name: string; extensions: string[] }[];
  }): Promise<SaveChoice>;
};

/**
 * Writes a sibling file the person alone can read, syncs it, then renames it over the chosen path.
 * A file that was already there is never left half written, and a link at the path is replaced
 * and not followed.
 */
export function writeAtomically(path: string, content: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const file = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      writeFileSync(file, content);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
  } catch (failure) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw failure;
  }
}

const TASK_ID = /^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export class ExportStage {
  private staged: ChatExport | null = null;
  private readonly deps: ExportDeps;
  constructor(deps: ExportDeps) {
    this.deps = deps;
  }

  /** Renders the share page for the person to look at, and keeps it for the save that follows. */
  async preview(taskId: unknown): Promise<ChatExport> {
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId))
      throw new Error('The thread ID is invalid.');
    this.staged = await this.deps.read(taskId, 'html');
    return this.staged;
  }

  async save(input: unknown): Promise<'saved' | 'cancelled'> {
    const { taskId, format } = (input ?? {}) as { taskId?: unknown; format?: unknown };
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId))
      throw new Error('The thread ID is invalid.');
    if (format !== 'markdown' && format !== 'html')
      throw new Error('The export format is invalid.');
    let exported: ChatExport;
    if (format === 'html') {
      if (this.staged?.taskId !== taskId) throw new Error('Preview the page before saving it.');
      exported = this.staged;
    } else exported = await this.deps.read(taskId, 'markdown');
    const choice = await this.deps.choose({
      title: format === 'html' ? 'Save the share page' : 'Save the thread as Markdown',
      defaultPath: exported.filename,
      filters:
        format === 'html'
          ? [{ name: 'HTML', extensions: ['html'] }]
          : [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (choice.canceled || !choice.filePath) return 'cancelled';
    try {
      writeAtomically(choice.filePath, exported.content);
    } catch {
      throw new Error('The file could not be written there. Choose another place.');
    }
    return 'saved';
  }
}
