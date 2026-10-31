import type { ChatFamily } from '@crewkite/contracts';

// The kite and the wordmark, drawn in cells. Each cell names the kite panel it belongs to, so the
// view colours it and a terminal without colour still reads the shape.

export type Cell = { text: string; panel: ChatFamily | null; word?: boolean };
export type Art = Cell[][];

// The kite from the wordmark: four panels split by the spar and the crossbar, which sits above
// the middle. Top left Google, top right Local, bottom left OpenAI, bottom right Anthropic, as the
// desktop's conic gradient draws it. g, l, o and a mark the panel of each drawn cell.
const largeKite = [
  '    ◢g ◣l    ',
  '   ◢g█g █l◣l   ',
  '  ◢g█g█g █l█l◣l  ',
  '',
  '  ◥o█o█o █a█a◤a  ',
  '   █o█o █a█a   ',
  '   ◥o█o █a◤a   ',
  '    ◥o ◤a    ',
];
const smallKite = ['◢g◣l', '◥o◤a'];
const panelOf: Record<string, ChatFamily> = {
  g: 'google',
  l: 'local',
  o: 'openai',
  a: 'anthropic',
};

function cells(row: string): Cell[] {
  const out: Cell[] = [];
  for (let index = 0; index < row.length; index++) {
    const char = row[index];
    const panel = panelOf[row[index + 1] ?? ''];
    if (panel && char !== ' ') {
      out.push({ text: char, panel });
      index++;
    } else out.push({ text: char, panel: null });
  }
  return out;
}

export const kite = (size: 'large' | 'small'): Art =>
  (size === 'large' ? largeKite : smallKite).map(cells);

// A five-row block face for the word. Only the letters of the wordmark are drawn.
const letters: Record<string, string[]> = {
  C: [' ████', '██   ', '██   ', '██   ', ' ████'],
  r: ['     ', '█ ██ ', '██   ', '█    ', '█    '],
  e: ['     ', ' ███ ', '█▄▄▄█', '█    ', ' ████'],
  w: ['       ', '█     █', '█  █  █', '█ █ █ █', ' █   █ '],
  K: ['█   █', '█  █ ', '███  ', '█  █ ', '█   █'],
  i: [' █ ', '   ', '██ ', ' █ ', '███'],
  t: [' █  ', '████', ' █  ', ' █  ', '  ██'],
};

function word(text: string): string[] {
  const rows = ['', '', '', '', ''];
  for (const char of text) {
    const glyph = letters[char];
    for (let row = 0; row < 5; row++) rows[row] += `${glyph[row]} `;
  }
  return rows.map((row) => row.trimEnd());
}

/** The large wordmark: the block word with the kite flying above its last letter. */
export function wordmarkLarge(): Art {
  const flying = kite('large');
  const text = word('CrewKite');
  const indent = Math.max(...text.map((row) => row.length)) + 2;
  const rows: Art = [];
  const kiteRows = flying.length;
  const total = kiteRows;
  for (let index = 0; index < total; index++) {
    const textRow = index - (total - text.length);
    const left = textRow >= 0 ? text[textRow] : '';
    const cells: Cell[] = [...left].map((char) => ({ text: char, panel: null, word: true }));
    const kiteRow = flying[index];
    if (kiteRow) {
      while (cells.length < indent) cells.push({ text: ' ', panel: null });
      cells.push(...kiteRow);
    }
    rows.push(cells);
  }
  return rows;
}

/** The small wordmark for narrow terminals: a three-row kite and the name. */
export function wordmarkSmall(): Art {
  return kite('small').map((row, index) => [
    ...row,
    ...(index === 0
      ? [...' CrewKite'].map((char) => ({ text: char, panel: null, word: true }))
      : []),
  ]);
}

/** The large mark needs this many columns; narrower terminals get the small one. */
export const LARGE_WORDMARK_COLUMNS = 72;

export const pickWordmark = (columns: number) =>
  columns >= LARGE_WORDMARK_COLUMNS ? wordmarkLarge() : wordmarkSmall();

/** One spinner frame: the kite glyph in one panel colour and a tail that moves. */
export const spinnerFrames: { panel: ChatFamily; tail: string }[] = [
  { panel: 'openai', tail: '∽ ' },
  { panel: 'anthropic', tail: ' ∼' },
  { panel: 'google', tail: '∼ ' },
  { panel: 'local', tail: ' ∽' },
];
export const SPINNER_INTERVAL_MS = 140;
