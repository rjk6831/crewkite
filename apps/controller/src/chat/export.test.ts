import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { type TestContext, test } from 'node:test';
import type { ChatExport, Event, Task } from '@crewkite/contracts';
import { createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import { setup } from '../store/controller-fixture.ts';
import {
  type ExportMessage,
  type ExportModel,
  renderMarkdown,
  renderShare,
  scrubber,
  scrubModel,
} from './export.ts';

const paths = { roots: ['/work/app'], homes: ['/Users/someone'] };
const at = '2026-10-30T09:00:00.000Z';

function model(text: string, extra: Partial<ExportMessage> = {}): ExportModel {
  return {
    title: text,
    turns: 2,
    older: 0,
    families: ['anthropic', 'openai'],
    messages: [
      { at, role: 'user', text, files: [text.slice(0, 40)], tools: [] },
      {
        at: '2026-10-31T10:00:00.000Z',
        role: 'assistant',
        family: 'anthropic',
        model: 'model-a',
        text,
        files: [],
        tools: [{ kind: 'command', title: text, status: 'ok' }],
        ...extra,
      },
    ],
  };
}
const share = (value: ExportModel) => renderShare(scrubModel(value, scrubber(paths))).text;

// Tags a share page may hold, and the attributes they may carry. Anything else is a way for
// thread text to act, so the page fails here.
const TAGS = new Set([
  'html',
  'head',
  'meta',
  'title',
  'style',
  'body',
  'header',
  'h1',
  'h2',
  'p',
  'dl',
  'dt',
  'dd',
  'main',
  'section',
  'div',
  'ul',
  'li',
  'code',
  'time',
]);
const ATTRIBUTES = new Set(['lang', 'charset', 'http-equiv', 'content', 'name', 'class']);

test('the share page turns hostile or private thread text inert or redacted', () => {
  const table: { name: string; text: string; absent: string[]; present: string[] }[] = [
    {
      name: 'a script tag',
      text: 'before <script>alert(1)</script> after',
      absent: ['<script', '</script'],
      present: ['&#60;script&#62;alert(1)&#60;/script&#62;'],
    },
    {
      name: 'an onerror attribute',
      text: '<img src="x" onerror="alert(1)">',
      absent: ['<img'],
      present: ['&#60;img src=&#34;x&#34; onerror=&#34;alert(1)&#34;&#62;'],
    },
    {
      name: 'a javascript link',
      text: '[open](javascript:alert(1)) <a href="javascript:alert(1)">open</a>',
      absent: ['<a '],
      present: ['&#60;a href=&#34;javascript:alert(1)&#34;&#62;'],
    },
    {
      name: 'a token',
      text: 'key sk-live_abcdef123456 and GITHUB_TOKEN=ghp_abcdef123456',
      absent: ['abcdef123456'],
      present: ['key [redacted] and GITHUB_TOKEN=[redacted]'],
    },
    {
      name: 'a bearer header',
      text: 'curl -H "Authorization: Bearer abc.def-ghi123"',
      absent: ['abc.def-ghi123'],
      present: ['Bearer [redacted]'],
    },
    {
      name: 'an email address',
      text: 'write to Person.Name+tag@example.invalid or josé@exämple.invalid',
      absent: ['Person.Name', '@example.invalid', 'josé@'],
      present: ['write to [redacted] or [redacted]'],
    },
    {
      name: 'an absolute path in the project',
      text: 'edited /work/app/src/a.ts and listed /work/app',
      absent: ['/work/app'],
      present: ['edited src/a.ts and listed .'],
    },
    {
      name: 'a sibling folder of the project',
      text: 'read /work/app2/notes.txt',
      absent: [],
      present: ['read /work/app2/notes.txt'],
    },
    {
      name: 'the home path',
      text: 'saved /Users/someone/notes.txt next to /Users/someone',
      absent: ['/Users/someone', 'someone'],
      present: ['saved ~/notes.txt next to ~'],
    },
    {
      name: 'another person home path',
      text: 'saw /home/zed/.config/tool and C:\\Users\\zed\\file.txt',
      absent: ['zed'],
      present: ['saw ~/.config/tool and ~\\file.txt'],
    },
    {
      name: 'Unicode, controls and reordering marks',
      text: 'h\u00e9llo \u65e5\u672c\u8a9e \u{1f600} a\u202eb\u0007c\ud800d',
      absent: ['\u202e', '\u0007', '\ud800'],
      present: ['h\u00e9llo \u65e5\u672c\u8a9e \u{1f600} abc\ufffdd'],
    },
  ];
  for (const row of table) {
    const html = share(model(row.text));
    for (const text of row.absent)
      assert.ok(!html.includes(text), `${row.name}: ${JSON.stringify(text)} is still in the page`);
    for (const text of row.present)
      assert.ok(html.includes(text), `${row.name}: ${JSON.stringify(text)} is missing`);
    // The row's text reached the title, a file name, a message and a tool line, so every field
    // holds the same result, and the page stays one document with fixed markup.
    assert.ok(!/<script/i.test(html), row.name);
    assert.ok(!html.includes('//'), `${row.name}: the page names an address`);
    assert.ok(!/@import|url\(|<link|<base|<iframe|<form|<object|<embed/i.test(html), row.name);
    for (const [, name, attributes] of html.matchAll(/<\/?([a-z0-9]+)([^>]*)>/gi)) {
      assert.ok(TAGS.has(name), `${row.name}: <${name}> is not allowed`);
      for (const [, attribute] of attributes.matchAll(/([a-z-]+)="[^"]*"/g))
        assert.ok(ATTRIBUTES.has(attribute), `${row.name}: ${attribute} is not allowed`);
    }
    assert.ok(
      html.includes(
        `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
      ),
      row.name,
    );
  }
  const html = share(model('plain'));
  for (const claim of [
    '2 turns on anthropic, openai',
    '2026-10-30 to 2026-10-31',
    'Redacted',
    'Left out',
  ])
    assert.ok(html.includes(claim), claim);
});

test('a Markdown export folds each tool call to one line and names attachments', () => {
  const { text, omitted } = renderMarkdown(
    scrubModel(
      {
        title: 'Fix rounding',
        turns: 1,
        older: 0,
        families: ['openai'],
        messages: [
          { at, role: 'user', text: 'Fix the total.', files: ['spec.pdf'], tools: [] },
          {
            at,
            role: 'assistant',
            family: 'openai',
            model: 'model-a',
            text: 'Fixed.',
            files: [],
            tools: [
              { kind: 'command', title: 'npm test GITHUB_TOKEN=ghp_abcdef123456', status: 'ok' },
              { kind: 'edit', title: 'Write /work/app/src/total.ts', status: 'error' },
            ],
          },
        ],
      },
      scrubber(paths),
    ),
  );
  assert.equal(omitted, 0);
  assert.equal(
    text,
    [
      '# Fix rounding',
      '',
      '1 turn on openai. 2026-10-30.',
      'Secrets and email addresses are redacted. Each tool call is one line. Attachments are named and not included.',
      '',
      '## You',
      '',
      `_${at}_`,
      '',
      'Fix the total.',
      '',
      'Attachments, not included: spec.pdf',
      '',
      '',
      '## Assistant (openai, model-a)',
      '',
      `_${at}_`,
      '',
      '- command, ok: `npm test GITHUB_TOKEN=[redacted]`',
      '- edit, error: `Write src/total.ts`',
      '',
      'Fixed.',
      '',
      '',
    ].join('\n'),
  );
});

test('a thread export reads the real thread, folds its tool call and redacts what a reply printed', {
  timeout: 30000,
}, async (t: TestContext) => {
  const adapter = createScriptedChatAdapter({
    family: 'openai',
    turns: [
      [
        {
          kind: 'tool',
          callId: 'c1',
          toolKind: 'command',
          title: 'run GITHUB_TOKEN=ghp_abcdef123456',
        },
        {
          kind: 'text',
          itemId: 'r',
          chunks: [
            `Looked in ${homedir()}/private and wrote to owner@example.invalid. <script>x</script>`,
          ],
        },
      ],
    ],
  });
  const context = await setup(t, { chatAdapters: new Map([['openai', adapter]]) });
  const { controller, command } = context;
  const task = (await controller.execute(context.draft, 'local-owner')).entity as Task;
  const done = new Promise<void>((resolve) => {
    const stop = controller.store.subscribe((event: Event) => {
      if (event.type !== 'chat.turn' || event.payload.state !== 'done') return;
      stop();
      resolve();
    });
  });
  const selection = { family: 'openai', model: 'model-a', effort: 'default' };
  const sent = await controller.execute(
    command('SendChatMessage', { taskId: task.id, text: 'Look around.', selection }, task.revision),
    'local-owner',
  );
  assert.equal(sent.outcome, 'applied');
  await done;
  const exported = async (format: string) =>
    (
      await controller.execute(
        command('ExportChatThread', { taskId: task.id, format }),
        'local-owner',
      )
    ).data as ChatExport & { kind: 'chat-export' };

  const page = await exported('html');
  assert.equal(page.turns, 1);
  assert.match(page.filename, /^crewkite-[a-z0-9-]+\.html$/);
  assert.ok(
    page.content.includes('<li>command, ok: <code>run GITHUB_TOKEN=[redacted]</code></li>'),
  );
  assert.ok(page.content.includes('wrote to [redacted]. &#60;script&#62;x&#60;/script&#62;'));
  assert.ok(page.content.includes('Looked in ~/private'));
  assert.ok(!page.content.includes('<script'));
  const notes = await exported('markdown');
  assert.match(notes.content, /- command, ok: `run GITHUB_TOKEN=\[redacted\]`/);
  const missing = await controller.execute(
    command('ExportChatThread', { taskId: 'tsk_0000000000000000000000000A', format: 'html' }),
    'local-owner',
  );
  assert.equal(missing.reason, 'task-not-found');
});
