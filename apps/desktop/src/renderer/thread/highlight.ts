// A run of code text. `scope` is a highlighter scope such as "keyword" or "string". The renderer
// turns each scope into a CSS class that reads the theme tokens, so no tokens means plain text.
export type HighlightToken = { text: string; scope?: string };

// shortcut: no highlighter is installed, so code comes back as one plain run. lowlight 3.3.0 can
// fill this in. It returns a tree of text and span nodes with class names such as "hljs-keyword",
// so flatten the tree into tokens, dropping the "hljs-" prefix, and no HTML string is ever parsed.
// An unknown or empty `lang` stays plain.
export function highlight(code: string, _lang: string): HighlightToken[] {
  return [{ text: code }];
}
