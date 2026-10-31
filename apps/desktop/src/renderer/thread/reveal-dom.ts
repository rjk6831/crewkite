import { findMarks } from './history-reveal.ts';

// The part of a search reveal that needs the page: marking the matched words inside one row with
// the CSS Custom Highlight API, which paints a range of text without changing the row's markup.
// A page without the API keeps the row's own marker and loses only the word marks.

const NAME = 'th-hit';
const MAX_RANGES = 400;

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };

/** Marks every match of `terms` inside `root`. Returns the call that removes the marks. */
export function markMatches(root: HTMLElement, terms: readonly string[]): () => void {
  const registry = (globalThis.CSS as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || !Highlight || terms.length === 0) return () => {};
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && ranges.length < MAX_RANGES; node = walker.nextNode()) {
    const text = node as Text;
    for (const mark of findMarks(text.data, terms)) {
      const range = document.createRange();
      range.setStart(text, mark.start);
      range.setEnd(text, mark.end);
      ranges.push(range);
    }
  }
  if (ranges.length === 0) return () => {};
  registry.set(NAME, new Highlight(...ranges));
  return () => registry.delete(NAME);
}
