import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
export const previewDocuments = ['README.md', 'docs/preview.md'];

function inside(path) {
  const offset = relative(root, path);
  if (isAbsolute(offset) || offset === '..' || offset.startsWith('../'))
    throw Error('A documentation link leaves the repository.');
  return path;
}

export function destinationFile(path) {
  const target = inside(realpathSync(inside(resolve(root, path))));
  const state = statSync(target);
  if (!state.isFile() || state.size > 1024 * 1024)
    throw Error('A documentation target is not a bounded file.');
  return target;
}

export function readDocument(path) {
  return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(destinationFile(path)));
}

function prose(text) {
  let fence = null;
  return text
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
        fence = fence ? null : marker;
        return '';
      }
      return fence ? '' : line;
    })
    .join('\n');
}

export function relativeLinks(path) {
  const text = prose(readDocument(path)).replace(/(`+)[\s\S]*?\1/g, '');
  const references = new Map();
  const label = (value) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const destination = (value) => {
    const match = /^(?:<([^<>\n]+)>|([^\s]+))(?:\s+["'(][\s\S]*)?$/.exec(value.trim());
    if (!match) throw Error(`${path}: unsupported Markdown link destination.`);
    return match[1] ?? match[2];
  };
  for (const match of text.matchAll(/^ {0,3}\[([^\]\n]+)\]:\s*(.+)$/gm))
    references.set(label(match[1]), destination(match[2]));
  const brackets = new Map();
  const pending = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (text[index] === '[') pending.push(index);
    else if (text[index] === ']' && pending.length) brackets.set(pending.pop(), index);
  }
  const links = [];
  const add = (url) => {
    if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('//')) return;
    if (url.startsWith('/')) throw Error(`${path}: use a repository-relative link.`);
    const hash = url.indexOf('#');
    const file = hash === -1 ? url : url.slice(0, hash);
    const fragment = hash === -1 ? null : decodeURIComponent(url.slice(hash + 1));
    const decoded = decodeURIComponent(file).replace(/\\([\\()[\]])/g, '$1');
    if (decoded.includes('?') || decoded.includes('\0'))
      throw Error(`${path}: unsupported local link query or NUL.`);
    const target = decoded ? resolve(root, dirname(path), decoded) : resolve(root, path);
    inside(target);
    links.push({ source: path, destination: relative(root, target), fragment });
    if (links.length > 512) throw Error(`${path}: too many documentation links.`);
  };
  // The bounded scanner accepts balanced labels and escaped or nested destination parentheses.
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '[' || text[index - 1] === '\\') continue;
    const close = brackets.get(index);
    if (close === undefined) continue;
    let end = close + 1;
    if (text[end] === ':') continue;
    if (text[end] === '(') {
      const start = ++end;
      let depth = 1;
      for (; end < text.length && depth; end++) {
        if (text[end] === '\\') end++;
        else if (text[end] === '(') depth++;
        else if (text[end] === ')') depth--;
      }
      if (depth) throw Error(`${path}: unclosed Markdown link destination.`);
      add(destination(text.slice(start, end - 1)));
      index = end - 1;
    } else if (text[end] === '[') {
      const close = text.indexOf(']', end + 1);
      if (close === -1) throw Error(`${path}: unclosed Markdown link reference.`);
      const key = label(text.slice(end + 1, close) || text.slice(index + 1, end - 1));
      if (!references.has(key)) throw Error(`${path}: missing Markdown link reference.`);
      add(references.get(key));
      index = close;
    } else if (references.size && close - index <= 1000) {
      const key = label(text.slice(index + 1, close));
      if (references.has(key)) {
        add(references.get(key));
        index = end - 1;
      }
    }
  }
  return links;
}

export function anchors(path) {
  const text = prose(readDocument(path));
  const result = new Set();
  const counts = new Map();
  const headings = [
    ...text.matchAll(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm),
    ...text.matchAll(/^([^\n]+)\n {0,3}(?:=+|-+)\s*$/gm),
  ].sort((a, b) => a.index - b.index);
  for (const match of headings) {
    const base = match[1]
      .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/\s/g, '-');
    let count = counts.get(base) ?? 0;
    while (result.has(count ? `${base}-${count}` : base)) count++;
    counts.set(base, count + 1);
    result.add(count ? `${base}-${count}` : base);
  }
  for (const match of text.matchAll(/<a\s+[^>]*(?:id|name)=["']([^"']+)["'][^>]*>/gi))
    result.add(match[1]);
  return result;
}
