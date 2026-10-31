import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChatFamily } from '@crewkite/contracts';
import {
  adviceContext,
  askContext,
  attachedLine,
  attachedSection,
  challengeContext,
  deltaPacket,
  type EarlierFile,
  earlierReach,
  handoffPacket,
  instructionFiles,
  orchestratorContext,
  readOnlyRules,
  reviewContext,
  sliceBrief,
  spokenText,
  systemContext,
  THREAD_TOOLS_LINE,
  withAttachments,
  withoutThreadToolsLine,
} from './prompt.ts';

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

test('a request holds the new message once and lists each file once, in the section its message owns', () => {
  const file = (name: string, mimeType: string, bytes: number) => ({ name, mimeType, bytes });
  const old = file('old.png', 'image/png', 2048);
  const fresh = file('fresh.pdf', 'application/pdf', 100);
  const earlier = (to: ChatFamily): EarlierFile[] => [
    {
      attachment: old,
      came: 'the first screenshot',
      reach: earlierReach(to, '/home/files/old.png'),
    },
  ];
  const message = 'Compare the two.';
  // The adapter adds the lines for the message's own files directly under the text.
  const request = (to: ChatFamily, files: EarlierFile[], own: string[], packet: boolean) => {
    const text = packet
      ? handoffPacket({
          from: 'openai',
          to,
          reason: 'manual',
          history: [{ role: 'user', text: 'Look at this.' }],
          files: [],
          prompt: message,
          earlier: files,
          threadTools: true,
        })
      : message;
    return [text, attachedSection(own)].filter(Boolean).join('\n\n');
  };
  const own = [attachedLine(fresh, 'Path: /home/files/fresh.pdf')];
  const rows: {
    label: string;
    text: string;
    names: string[];
    heading: boolean;
    before: boolean;
  }[] = [
    {
      label: 'no earlier files',
      text: request('anthropic', [], [], true),
      names: [],
      heading: false,
      before: true,
    },
    {
      label: 'earlier plus one new',
      text: request('anthropic', earlier('anthropic'), own, true),
      names: ['old.png', 'fresh.pdf'],
      heading: true,
      before: true,
    },
    {
      label: 'Local sees the packet side only',
      text: request('local', earlier('local'), [], true),
      names: ['old.png'],
      heading: true,
      before: true,
    },
    {
      label: 'same-family resume carries no earlier list',
      text: request('openai', earlier('openai'), own, false),
      names: ['fresh.pdf'],
      heading: false,
      before: false,
    },
  ];
  for (const { label, text, names, heading, before } of rows) {
    const marker = 'New message from the person:';
    const packet = before ? 1 : 0;
    assert.equal(text.split(message).length - 1, 1, label);
    assert.equal(text.split(marker).length - 1, packet, label);
    // A path ends in the name, so a file counts by the lines that start with it.
    for (const name of names)
      assert.equal(
        text.split('\n').filter((line) => line.startsWith(`${name},`)).length,
        1,
        `${label} ${name}`,
      );
    const earlierHeading =
      'Files attached earlier in this thread. They are not part of the new message.';
    assert.equal(text.includes(earlierHeading), heading, label);
    if (heading) assert.ok(text.indexOf(earlierHeading) < text.indexOf(marker), label);
    if (names.includes('fresh.pdf'))
      assert.ok(text.indexOf(message) < text.indexOf('Files attached to this message:'), label);
  }
  assert.match(
    request('anthropic', earlier('anthropic'), [], true),
    /old\.png, image\/png, 2\.0 KiB, came with "the first screenshot", Path: \/home\/files\/old\.png/,
  );
  assert.match(
    request('local', earlier('local'), [], true),
    /came with "the first screenshot", not sent to Local/,
  );

  // Files alone: on a resume the file section is the whole body, and a packet says the message
  // has no text and puts the section right after it.
  const alone = [withAttachments('', [], '/scratch', '/project'), attachedSection(own)]
    .filter(Boolean)
    .join('\n\n');
  assert.equal(alone, `Files attached to this message:\n${own[0]}`);
  const packet = handoffPacket({
    from: 'openai',
    to: 'google',
    reason: 'manual',
    history: [{ role: 'user', text: spokenText('', [fresh]) }],
    files: [],
    prompt: '',
    earlier: [{ attachment: old, came: '', reach: earlierReach('google', '/x') }],
    threadTools: true,
  });
  assert.match(packet, /^Person:\n\(Files only: fresh\.pdf\)$/m);
  assert.equal(packet.split(`\n${THREAD_TOOLS_LINE}\n`).length, 2);
  // A turn without thread tools is not told it has them, in either packet, and a late discovery
  // takes the line out of a packet that carried it.
  const bare = {
    from: 'openai',
    to: 'google',
    reason: 'manual',
    history: [],
    files: [],
    prompt: '',
    threadTools: false,
  } as const;
  const delta = {
    from: null,
    to: 'google',
    reason: null,
    turns: [],
    changes: [],
    checks: [],
    earlier: [],
    prompt: '',
  } as const;
  for (const [text, fixed] of [
    [handoffPacket(bare), handoffPacket({ ...bare, threadTools: true })],
    [deltaPacket({ ...delta, threadTools: false }), deltaPacket({ ...delta, threadTools: true })],
  ]) {
    assert.doesNotMatch(text, /Thread tools are available/);
    assert.equal(fixed.split(`\n${THREAD_TOOLS_LINE}\n`).length, 2);
    assert.equal(withoutThreadToolsLine(fixed), text);
  }
  assert.match(packet, /old\.png, .*came with a message with no text, sent as a file link below$/m);
  assert.match(
    packet,
    /New message from the person: the files attached to this message, with no text\.$/,
  );
});

test('a read-only brief lets the OpenAI client read through read-only commands and keeps the others off commands', () => {
  const briefs = (family: ChatFamily) => [
    reviewContext('demo', '/s', 'abc', [], family),
    adviceContext('demo', '/s', family, null),
    askContext('demo', '/s', family),
    challengeContext('demo', '/s', family, null),
    orchestratorContext('demo', '/s', family),
  ];
  for (const brief of briefs('openai')) {
    assert.match(brief, /run read-only commands such as ls, cat, sed -n/);
    assert.doesNotMatch(brief, /do not run commands/);
  }
  for (const family of ['anthropic', 'google', 'local'] as const)
    for (const brief of briefs(family)) {
      assert.match(brief, /do not run commands\. You may read and search files/, family);
      assert.doesNotMatch(brief, /read-only commands/, family);
    }
  assert.match(readOnlyRules('openai', 'answer'), /to answer: run read-only commands/);
});

test('the orchestrator brief names the slices as the parallel workers and keeps the JSON out of the summary', () => {
  const brief = orchestratorContext('demo', '/s', 'openai');
  assert.match(brief, /Slices whose dependencies are done start together/);
  assert.match(brief, /The slices are the parallel workers/);
  assert.match(
    brief,
    /asks for a number of agents or subagents, split the work into that many slices/,
  );
  assert.match(brief, /does not repeat its JSON/);
  assert.doesNotMatch(brief, /one at a time in dependency order/);
});

test('a read-only slice brief asks for reads and searches', () => {
  const plan = { planId: 'p1', goal: 'Find the bug.', slices: [{}] };
  const slice = {
    id: 1,
    title: 'Look',
    brief: 'Find where totals round.',
    files: [],
    readOnly: true,
  };
  assert.match(sliceBrief(plan, slice, 'Assigned.'), /Read and search the files it needs/);
});
