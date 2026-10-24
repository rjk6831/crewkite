import { Check, Copy } from 'lucide-react';
import { Fragment, type ReactNode, useState } from 'react';

// A small Markdown subset for assistant text: headings, paragraphs, bullet and numbered lists,
// block quotes, fenced code, inline code, bold, italic and links. Everything reaches the page as
// React text, so model output can never inject markup. A link renders as inert text with its URL
// shown, because a model-written link is not something to open from here.

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; lang: string; text: string };

const fence = /^\s*```\s*([\w+#.-]*)\s*$/;
const heading = /^(#{1,6})\s+(.*)$/;
const bullet = /^\s*[-*+]\s+(.*)$/;
const numbered = /^\s*\d+[.)]\s+(.*)$/;
const quote = /^\s*>\s?(.*)$/;

function parse(source: string): Block[] {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;
  const startsBlock = (line: string) =>
    fence.test(line) ||
    heading.test(line) ||
    bullet.test(line) ||
    numbered.test(line) ||
    quote.test(line);
  while (index < lines.length) {
    const line = lines[index];
    const open = fence.exec(line);
    if (open) {
      const body: string[] = [];
      index += 1;
      // An unclosed fence is a block still streaming in, so it runs to the end of the text.
      while (index < lines.length && !fence.test(lines[index])) body.push(lines[index++]);
      index += 1;
      blocks.push({ kind: 'code', lang: open[1], text: body.join('\n') });
      continue;
    }
    const head = heading.exec(line);
    if (head) {
      blocks.push({ kind: 'heading', level: head[1].length, text: head[2] });
      index += 1;
      continue;
    }
    const list = bullet.test(line) ? bullet : numbered.test(line) ? numbered : null;
    if (list) {
      const items: string[] = [];
      while (index < lines.length && list.test(lines[index]))
        items.push(lines[index++].replace(list, '$1'));
      blocks.push({ kind: 'list', ordered: list === numbered, items });
      continue;
    }
    if (quote.test(line)) {
      const body: string[] = [];
      while (index < lines.length && quote.test(lines[index]))
        body.push(lines[index++].replace(quote, '$1'));
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    const body: string[] = [];
    while (index < lines.length && lines[index].trim() !== '' && !startsBlock(lines[index]))
      body.push(lines[index++]);
    blocks.push({ kind: 'paragraph', text: body.join('\n') });
  }
  return blocks;
}

const inline =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|((?<![\w])_[^_\s][^_\n]*_(?![\w]))|(\[[^\]\n]+\]\([^)\s]+\))/g;

function Inline({ text }: { text: string }): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(inline)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const token = match[0];
    const key = `${at}:${token.length}`;
    if (match[1]) parts.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (match[2])
      parts.push(
        <strong key={key}>
          <Inline text={token.slice(2, -2)} />
        </strong>,
      );
    else if (match[3] || match[4])
      parts.push(
        <em key={key}>
          <Inline text={token.slice(1, -1)} />
        </em>,
      );
    else {
      const [, label, url] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token) ?? [];
      parts.push(
        <span key={key} className="th-md-link">
          {label} <span className="th-md-url">({url})</span>
        </span>,
      );
    }
    last = at + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function Lines({ text }: { text: string }) {
  return text.split('\n').map((line, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity beyond their position
    <Fragment key={index}>
      {index > 0 && <br />}
      <Inline text={line} />
    </Fragment>
  ));
}

export function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The clipboard can be blocked. The text stays selectable.
    }
  }
  return (
    <figure className="th-code">
      <figcaption>
        <span>{lang || 'text'}</span>
        <button type="button" onClick={() => void copy()} aria-label="Copy code">
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <pre>
        <code>{text}</code>
      </pre>
    </figure>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="th-md">
      {parse(text).map((block, index) => {
        const key = index;
        switch (block.kind) {
          case 'heading': {
            const Tag = `h${Math.min(6, block.level + 1)}` as 'h2';
            return (
              <Tag key={key}>
                <Inline text={block.text} />
              </Tag>
            );
          }
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
              <Tag key={key}>
                {block.items.map((item, position) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: items have no identity beyond their position
                  <li key={position}>
                    <Inline text={item} />
                  </li>
                ))}
              </Tag>
            );
          }
          case 'quote':
            return (
              <blockquote key={key}>
                <Lines text={block.text} />
              </blockquote>
            );
          case 'code':
            return <CodeBlock key={key} lang={block.lang} text={block.text} />;
          default:
            return (
              <p key={key}>
                <Lines text={block.text} />
              </p>
            );
        }
      })}
    </div>
  );
}
