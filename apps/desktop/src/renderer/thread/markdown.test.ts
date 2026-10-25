import assert from 'node:assert/strict';
import { test } from 'node:test';
import { externalLink } from '../../shared/external-link.ts';
import { type Block, type InlineNode, parseInline, parseMarkdown } from './markdown-parse.ts';

// One line per block. A list shows its start number and its items between brackets, so the rows
// below can state the shape they expect without a snapshot.
function outline(blocks: Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case 'list':
          return `${block.ordered ? `ol@${block.start}` : 'ul'}[${block.items.map(outline).join('|')}]`;
        case 'code':
          return `code:${block.lang}:${block.text}`;
        case 'table':
          return `table:${block.align.map((align) => align ?? '-').join(',')}:${[block.head, ...block.rows].map((row) => row.join('/')).join(';')}`;
        case 'rule':
          return 'hr';
        case 'paragraph':
          return `p:${block.text}`;
        default:
          return `${block.kind}:${block.text}`;
      }
    })
    .join(' ');
}

function nodes(list: InlineNode[]): string {
  return list
    .map((node) =>
      node.kind === 'link'
        ? `link:${node.href}`
        : node.kind === 'text'
          ? `t:${node.text}`
          : node.kind,
    )
    .join(' ');
}

test('markdown keeps list numbers, reads tables and rejects links that are not http or https', () => {
  const blocks: [name: string, source: string, expected: string][] = [
    [
      'ordered list resumes its number after an unindented code block',
      '1. Install\n```bash\nnpm i\n```\n2. Run',
      'ol@1[p:Install] code:bash:npm i ol@2[p:Run]',
    ],
    [
      'indented code block stays inside its item',
      '1. Install\n   ```bash\n   npm i\n   ```\n2. Run',
      'ol@1[p:Install code:bash:npm i|p:Run]',
    ],
    ['list keeps the number it starts with', '3. x\n4. y', 'ol@3[p:x|p:y]'],
    ['blank line between items keeps one list', '1. a\n\n2. b', 'ol@1[p:a|p:b]'],
    ['nested bullets', '- a\n  - b\n  - c\n- d', 'ul[p:a ul[p:b|p:c]|p:d]'],
    ['two space nesting under a number', '1. a\n  - b\n2. c', 'ol@1[p:a ul[p:b]|p:c]'],
    ['wrapped item text', '- one\ncontinued', 'ul[p:one\ncontinued]'],
    [
      'table with alignment and an escaped pipe',
      '| Name | Qty |\n|:--|--:|\n| a | 1 |\n| b \\| c | 2 |',
      'table:left,right:Name/Qty;a/1;b | c/2',
    ],
    ['table without edge pipes pads a short row', 'a | b\n--- | ---\nx |', 'table:-,-:a/b;x/'],
    ['pipes without a delimiter row are text', 'a | b\nc | d', 'p:a | b\nc | d'],
    ['rule after a paragraph', 'a\n---\nb', 'p:a hr p:b'],
    ['spaced rule is not a bullet', '- - -', 'hr'],
    ['asterisk rule', '***', 'hr'],
    [
      'four backtick fence holds a three backtick fence',
      '````md\n```js\nx\n```\n````',
      'code:md:```js\nx\n```',
    ],
    ['unclosed fence runs to the end', '```ts\nconst a', 'code:ts:const a'],
    ['raw html stays text', '<img src=x onerror=alert(1)>', 'p:<img src=x onerror=alert(1)>'],
  ];
  for (const [name, source, expected] of blocks)
    assert.equal(outline(parseMarkdown(source)), expected, name);

  const links: [name: string, source: string, expected: string][] = [
    ['https link', '[a](https://x.com/p)', 'link:https://x.com/p'],
    ['http link', '[a](http://x.com)', 'link:http://x.com/'],
    ['javascript scheme', '[a](javascript:alert(1))', 'inert'],
    ['javascript scheme in mixed case', '[a](JaVaScRiPt:alert(1))', 'inert'],
    ['escaped javascript scheme', '[a](%6Aavascript:alert(1))', 'inert'],
    ['data scheme', '[a](data:text/html,hi)', 'inert'],
    ['file scheme', '[a](file:///etc/passwd)', 'inert'],
    ['mailto scheme', '[a](mailto:x@y.z)', 'inert'],
    ['scheme relative address', '[a](//evil.com)', 'inert'],
    ['credentials in the address', '[a](https://u:p@evil.com)', 'inert'],
    ['image', '![i](https://x.com/a.png)', 'inert'],
    [
      'bare address drops sentence punctuation',
      'see https://x.com/a.',
      't:see  link:https://x.com/a t:.',
    ],
    ['bare javascript address stays text', 'javascript:alert(1)', 't:javascript:alert(1)'],
  ];
  for (const [name, source, expected] of links)
    assert.equal(nodes(parseInline(source)), expected, name);

  const addresses: [string | number, ReturnType<typeof externalLink>][] = [
    ['https://example.com/a?b=1', { href: 'https://example.com/a?b=1', secure: true }],
    ['http://example.com', { href: 'http://example.com/', secure: false }],
    ['javascript:alert(1)', null],
    ['data:text/html;base64,AA', null],
    ['file:///etc/passwd', null],
    ['ftp://example.com', null],
    ['https://user:pw@example.com', null],
    ['https://exa mple.com', null],
    [' https://example.com', null],
    ['https://example.com\n', null],
    ['//example.com', null],
    ['https://', null],
    ['', null],
    [42, null],
    [`https://${'a'.repeat(2100)}.com`, null],
  ];
  for (const [address, expected] of addresses)
    assert.deepEqual(externalLink(address), expected, String(address).slice(0, 40));
});
