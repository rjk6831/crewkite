import { Box, Text } from 'ink';
import { createElement as h, type ReactNode } from 'react';
import {
  type Block,
  type InlineNode,
  parseInline,
  parseMarkdown,
} from '../../../desktop/src/renderer/thread/markdown-parse.ts';
import { type Palette, safeText } from './theme.ts';

// Replies render through the desktop's Markdown parser, which returns plain data. Every string
// becomes terminal text, so model output never turns into escape sequences or links it did not
// write. A link shows its label and its address.

function inline(nodes: readonly InlineNode[], colors: Palette, key = 'i'): ReactNode[] {
  return nodes.map((node, index) => {
    const id = `${key}.${index}`;
    switch (node.kind) {
      case 'text':
        return safeText(node.text);
      case 'code':
        return h(Text, { key: id, color: colors.amber }, safeText(node.text));
      case 'strong':
        return h(Text, { key: id, bold: true }, ...inline(node.children, colors, id));
      case 'em':
        return h(Text, { key: id, italic: true }, ...inline(node.children, colors, id));
      case 'link':
        return h(
          Text,
          { key: id },
          h(Text, { underline: true, color: colors.accent }, safeText(node.label)),
          node.label === node.href ? '' : h(Text, { color: colors.muted }, ` (${node.href})`),
        );
      case 'inert':
        return `${safeText(node.label)} (${safeText(node.url)})`;
    }
    return null;
  });
}

const paragraph = (text: string, colors: Palette) => inline(parseInline(text), colors);

function block(item: Block, colors: Palette, width: number, key: string): ReactNode {
  switch (item.kind) {
    case 'heading':
      return h(Text, { key, bold: true, color: colors.accent }, ...paragraph(item.text, colors));
    case 'paragraph':
      return h(Text, { key }, ...paragraph(item.text, colors));
    case 'quote':
      return h(
        Box,
        {
          key,
          paddingLeft: 1,
          borderStyle: 'single',
          borderLeft: true,
          borderTop: false,
          borderRight: false,
          borderBottom: false,
          borderColor: colors.border,
        },
        h(Text, { color: colors.muted }, ...paragraph(item.text, colors)),
      );
    case 'code':
      return h(
        Box,
        {
          key,
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: colors.border,
          paddingX: 1,
        },
        item.lang ? h(Text, { color: colors.muted }, safeText(item.lang)) : null,
        h(Text, { color: colors.text }, safeText(item.text)),
      );
    case 'rule':
      return h(Text, { key, color: colors.border }, '─'.repeat(Math.max(1, Math.min(width, 60))));
    case 'list':
      return h(
        Box,
        { key, flexDirection: 'column' },
        ...item.items.map((children, index) =>
          h(
            Box,
            { key: `${key}.${index}` },
            h(Text, { color: colors.muted }, item.ordered ? `${item.start + index}. ` : '• '),
            h(
              Box,
              { flexDirection: 'column', flexShrink: 1 },
              ...children.map((child, at) =>
                block(child, colors, width - 3, `${key}.${index}.${at}`),
              ),
            ),
          ),
        ),
      );
    case 'table': {
      const rows = [item.head, ...item.rows].map((row) => row.map((cell) => safeText(cell)));
      const widths = item.head.map((_, column) =>
        Math.max(...rows.map((row) => Array.from(row[column] ?? '').length)),
      );
      const line = (row: readonly string[]) =>
        row
          .map((cell, column) =>
            item.align[column] === 'right'
              ? cell.padStart(widths[column])
              : cell.padEnd(widths[column]),
          )
          .join('  ');
      return h(
        Box,
        { key, flexDirection: 'column' },
        h(Text, { bold: true }, line(rows[0])),
        h(Text, { color: colors.border }, widths.map((value) => '─'.repeat(value)).join('  ')),
        ...rows.slice(1).map((row, index) => h(Text, { key: `${key}.r${index}` }, line(row))),
      );
    }
  }
}

export function Markdown({
  text,
  colors,
  width,
}: {
  text: string;
  colors: Palette;
  width: number;
}) {
  return h(
    Box,
    { flexDirection: 'column', gap: 1 },
    ...parseMarkdown(text).map((item, index) => block(item, colors, width, `b${index}`)),
  );
}
