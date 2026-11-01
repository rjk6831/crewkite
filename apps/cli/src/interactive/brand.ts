import type { ChatFamily } from '@crewkite/contracts';

// The kite and the wordmark, drawn in quadrant block characters. Each terminal cell holds two by
// two pixels, so the art has twice the resolution of whole blocks in both directions. Each cell
// names the kite panel it belongs to, so the view colours it and a terminal without colour still
// reads the shape.

export type Cell = { text: string; panel: ChatFamily | null; word?: boolean };
export type Art = Cell[][];

/** What one pixel belongs to: a letter or the kite's string, or one kite panel. */
type Ink = 'word' | ChatFamily;
type Canvas = (Ink | null)[][];

// The quadrant character for each set of lit pixels: top left 1, top right 2, bottom left 4 and
// bottom right 8.
const QUADRANTS = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█'];

/**
 * Folds a pixel canvas into cells. A cell takes the ink most of its lit pixels have; the layout
 * keeps the kite's spar and crossbar on cell edges, so no cell mixes two panels.
 */
function toArt(canvas: Canvas): Art {
  const height = Math.ceil(canvas.length / 2);
  const width = Math.ceil(Math.max(...canvas.map((row) => row.length)) / 2);
  const rows: Art = [];
  for (let y = 0; y < height; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < width; x++) {
      const pixels = [
        canvas[2 * y]?.[2 * x],
        canvas[2 * y]?.[2 * x + 1],
        canvas[2 * y + 1]?.[2 * x],
        canvas[2 * y + 1]?.[2 * x + 1],
      ];
      const counts = new Map<Ink, number>();
      for (const pixel of pixels) if (pixel) counts.set(pixel, (counts.get(pixel) ?? 0) + 1);
      const ink = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const mask = pixels.reduce(
        (sum, pixel, bit) => (pixel === ink && ink ? sum + 2 ** bit : sum),
        0,
      );
      row.push(
        ink === null
          ? { text: ' ', panel: null }
          : ink === 'word'
            ? { text: QUADRANTS[mask], panel: null, word: true }
            : { text: QUADRANTS[mask], panel: ink },
      );
    }
    while (row.length > 0 && row[row.length - 1].text === ' ') row.pop();
    rows.push(row);
  }
  return rows;
}

const blank = (width: number, height: number): Canvas =>
  Array.from({ length: height }, () => Array<Ink | null>(width).fill(null));

/**
 * The kite as the desktop draws it: a diamond whose crossbar sits two fifths down, split by the
 * spar and the crossbar into four panels that meet with no gap. Top left Google, top right Local,
 * bottom left OpenAI, bottom right Anthropic, as the desktop's conic gradient places them.
 * `width` and `bar` are even, so the spar and the crossbar fall on cell edges.
 */
function drawKite(canvas: Canvas, left: number, top: number, width: number, height: number) {
  const bar = 2 * Math.round((height * 0.4) / 2);
  const spar = width / 2;
  for (let y = 0; y < height; y++) {
    const middle = y + 0.5;
    const half = middle < bar ? (middle / bar) * spar : ((height - middle) / (height - bar)) * spar;
    for (let x = 0; x < width; x++) {
      if (Math.abs(x + 0.5 - spar) > half) continue;
      const upper = y < bar;
      const leftSide = x < spar;
      canvas[top + y][left + x] = upper
        ? leftSide
          ? 'google'
          : 'local'
        : leftSide
          ? 'openai'
          : 'anthropic';
    }
  }
}

// The letters of the wordmark on a ten pixel cap height, five cells, with a seven pixel x-height.
// A cell is about twice as tall as it is wide, so a pixel is too, and upright strokes are four
// pixels wide to match horizontal strokes two pixels tall. The shapes follow the desktop wordmark:
// a round open C, a single storey e with its opening low on the right, a pointed w and a t whose
// foot turns right.
const glyphs: Record<string, string[]> = {
  C: [
    '      ######      ',
    '   ############   ',
    ' #####      ##### ',
    '####              ',
    '####              ',
    '####              ',
    '####              ',
    ' #####      ##### ',
    '   ############   ',
    '      ######      ',
  ],
  r: [
    '',
    '',
    '',
    '####  #####',
    '###########',
    '#####      ',
    '####       ',
    '####       ',
    '####       ',
    '####       ',
  ],
  e: [
    '',
    '',
    '',
    '   #########   ',
    ' ############# ',
    '####       ####',
    '###############',
    '####           ',
    ' #####     ### ',
    '   #########   ',
  ],
  w: [
    '',
    '',
    '',
    '###     ####     ###',
    '####    ####    ####',
    ' ###   ######   ### ',
    ' ####  ##  ##  #### ',
    '  ### ###  ### ###  ',
    '  ######    ######  ',
    '   ####      ####   ',
  ],
  K: [
    '####       #####',
    '####     #####  ',
    '####   #####    ',
    '#### #####      ',
    '#########       ',
    '##########      ',
    '####  #####     ',
    '####    #####   ',
    '####      ##### ',
    '####       #####',
  ],
  i: ['', '####', '', '####', '####', '####', '####', '####', '####', '####'],
  t: [
    '',
    '  ####   ',
    '  ####   ',
    '#########',
    '#########',
    '  ####   ',
    '  ####   ',
    '  ####   ',
    '  ####   ',
    '   ######',
  ],
};
const GLYPH_ROWS = 10;
const LETTER_GAP = 3;

const glyphWidth = (glyph: string[]) => Math.max(...glyph.map((row) => row.length));

/** Draws the word with its cap top at `top`. */
function drawWord(canvas: Canvas, text: string, left: number, top: number) {
  let x = left;
  for (const char of text) {
    const glyph = glyphs[char];
    for (let y = 0; y < GLYPH_ROWS; y++)
      for (const [at, pixel] of [...(glyph[y] ?? '')].entries())
        if (pixel === '#') canvas[top + y][x + at] = 'word';
    x += glyphWidth(glyph) + LETTER_GAP;
  }
}

const wordWidth = (text: string) =>
  [...text].reduce((sum, char) => sum + glyphWidth(glyphs[char]), 0) +
  LETTER_GAP * (text.length - 1);

// The large kite: twenty four pixels wide and fourteen tall, twelve cells by seven rows, about
// as wide as it is tall on screen.
const KITE_WIDTH = 24;
const KITE_HEIGHT = 14;

/**
 * The large wordmark: the word, with the kite flying above and right of its last letter and its
 * string running down to the word's baseline, as on the desktop.
 */
export function wordmarkLarge(): Art {
  const text = 'CrewKite';
  const word = wordWidth(text);
  // The kite's lower tip sits two rows of pixels below the cap line, right of the last letter
  // and above its x-height, so the panels never touch a letter. Both offsets are even so the
  // spar and the crossbar stay on cell edges.
  const wordTop = KITE_HEIGHT - 2;
  const spar = 2 * Math.ceil((word + 2) / 2);
  const kiteLeft = spar - KITE_WIDTH / 2;
  const canvas = blank(kiteLeft + KITE_WIDTH, wordTop + GLYPH_ROWS);
  drawWord(canvas, text, 0, wordTop);
  drawKite(canvas, kiteLeft, 0, KITE_WIDTH, KITE_HEIGHT);
  // The string drops from the tip and turns left into the foot of the last e.
  const baseline = wordTop + GLYPH_ROWS - 1;
  for (let y = KITE_HEIGHT; y < baseline; y++) canvas[y][spar] = 'word';
  for (let x = word - 3; x <= spar; x++) canvas[baseline][x] = 'word';
  return toArt(canvas);
}

/** The small wordmark for narrow terminals: a three row kite and the name beside it. */
export function wordmarkSmall(): Art {
  const canvas = blank(8, 6);
  drawKite(canvas, 0, 0, 8, 6);
  return toArt(canvas).map((row, index) => [
    ...row,
    ...(index === 1
      ? [...'  CrewKite'].map((char) => ({ text: char, panel: null, word: true }))
      : []),
  ]);
}

const large = wordmarkLarge();
/** The large mark needs its own width and a margin; narrower terminals get the small one. */
export const LARGE_WORDMARK_COLUMNS = Math.max(...large.map((row) => row.length)) + 2;

export const pickWordmark = (columns: number) =>
  columns >= LARGE_WORDMARK_COLUMNS ? large : wordmarkSmall();

/** One spinner frame: the kite glyph in one panel colour and a tail that moves. */
export const spinnerFrames: { panel: ChatFamily; tail: string }[] = [
  { panel: 'openai', tail: '∽ ' },
  { panel: 'anthropic', tail: ' ∼' },
  { panel: 'google', tail: '∼ ' },
  { panel: 'local', tail: ' ∽' },
];
export const SPINNER_INTERVAL_MS = 140;
