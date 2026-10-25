import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChatFamily } from '@crewkite/contracts';
import { instructionFiles, systemContext } from './prompt.ts';

const [shared, anthropic, google] = instructionFiles;

test('instruction files reach Anthropic and Local only, a link counts once, and 64 KiB ends on a line', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-context-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const scratch = join(directory, 'scratch');
  mkdirSync(scratch);
  writeFileSync(join(scratch, shared), 'Run the checks before you finish.\n');
  symlinkSync(shared, join(scratch, anthropic));
  writeFileSync(join(scratch, google), 'Use two spaces.\n');
  const rows: { family: ChatFamily; headers: string[] }[] = [
    { family: 'anthropic', headers: [shared, google] },
    { family: 'local', headers: [shared, google] },
    { family: 'openai', headers: [] },
    { family: 'google', headers: [] },
  ];
  for (const { family, headers } of rows) {
    const context = systemContext('demo', scratch, family);
    assert.match(context, /no `\.git` folder and no installed dependencies/, family);
    assert.deepEqual(
      [...context.matchAll(/^Project instructions from (.+):$/gm)].map((match) => match[1]),
      headers,
      family,
    );
    assert.equal(context.split('Run the checks').length - 1, headers.length ? 1 : 0, family);
  }

  // A link that leaves the copy is not read.
  const outside = join(directory, 'outside.md');
  writeFileSync(outside, 'Outside text.\n');
  rmSync(join(scratch, google));
  symlinkSync(outside, join(scratch, google));
  assert.doesNotMatch(systemContext('demo', scratch, 'local'), /Outside text/);

  const line = `${'x'.repeat(99)}\n`;
  writeFileSync(join(scratch, shared), line.repeat(1000));
  const cut = systemContext('demo', scratch, 'anthropic');
  const section = cut.slice(cut.indexOf(`Project instructions from ${shared}:`));
  assert.ok(Buffer.byteLength(section) < 64 * 1024 + 100);
  assert.match(section, /x{99}\n\[The project instructions stop here at the 64 KiB limit\.\]$/);
});
