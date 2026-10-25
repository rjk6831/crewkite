import { common, createLowlight } from 'lowlight';

// A run of code text. `scope` is a highlighter scope such as "keyword" or "string". The renderer
// turns each scope into a CSS class that reads the theme tokens, so no tokens means plain text.
export type HighlightToken = { text: string; scope?: string };

type Node =
  | { type: 'text'; value: string }
  | { type: 'element'; properties?: { className?: unknown }; children: Node[] }
  | { type: 'root'; children: Node[] };

const lowlight = createLowlight(common);
// A reply can carry a very large block. Past this size the cost of tokenizing outweighs the colour.
const MAX_HIGHLIGHT_CHARS = 100_000;

// The highlighter returns a tree of text and span nodes. Flattening it here means no HTML string
// from model output is ever parsed. An unknown or empty `lang` stays plain.
export function highlight(code: string, lang: string): HighlightToken[] {
  const name = lang.trim().toLowerCase();
  if (!name || code.length > MAX_HIGHLIGHT_CHARS || !lowlight.registered(name))
    return [{ text: code }];
  const tokens: HighlightToken[] = [];
  const walk = (node: Node, scope: string | undefined) => {
    if (node.type === 'text') {
      const last = tokens.at(-1);
      if (last && last.scope === scope) last.text += node.value;
      else tokens.push(scope ? { text: node.value, scope } : { text: node.value });
      return;
    }
    let inner = scope;
    if (node.type === 'element') {
      const classes = node.properties?.className;
      const first = Array.isArray(classes)
        ? classes.find((value) => typeof value === 'string')
        : null;
      if (typeof first === 'string' && first.startsWith('hljs-')) inner = first.slice(5);
    }
    for (const child of node.children) walk(child, inner);
  };
  try {
    walk(lowlight.highlight(name, code) as Node, undefined);
  } catch {
    return [{ text: code }];
  }
  return tokens.length ? tokens : [{ text: code }];
}
