import { externalLink } from '../../shared/external-link.ts';

// A Markdown subset for assistant text: headings, paragraphs, nested bullet and numbered lists,
// block quotes, fenced code, tables, horizontal rules, inline code, bold, italic and links. The
// parser returns plain data and the renderer turns it into React text, so model output never
// becomes markup. Raw HTML has no rule here and stays visible as text.

export type Align = 'left' | 'right' | 'center' | null;

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  // `start` is the number the first item was written with, so a list that a code block split in
  // two still counts 1 then 2.
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'rule' }
  | { kind: 'table'; align: Align[]; head: string[]; rows: string[][] };

const MAX_DEPTH = 6;
const heading = /^(#{1,6})\s+(.*)$/;
const marker = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/;
const quote = /^\s*>\s?(.*)$/;
const rule = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const fenceLine = /^\s*(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const delimiterCell = /^:?-+:?$/;

type Fence = { char: string; length: number; lang: string };

function fenceOf(line: string): Fence | null {
  const found = fenceLine.exec(line);
  if (!found) return null;
  return { char: found[1][0], length: found[1].length, lang: found[2].slice(0, 32) };
}

function closesFence(line: string, open: Fence): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length >= open.length &&
    trimmed[0] === open.char &&
    [...trimmed].every((char) => char === open.char)
  );
}

function indentOf(text: string): number {
  let columns = 0;
  for (const char of text) {
    if (char === ' ') columns += 1;
    else if (char === '\t') columns += 4;
    else break;
  }
  return columns;
}

function dedent(line: string, columns: number): string {
  let removed = 0;
  let at = 0;
  while (at < line.length && removed < columns) {
    if (line[at] === ' ') removed += 1;
    else if (line[at] === '\t') removed += 4;
    else break;
    at += 1;
  }
  return line.slice(at);
}

function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === '\\' && text[at + 1] === '|') {
      cell += '|';
      at += 1;
    } else if (text[at] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else cell += text[at];
  }
  cells.push(cell.trim());
  return cells;
}

function tableAt(lines: string[], index: number): { block: Block; next: number } | null {
  const first = lines[index];
  const second = lines[index + 1];
  if (second === undefined || !first.includes('|') || !second.includes('-')) return null;
  const delimiter = splitRow(second);
  const head = splitRow(first);
  if (head.length !== delimiter.length || !delimiter.every((cell) => delimiterCell.test(cell)))
    return null;
  const align = delimiter.map((cell): Align => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
  const rows: string[][] = [];
  let next = index + 2;
  while (next < lines.length && lines[next].trim() !== '' && lines[next].includes('|')) {
    const cells = splitRow(lines[next]).slice(0, head.length);
    while (cells.length < head.length) cells.push('');
    rows.push(cells);
    next += 1;
  }
  return { block: { kind: 'table', align, head, rows }, next };
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  return (
    fenceOf(line) !== null ||
    heading.test(line) ||
    rule.test(line) ||
    marker.test(line) ||
    quote.test(line) ||
    tableAt(lines, index) !== null
  );
}

function listAt(lines: string[], start: number, depth: number): { block: Block; next: number } {
  const first = marker.exec(lines[start]) as RegExpExecArray;
  const base = indentOf(first[1]);
  const ordered = first[3] !== undefined;
  const items: Block[][] = [];
  let index = start;
  while (index < lines.length) {
    // Blank lines between items keep the list going when the next marker is a sibling.
    let at = index;
    while (at < lines.length && lines[at].trim() === '') at += 1;
    const item = marker.exec(lines[at] ?? '');
    if (!item || indentOf(item[1]) > base || (item[3] !== undefined) !== ordered) break;
    index = at + 1;
    // Lines indented past the marker belong to the item, which makes nested lists and indented
    // code blocks work with two, three or four spaces. A line at the marker's own indent that
    // starts no block continues the item's paragraph. Fence bodies stay whole at any indent.
    const body: { text: string; inFence: boolean }[] = [];
    let open: Fence | null = null;
    let continuing = true;
    while (index < lines.length) {
      const line = lines[index];
      if (open) {
        body.push({ text: line, inFence: true });
        if (closesFence(line, open)) open = null;
        index += 1;
        continue;
      }
      if (line.trim() === '') {
        let ahead = index;
        while (ahead < lines.length && lines[ahead].trim() === '') ahead += 1;
        if (ahead >= lines.length || indentOf(lines[ahead]) <= base) break;
        for (; index < ahead; index += 1) body.push({ text: '', inFence: false });
        continuing = false;
        continue;
      }
      if (indentOf(line) > base) {
        open = fenceOf(line);
        body.push({ text: line, inFence: false });
        continuing = true;
        index += 1;
        continue;
      }
      if (continuing && !startsBlock(lines, index)) {
        body.push({ text: line, inFence: false });
        index += 1;
        continue;
      }
      break;
    }
    const indents = body.filter((row) => !row.inFence && row.text.trim() !== '');
    const strip = indents.length ? Math.min(...indents.map((row) => indentOf(row.text))) : 0;
    const content = [item[4], ...body.map((row) => dedent(row.text, strip))];
    items.push(parseLines(content, depth + 1));
  }
  const number = ordered ? Number(first[3]) : 1;
  return { block: { kind: 'list', ordered, start: number, items }, next: index };
}

function parseLines(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const open = fenceOf(line);
    if (open) {
      const body: string[] = [];
      index += 1;
      // An unclosed fence is a block still streaming in, so it runs to the end of the text.
      while (index < lines.length && !closesFence(lines[index], open)) body.push(lines[index++]);
      index += 1;
      blocks.push({ kind: 'code', lang: open.lang, text: body.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    const head = heading.exec(line);
    if (head) {
      blocks.push({ kind: 'heading', level: head[1].length, text: head[2] });
      index += 1;
      continue;
    }
    if (rule.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }
    const table = tableAt(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.next;
      continue;
    }
    if (marker.test(line) && depth < MAX_DEPTH) {
      const list = listAt(lines, index, depth);
      blocks.push(list.block);
      index = list.next;
      continue;
    }
    if (quote.test(line)) {
      const body: string[] = [];
      while (index < lines.length && quote.test(lines[index]))
        body.push(lines[index++].replace(quote, '$1'));
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }
    const body = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() !== '' && !startsBlock(lines, index))
      body.push(lines[index++]);
    blocks.push({ kind: 'paragraph', text: body.join('\n') });
  }
  return blocks;
}

export function parseMarkdown(source: string): Block[] {
  return parseLines(source.replaceAll('\r\n', '\n').split('\n'), 0);
}

export type InlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong' | 'em'; children: InlineNode[] }
  // A link whose address is not http or https, an image, or an address with credentials. It shows
  // its label and the address as text and does nothing when clicked.
  | { kind: 'inert'; label: string; url: string }
  | { kind: 'link'; label: string; href: string };

const inline =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|((?<![\w])_[^_\s][^_\n]*_(?![\w]))|(!?\[[^\]\n]+\]\((?:[^\s()]|\([^\s()]*\))+\))|(https?:\/\/[^\s<>`[\]]+)/g;

// Sentence punctuation after an address belongs to the sentence. A closing parenthesis stays when
// the address opened one.
function trimAddress(address: string): string {
  let end = address.length;
  while (end > 0) {
    const last = address[end - 1];
    const body = address.slice(0, end);
    if (/[.,;:!?'"*]/.test(last)) end -= 1;
    else if (last === ')' && body.split(')').length > body.split('(').length) end -= 1;
    else break;
  }
  return address.slice(0, end);
}

export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  const push = (value: string) => {
    if (value) nodes.push({ kind: 'text', text: value });
  };
  let last = 0;
  for (const match of text.matchAll(inline)) {
    const at = match.index ?? 0;
    const token = match[0];
    push(text.slice(last, at));
    last = at + token.length;
    if (match[1]) nodes.push({ kind: 'code', text: token.slice(1, -1) });
    else if (match[2]) nodes.push({ kind: 'strong', children: parseInline(token.slice(2, -2)) });
    else if (match[3] || match[4])
      nodes.push({ kind: 'em', children: parseInline(token.slice(1, -1)) });
    else if (match[5]) {
      const [, bang, label, url] = /^(!?)\[([^\]]+)\]\((.+)\)$/.exec(token) ?? [];
      const target = bang ? null : externalLink(url);
      nodes.push(
        target
          ? { kind: 'link', label, href: target.href }
          : { kind: 'inert', label: label ?? token, url: url ?? '' },
      );
    } else {
      const address = trimAddress(token);
      const target = externalLink(address);
      last = at + address.length;
      if (target) nodes.push({ kind: 'link', label: address, href: target.href });
      else push(address);
    }
  }
  push(text.slice(last));
  return nodes;
}
