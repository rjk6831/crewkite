import { Check, Copy } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { ExternalLink } from '../external-link.tsx';
import { highlight } from './highlight.ts';
import { type Block, type InlineNode, parseInline, parseMarkdown } from './markdown-parse.ts';

// Everything reaches the page as React text, so model output can never inject markup. A link is
// clickable only when it is http or https. Anything else shows as text with its address.

function Nodes({ nodes }: { nodes: InlineNode[] }) {
  return nodes.map((node, index) => {
    const key = index;
    switch (node.kind) {
      case 'text':
        return <Fragment key={key}>{node.text}</Fragment>;
      case 'code':
        return <code key={key}>{node.text}</code>;
      case 'strong':
        return (
          <strong key={key}>
            <Nodes nodes={node.children} />
          </strong>
        );
      case 'em':
        return (
          <em key={key}>
            <Nodes nodes={node.children} />
          </em>
        );
      case 'link':
        return (
          <ExternalLink key={key} href={node.href}>
            {node.label}
          </ExternalLink>
        );
      default:
        return (
          <span key={key} className="th-md-link">
            {node.label} <span className="th-md-url">({node.url})</span>
          </span>
        );
    }
  });
}

function Inline({ text }: { text: string }) {
  return <Nodes nodes={parseInline(text)} />;
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
  const tokens = useMemo(() => highlight(text, lang), [text, lang]);
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
        <code>
          {tokens.map((token, index) =>
            token.scope ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: tokens have no identity beyond their position
              <span key={index} className={`th-tok th-tok-${token.scope.replace(/[^\w-]/g, '')}`}>
                {token.text}
              </span>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: tokens have no identity beyond their position
              <Fragment key={index}>{token.text}</Fragment>
            ),
          )}
        </code>
      </pre>
    </figure>
  );
}

function Blocks({ blocks, tight = false }: { blocks: Block[]; tight?: boolean }) {
  return blocks.map((block, index) => {
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
        const Tag = (block.ordered ? 'ol' : 'ul') as 'ol';
        return (
          <Tag key={key} start={block.ordered && block.start !== 1 ? block.start : undefined}>
            {block.items.map((item, position) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: items have no identity beyond their position
              <li key={position}>
                <Blocks blocks={item} tight />
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
      case 'rule':
        return <hr key={key} />;
      case 'table':
        return (
          <div key={key} className="th-md-table">
            <table>
              <thead>
                <tr>
                  {block.head.map((cell, column) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns have no identity beyond their position
                    <th key={column} style={{ textAlign: block.align[column] ?? undefined }}>
                      <Inline text={cell} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, line) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their position
                  <tr key={line}>
                    {row.map((cell, column) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: columns have no identity beyond their position
                      <td key={column} style={{ textAlign: block.align[column] ?? undefined }}>
                        <Inline text={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      default:
        // The first paragraph of a list item sits on the marker's line without paragraph spacing.
        return tight && key === 0 ? (
          <Fragment key={key}>
            <Lines text={block.text} />
          </Fragment>
        ) : (
          <p key={key}>
            <Lines text={block.text} />
          </p>
        );
    }
  });
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="th-md">
      <Blocks blocks={blocks} />
    </div>
  );
}
