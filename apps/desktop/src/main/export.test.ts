import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChatExport, ExportFormat } from '@crewkite/contracts';
import { ExportStage, type SaveChoice } from './export.ts';

const taskId = `tsk_0${'0'.repeat(24)}1`;
const other = `tsk_0${'0'.repeat(24)}2`;

test('a share page is saved exactly as previewed, privately and whole, only through the save dialog', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-export-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reads: ExportFormat[] = [];
  // The thread changes after each read, so a save that read again would write other text.
  let version = 0;
  let choice: SaveChoice = { canceled: false, filePath: join(directory, 'page.html') };
  const stage = new ExportStage({
    read: async (id, format) => {
      reads.push(format);
      version += 1;
      return {
        taskId: id,
        format,
        filename: format === 'html' ? 'crewkite-thread.html' : 'crewkite-thread.md',
        content: `${format} version ${version}`,
        turns: 1,
        omitted: 0,
      } as ChatExport;
    },
    choose: async (options) => {
      assert.match(options.defaultPath, /^crewkite-thread\.(html|md)$/);
      return choice;
    },
  });

  // Nothing is written before a preview, for a bad id, for another thread's preview or a bad format.
  for (const input of [
    { taskId, format: 'html' },
    { taskId: 'tsk_x', format: 'html' },
    { taskId, format: 'pdf' },
    null,
  ])
    await assert.rejects(stage.save(input));
  await assert.rejects(stage.preview('../etc'));
  assert.equal((await stage.preview(taskId)).content, 'html version 1');
  await assert.rejects(stage.save({ taskId: other, format: 'html' }), /Preview the page/);
  assert.deepEqual(reads, ['html']);
  assert.ok(!existsSync(choice.filePath ?? ''));

  assert.equal(await stage.save({ taskId, format: 'html' }), 'saved');
  assert.equal(readFileSync(join(directory, 'page.html'), 'utf8'), 'html version 1');
  assert.deepEqual(reads, ['html']);

  // Markdown has no preview, so it reads the thread when saved.
  choice = { canceled: false, filePath: join(directory, 'notes.md') };
  assert.equal(await stage.save({ taskId, format: 'markdown' }), 'saved');
  assert.equal(readFileSync(join(directory, 'notes.md'), 'utf8'), 'markdown version 2');

  // A cancelled dialog writes nothing.
  choice = { canceled: true };
  assert.equal(await stage.save({ taskId, format: 'html' }), 'cancelled');

  // The file is private to the person, and no temporary file is left behind.
  assert.equal(statSync(join(directory, 'page.html')).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, 'notes.md')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(directory).sort(), ['notes.md', 'page.html']);

  // A link at the chosen path is replaced and never followed, and a file already there is
  // replaced whole.
  const target = join(directory, 'target.txt');
  writeFileSync(target, 'keep');
  symlinkSync(target, join(directory, 'link.html'));
  choice = { canceled: false, filePath: join(directory, 'link.html') };
  assert.equal(await stage.save({ taskId, format: 'html' }), 'saved');
  assert.equal(readFileSync(target, 'utf8'), 'keep');
  assert.equal(lstatSync(join(directory, 'link.html')).isSymbolicLink(), false);
  assert.equal(readFileSync(join(directory, 'link.html'), 'utf8'), 'html version 1');
  choice = { canceled: false, filePath: join(directory, 'page.html') };
  assert.equal(await stage.save({ taskId, format: 'html' }), 'saved');
  assert.equal(readFileSync(join(directory, 'page.html'), 'utf8'), 'html version 1');

  // A path that cannot be written leaves nothing behind and names the problem.
  choice = { canceled: false, filePath: join(directory, 'missing', 'page.html') };
  await assert.rejects(stage.save({ taskId, format: 'html' }), /could not be written/);
  choice = { canceled: false, filePath: directory };
  await assert.rejects(stage.save({ taskId, format: 'html' }), /could not be written/);
  assert.deepEqual(readdirSync(directory).sort(), [
    'link.html',
    'notes.md',
    'page.html',
    'target.txt',
  ]);
});
