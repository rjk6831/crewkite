import { type DesignFinding, type DesignSystem, TokenNameSchema } from '@crewkite/contracts';

// The design check. It reads authored CSS and the literal values in TSX style objects, and reports
// each value that goes around the design system: a raw color, a spacing step or radius written as
// a literal, a font family the system does not name, or a shadow written out by hand. Callers pass
// every file except the token source itself.
//
// What passes, and why:
// - A var() reference reads a token. Its fallback is checked like any other value.
// - Zero, keywords (auto, inherit, transparent, currentColor, system colors) and vendor-prefixed
//   values name no design choice.
// - A relative color such as rgb(from var(--red) r g b / 6%) derives from its origin, so only the
//   origin is checked.
// - Percentages, viewport and container units scale with the box, so no fixed scale can hold them.
// - Font sizes, widths, offsets and SVG geometry fall outside the spacing rule.
// - A font family passes when the system names it, since the name is the font itself.
// - A TSX style value computed at runtime is geometry the code owns. Only string and number
//   literals are checked, and only inside style={...}.
// A custom property declared outside the token source is checked where a rule reads it, so a
// local alias cannot hide a literal. The finding points at the declaration. Each place that reads
// the alias gets one more, with the first value of its base declaration that no token holds as
// written. The base is the plain :root declaration outside at-rules, as in the token source, or
// else the first by path and offset. So an alias that copies a token, as a CSS copy of the tokens
// does, adds nothing where it is read, and any other declaration, such as a theme's override,
// reports only where it is written. A shadow copies a token when it matches it layer for layer,
// colors included. A caller that keeps the findings of some files only still sees an alias that
// another file declares, and the order it passes files in never changes the base.
//
// Project files are arbitrary input, so every walk is bounded. A file nested more than 64 levels
// deep (blocks, parentheses or template literals) is skipped whole, and scanFiles names it. So is a
// TSX file whose walks would visit more than 8 characters for each one it holds, as many unclosed
// attributes would. An alias chain is followed 8 steps. A var() that reads further is reported as
// written, under the rule of the property that reads it.

export type TokenSet = DesignSystem['tokens'];
export type DesignRule = DesignFinding['rule'];
export type Finding = Pick<DesignFinding, 'file' | 'line' | 'rule' | 'found' | 'nearestToken'>;
export type SourceFile = { path: string; text: string };

type Piece =
  | { kind: 'word'; text: string; at: number }
  | { kind: 'comma'; text: ','; at: number }
  | { kind: 'fn'; name: string; text: string; at: number; args: Piece[] };
type Source = { path: string; text: string; lines: number[] };
// `root` when a plain :root rule holds the declaration outside any at-rule.
type Written = { property: string; value: string; at: number; root?: boolean };
type Declaration = { source: Source; property: string; at: number; root: boolean; pieces: Piece[] };
type Dimension = { value: number; unit: string };
// A value and the token nearest to it. `exact` when that token holds the value as written. `deep`
// when an alias chain ran past the step limit, and `text` is the var() that would read on.
type Hit = { text: string; nearestToken: string | null; exact: boolean; deep?: boolean };
type Nearest = Pick<Hit, 'nearestToken' | 'exact'>;
// Where a check sends each value it finds. `at` is an offset in the file being checked.
type Sink = (at: number, hit: Hit) => void;
type Check = (declaration: Declaration, pieces: Piece[], sink: Sink, steps: number) => void;
// OKLab lightness, a and b, then alpha.
type Color = [number, number, number, number];
// One TSX file as its walks read it. `steps` is what the walks may still visit. `lastClose` is where
// the last `*/` starts, so a comment that never closes is known without a search.
type Script = { text: string; steps: number; lastClose: number };

// Real stylesheets and style objects nest a handful of levels. Past this a file is not read.
const MAX_DEPTH = 64;
// Characters the TSX walks may visit for each one in the file. A file of nothing but style objects
// takes about 2, since an attribute is read once to find its end and again for its entries, and the
// app's own files take under 1. An attribute that never closes reads on to the end of the file, so
// many of them would take time that grows with the square of the file.
const SCRIPT_STEPS = 8;
// Steps through var() aliases, in the color tokens and in scanned files.
const ALIAS_STEPS = 8;
// Values closer than this are one value written two ways, such as #fff and rgb(255 255 255).
const SAME = 1e-6;
const NONE: Nearest = { nearestToken: null, exact: false };
const SPACING =
  /^(?:(?:margin|padding|scroll-margin|scroll-padding)(?:-[a-z]+)*|(?:grid-)?(?:row-|column-)?gap)$/;
const RADIUS = /^border(?:-[a-z]+)*-radius$/;
const SHADOW = /^(?:box|text)-shadow$/;
// Named colors are read only where a color can appear, so a grid line or animation called "tan"
// stays a name.
const NAMED_COLOR_PROPERTY =
  /color|background|border|outline|shadow|text-decoration|column-rule|^fill$|^stroke$|^filter$|^--/;
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// One way to split each number, so a long run of digits cannot backtrack.
const NUMBER = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i;
const COLOR_FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'device-cmyk',
]);
// Lengths that hold a fixed size. Relative units (%, vw, cqi and the rest) pass.
const FIXED_UNITS = new Set('px rem em ex ch cap ic lh rlh pt pc in cm mm q'.split(' '));
// em and rem count as 16px when the check suggests a token; the real base depends on the element.
const PX: Record<string, number> = {
  px: 1,
  rem: 16,
  em: 16,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
};
const HUE_UNITS: Record<string, number> = {
  '': 1,
  deg: 1,
  grad: 0.9,
  rad: 180 / Math.PI,
  turn: 360,
};
// Linear sRGB to XYZ (D65), the Bradford adaptation from D50 to D65, and XYZ to OKLab through LMS,
// as CSS Color 4 publishes them. lab() and lch() are relative to the D50 white.
const RGB_TO_XYZ = [
  [506752 / 1228815, 87881 / 245763, 12673 / 70218],
  [87098 / 409605, 175762 / 245763, 12673 / 175545],
  [7918 / 409605, 87881 / 737289, 1001167 / 1053270],
];
const D50_TO_D65 = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
];
const XYZ_TO_LMS = [
  [0.819022437996703, 0.3619062600528904, -0.1288737815209879],
  [0.0329836539323885, 0.9292868615863434, 0.0361446663506424],
  [0.0481771893596242, 0.2642395317527308, 0.6335478284694309],
];
const LMS_TO_OKLAB = [
  [0.210454268309314, 0.7936177747023054, -0.0040720430116193],
  [1.9779985324311684, -2.42859224204858, 0.450593709617411],
  [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
];
const D50_X = 0.3457 / 0.3585;
const D50_Z = (1 - 0.3457 - 0.3585) / 0.3585;
const CSS_WIDE = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
const GENERIC_FAMILIES = new Set(
  'serif sans-serif monospace cursive fantasy system-ui ui-serif ui-sans-serif ui-monospace ui-rounded math emoji fangsong'.split(
    ' ',
  ),
);
const FONT_SIZES = new Set(
  'xx-small x-small small medium large x-large xx-large xxx-large larger smaller math'.split(' '),
);
const NAMED_COLORS = new Map(
  `aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc
  bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a
  burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50
  cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b
  darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b
  darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000
  darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f
  darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff
  dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0
  forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520
  gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4
  indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5
  lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff
  lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1
  lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899
  lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32
  linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd
  mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee
  mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970
  mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6
  olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa
  palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9
  peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399
  red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460
  seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd
  slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c
  teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3
  white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32`
    .trim()
    .split(/\s+/)
    .flatMap((word, index, words) => (index % 2 ? [] : [[word, `#${words[index + 1]}`] as const])),
);

const tooDeep = () => new RangeError(`Nested more than ${MAX_DEPTH} levels deep.`);

/** Every value in `files` that goes around `tokens`, for the rules asked for. */
export function scan(
  files: readonly SourceFile[],
  tokens: TokenSet,
  rules: readonly DesignRule[],
): Finding[] {
  return scanFiles(files, tokens, rules).findings;
}

/**
 * The findings, and the path of each file too deeply nested or too costly to read. A skipped file
 * has none.
 */
export function scanFiles(
  files: readonly SourceFile[],
  tokens: TokenSet,
  rules: readonly DesignRule[],
): { findings: Finding[]; skipped: string[] } {
  const skipped: string[] = [];
  const declarations = files.flatMap((file): Declaration[] => {
    const source = { path: file.path, text: file.text, lines: lineStarts(file.text) };
    // Every value is parsed here, so the checks below cannot fail on a file that got through.
    try {
      const written: Written[] = file.path.endsWith('.css')
        ? [...cssDeclarations(file.text)]
            .filter(
              (declaration) => !declaration.atRules.some((rule) => /^@font-face\b/i.test(rule)),
            )
            .map(({ selector, atRules, ...declaration }) => ({
              ...declaration,
              root: atRules.length === 0 && plainRoot(selector),
            }))
        : /\.[jt]sx$/.test(file.path)
          ? styleDeclarations(file.text)
          : [];
      return written.map(({ property, value, at, root = false }) => ({
        source,
        property: property.replace(/^-(?:webkit|moz|ms|o)-/, ''),
        at,
        root,
        pieces: parseValue(value, at),
      }));
    } catch {
      skipped.push(file.path);
      return [];
    }
  });
  const locals = Map.groupBy(
    declarations.filter((declaration) => declaration.property.startsWith('--')),
    (declaration) => declaration.property,
  );
  const palette = Object.entries(tokens.color).flatMap(([name, token]): [string, Color][] => {
    const color = colorOf(token.$value, tokens);
    return color ? [[name, color]] : [];
  });
  const fontTokens = Object.entries(tokens.type).flatMap(([name, token]) =>
    token.$type === 'fontFamily' ? [{ name, families: familyNames(token.$value) }] : [],
  );
  const families = new Set(fontTokens.flatMap((token) => token.families));
  const found = new Map<string, { at: number; finding: Finding }>();
  const report = (rule: DesignRule, source: Source, at: number, { text, nearestToken }: Hit) => {
    // The contract holds one well-formed line of 1 to 200 UTF-16 units. The cut keeps pairs whole.
    const value = text
      .toWellFormed()
      .replace(/[\s\p{Cc}]+/gu, ' ')
      .trim()
      .slice(0, 200)
      .replace(/[\uD800-\uDBFF]$/, '');
    if (!value) return;
    const line = lineAt(source.lines, at);
    const key = `${source.path}\n${line}\n${rule}\n${value}`;
    if (!found.has(key))
      found.set(key, {
        at,
        finding: { file: source.path, line, rule, found: value, nearestToken },
      });
  };

  // Whether a value matches a shadow token layer for layer.
  const copiesShadow = (pieces: Piece[]) => {
    const layers = split(pieces).map(shadowLayer);
    return Object.values(tokens.shadow).some((token) => {
      const held = [token.$value].flat();
      return (
        held.length === layers.length &&
        held.every((layer, index) => {
          const value = layers[index];
          return value ? shadowDistance(layer, value) < SAME : false;
        })
      );
    });
  };

  // A var() names a token unless a scanned file declares it. Each declaration of an alias is
  // checked once per rule, at its own line. Readers get the first value of the base declaration
  // that no token holds as written. Any other declaration, such as a theme's override, reports at
  // its own line only, since the system holds one value for each token. Callers pass changed files
  // first, so input order would let a changed override stand in for an unchanged base.
  const before = (left: Declaration, right: Declaration) =>
    left.root !== right.root
      ? left.root
      : left.source.path !== right.source.path
        ? left.source.path < right.source.path
        : left.at < right.at;
  const resolved = new Map<string, Hit | null>();
  const resolve = (rule: DesignRule, check: Check, name: string, steps: number): Hit | null => {
    const key = `${rule}\n${name}`;
    if (resolved.has(key)) return resolved.get(key) ?? null;
    const declared = locals.get(name);
    if (!declared) return null;
    // The walk stops here. The reader reports the var() it holds, so the chain cannot pass unread.
    if (steps > ALIAS_STEPS) return { ...NONE, text: '', deep: true };
    // Set before the check, so an alias that reads itself resolves to nothing.
    resolved.set(key, null);
    let first: Hit | null = null;
    const base = declared.reduce((best, local) => (before(local, best) ? local : best));
    declared.forEach((local) => {
      const readers = local === base && !copiesShadow(local.pieces);
      check(
        local,
        local.pieces,
        (at, hit) => {
          if (!hit.deep) report(rule, local.source, at, hit);
          if (readers && !hit.exact) first ??= hit;
        },
        steps,
      );
    });
    resolved.set(key, first);
    return first;
  };
  const read = (rule: DesignRule, check: Check, piece: Piece, sink: Sink, steps: number) => {
    if (piece.kind !== 'fn' || piece.name !== 'var') return;
    const hit = resolve(rule, check, piece.args[0]?.text ?? '', steps + 1);
    if (hit) sink(piece.at, hit.deep ? { ...hit, text: piece.text } : hit);
  };

  const colors: Check = (declaration, pieces, sink, steps) => {
    for (const piece of pieces) {
      if (piece.kind === 'fn') {
        if (piece.name === 'url') continue;
        if (piece.name === 'var') {
          read('raw-color', colors, piece, sink, steps);
          colors(declaration, fallback(piece), sink, steps);
        } else if (COLOR_FUNCTIONS.has(piece.name) && piece.args[0]?.text.toLowerCase() !== 'from')
          sink(piece.at, { text: piece.text, ...nearestColor(piece.text, palette) });
        else colors(declaration, piece.args, sink, steps);
      } else if (
        HEX.test(piece.text) ||
        (NAMED_COLOR_PROPERTY.test(declaration.property) &&
          NAMED_COLORS.has(piece.text.toLowerCase()))
      )
        sink(piece.at, { text: piece.text, ...nearestColor(piece.text, palette) });
    }
  };
  const lengths = (rule: 'off-scale-spacing' | 'off-scale-radius', group: 'spacing' | 'radius') => {
    const check: Check = (declaration, pieces, sink, steps) => {
      for (const piece of pieces) {
        if (piece.kind === 'fn') {
          if (piece.name === 'url') continue;
          read(rule, check, piece, sink, steps);
          check(declaration, piece.name === 'var' ? fallback(piece) : piece.args, sink, steps);
          continue;
        }
        const size = dimension(piece.text);
        if (size && size.value !== 0 && FIXED_UNITS.has(size.unit))
          sink(piece.at, { text: piece.text, ...nearestDimension(tokens, group, size) });
      }
    };
    return check;
  };
  const fonts: Check = (declaration, pieces, sink, steps) => {
    const nearest = nearestFont(fontTokens, pieces);
    for (const family of split(pieces)) {
      const [first] = family;
      if (!first) continue;
      if (family.length === 1 && first.kind === 'fn' && first.name === 'var') {
        read('unknown-font', fonts, first, sink, steps);
        fonts(declaration, fallback(first), sink, steps);
        continue;
      }
      const name = family.map((piece) => unquote(piece.text)).join(' ');
      const lower = name.replace(/\s+/g, ' ').toLowerCase();
      if (
        GENERIC_FAMILIES.has(lower) ||
        CSS_WIDE.has(lower) ||
        lower.startsWith('-') ||
        families.has(lower)
      )
        continue;
      // A family the system names passed above, so a family found here is never a token's.
      sink(first.at, { text: name, nearestToken: nearest, exact: false });
    }
  };
  const shadows: Check = (declaration, pieces, sink, steps) => {
    for (const layer of split(pieces)) {
      const [first] = layer;
      const last = layer.at(-1);
      if (!first || !last) continue;
      if (layer.length === 1 && first.kind === 'fn' && first.name === 'var') {
        read('unknown-shadow', shadows, first, sink, steps);
        shadows(declaration, fallback(first), sink, steps);
        continue;
      }
      const word = first.text.toLowerCase();
      if (layer.length === 1 && (word === 'none' || CSS_WIDE.has(word))) continue;
      const text = declaration.source.text.slice(first.at, last.at + last.text.length);
      // An alias that copies a shadow token passes in resolve, so a layer alone is never exact.
      sink(first.at, { text, nearestToken: nearestShadow(tokens, layer), exact: false });
    }
  };

  const spacing = lengths('off-scale-spacing', 'spacing');
  const radius = lengths('off-scale-radius', 'radius');
  for (const declaration of declarations) {
    const { source, property, pieces } = declaration;
    // A var() left unread at the step limit is reported once, under the property's own rule.
    const own = ownRule(property);
    const run = (rule: DesignRule, check: Check, values = pieces) => {
      if (rules.includes(rule))
        check(
          declaration,
          values,
          (at, hit) => {
            if (!hit.deep || rule === own) report(rule, source, at, hit);
          },
          0,
        );
    };
    run('raw-color', colors);
    if (own === 'off-scale-spacing') run(own, spacing);
    if (own === 'off-scale-radius') run(own, radius);
    if (own === 'unknown-shadow') run(own, shadows);
    if (own === 'unknown-font')
      run(own, fonts, property === 'font' ? shorthandFamilies(pieces) : pieces);
  }
  const findings = [...found.values()]
    .sort(
      (left, right) =>
        (left.finding.file < right.finding.file
          ? -1
          : left.finding.file > right.finding.file
            ? 1
            : 0) || left.at - right.at,
    )
    .map(({ finding }) => finding);
  return { findings, skipped };
}

/**
 * Reads tokens from the custom properties of `:root` rules in a CSS token file. A rule whose
 * selector adds a theme attribute is that theme's override and is not read. `--space-*`,
 * `--radius-*`, `--shadow-*` and `--font-*` fill their groups; any other property that holds a
 * color is a color token. Names and values the contract cannot hold are skipped. A file nested
 * more than 64 levels deep throws.
 */
export function readCssTokens(text: string): TokenSet {
  const tokens: TokenSet = { color: {}, type: {}, spacing: {}, radius: {}, shadow: {}, motion: {} };
  for (const { selector, property, value } of cssDeclarations(text)) {
    if (!property.startsWith('--') || !plainRoot(selector)) continue;
    const [, group = '', name = ''] =
      /^--(?:(space|radius|shadow|font)-)?(.+)$/.exec(property) ?? [];
    if (!TokenNameSchema.safeParse(name).success) continue;
    const written = value.trim();
    const pieces = parseValue(written, 0);
    if (group === 'space' || group === 'radius') {
      const size = dimension(written);
      if (size && (size.unit === 'px' || size.unit === 'rem'))
        tokens[group === 'space' ? 'spacing' : 'radius'][name] = {
          $type: 'dimension',
          $value: { value: size.value, unit: size.unit === 'rem' ? 'rem' : 'px' },
        };
    } else if (group === 'font') {
      tokens.type[name] = {
        $type: 'fontFamily',
        $value: split(pieces).map((family) => family.map((piece) => unquote(piece.text)).join(' ')),
      };
    } else if (group === 'shadow') {
      const layers = split(pieces).map(shadowLayer);
      if (layers.length > 0 && layers.every((layer): layer is ShadowLayer => layer !== null))
        tokens.shadow[name] = {
          $type: 'shadow',
          $value: layers.length === 1 ? layers[0] : layers,
        };
    } else if (
      written.length <= 100 &&
      (colorOf(written, tokens) !== null || /^(?:var|color-mix)\(/i.test(written))
    ) {
      tokens.color[name] = { $type: 'color', $value: written };
    }
  }
  return tokens;
}

/** Declarations in a stylesheet, with the selector and at-rules around each one. */
export function* cssDeclarations(source: string): Generator<{
  selector: string;
  atRules: string[];
  property: string;
  value: string;
  at: number;
}> {
  const text = withoutComments(source);
  const stack: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"' || char === "'") {
      index = stringEnd(text, index) - 1;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && char === '{') {
      // Each declaration copies the at-rules around it, so the stack must stay short.
      if (stack.length === MAX_DEPTH) throw tooDeep();
      stack.push(text.slice(start, index).trim().replace(/\s+/g, ' '));
      start = index + 1;
    } else if (depth === 0 && (char === ';' || char === '}')) {
      const raw = text.slice(start, index);
      const colon = raw.indexOf(':');
      const property = colon < 0 ? '' : raw.slice(0, colon).trim();
      if (stack.length > 0 && /^(?:--[\w-]+|-?[A-Za-z][\w-]*)$/.test(property))
        yield {
          selector: stack.findLast((prelude) => !prelude.startsWith('@')) ?? '',
          atRules: stack.filter((prelude) => prelude.startsWith('@')),
          property: property.startsWith('--') ? property : property.toLowerCase(),
          value: raw.slice(colon + 1).replace(/!\s*important\s*$/i, ''),
          at: start + colon + 1,
        };
      if (char === '}') stack.pop();
      start = index + 1;
    }
  }
}

// Comments become spaces of the same length, so offsets and lines still match the file.
function withoutComments(text: string): string {
  const parts: string[] = [];
  let last = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"' || char === "'") index = stringEnd(text, index) - 1;
    else if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      const end = close < 0 ? text.length : close + 2;
      parts.push(text.slice(last, index), text.slice(index, end).replace(/[^\n]/g, ' '));
      last = end;
      index = end - 1;
    }
  }
  parts.push(text.slice(last));
  return parts.join('');
}

function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length && text[index] !== text[start] && text[index] !== '\n')
    index += text[index] === '\\' ? 2 : 1;
  return Math.min(index + 1, text.length);
}

// A value as words, commas and functions. Offsets are absolute in the file, from `base`.
function parseValue(text: string, base: number): Piece[] {
  let index = 0;
  const read = (depth: number): Piece[] => {
    if (depth > MAX_DEPTH) throw tooDeep();
    const pieces: Piece[] = [];
    while (index < text.length) {
      const char = text[index] ?? '';
      if (char === ')') {
        index++;
        return pieces;
      }
      if (/\s/.test(char)) {
        index++;
      } else if (char === ',' || char === '/') {
        pieces.push(
          char === ','
            ? { kind: 'comma', text: ',', at: base + index }
            : { kind: 'word', text: '/', at: base + index },
        );
        index++;
      } else if (char === '"' || char === "'") {
        const end = stringEnd(text, index);
        pieces.push({ kind: 'word', text: text.slice(index, end), at: base + index });
        index = end;
      } else {
        const start = index;
        while (index < text.length && !/[\s,()"'/]/.test(text[index] ?? '')) index++;
        const name = text.slice(start, index);
        if (text[index] !== '(') {
          pieces.push({ kind: 'word', text: name, at: base + start });
          continue;
        }
        index++;
        if (name.toLowerCase() === 'url') {
          while (/\s/.test(text[index] ?? '')) index++;
          if (text[index] === '"' || text[index] === "'") index = stringEnd(text, index);
          const close = text.indexOf(')', index);
          index = close < 0 ? text.length : close + 1;
          pieces.push({
            kind: 'fn',
            name: 'url',
            text: text.slice(start, index),
            at: base + start,
            args: [],
          });
          continue;
        }
        const args = read(depth + 1);
        pieces.push({
          kind: 'fn',
          name: name.toLowerCase(),
          text: text.slice(start, index),
          at: base + start,
          args,
        });
      }
    }
    return pieces;
  };
  return read(0);
}

// The one rule a property answers to. Spacing, radius, shadow and font properties have their own.
// Another property that can hold a color has raw-color. A custom property has none, since the
// places that read it answer for it.
function ownRule(property: string): DesignRule | null {
  if (SPACING.test(property)) return 'off-scale-spacing';
  if (RADIUS.test(property)) return 'off-scale-radius';
  if (SHADOW.test(property)) return 'unknown-shadow';
  if (property === 'font' || property === 'font-family') return 'unknown-font';
  return !property.startsWith('--') && NAMED_COLOR_PROPERTY.test(property) ? 'raw-color' : null;
}

// Whether a selector list names :root alone in one of its parts. :root[data-theme="light"] is a
// theme's override.
function plainRoot(selector: string): boolean {
  return selector.split(',').some((part) => part.trim() === ':root');
}

function split(pieces: Piece[]): Piece[][] {
  const groups: Piece[][] = [[]];
  for (const piece of pieces)
    if (piece.kind === 'comma') groups.push([]);
    else groups.at(-1)?.push(piece);
  return groups.filter((group) => group.length > 0);
}

function fallback(piece: Piece): Piece[] {
  if (piece.kind !== 'fn') return [];
  const comma = piece.args.findIndex((arg) => arg.kind === 'comma');
  return comma < 0 ? [] : piece.args.slice(comma + 1);
}

function unquote(text: string): string {
  return /^(["']).*\1$/s.test(text) ? text.slice(1, -1) : text;
}

function dimension(text: string): Dimension | null {
  const match = NUMBER.exec(text);
  return match ? { value: Number(match[1]), unit: (match[2] ?? '').toLowerCase() } : null;
}

// The family list of a font shorthand, from its first family to the end. The first family is the
// run of names just before the first comma; a size, a number, a slash or the line height after one
// ends the run. A var() alone in that place is the family.
function shorthandFamilies(pieces: Piece[]): Piece[] {
  const comma = pieces.findIndex((piece) => piece.kind === 'comma');
  const head = comma < 0 ? pieces.length : comma;
  const afterSlash = (index: number) => pieces[index - 1]?.text === '/';
  const named = (index: number) => {
    const piece = pieces[index];
    return (
      piece?.kind === 'word' &&
      piece.text !== '/' &&
      !dimension(piece.text) &&
      !FONT_SIZES.has(piece.text.toLowerCase()) &&
      !afterSlash(index)
    );
  };
  let start = head;
  while (start > 0 && named(start - 1)) start--;
  const last = pieces[head - 1];
  if (
    start === head &&
    head > 1 &&
    last?.kind === 'fn' &&
    last.name === 'var' &&
    !afterSlash(head - 1)
  )
    start--;
  return start === 0 ? [] : pieces.slice(start);
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1))
    starts.push(index + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

// Inline style objects in TSX. Each string or number literal becomes a declaration; React adds
// px to a bare number on a length property, so a number reads as px. An attribute inside a string
// or comment is not one, and an attribute that never closes is not read, so the rest of the file
// cannot pass for its body. Spaces around = still make an attribute; a variable named style does
// not.
function styleDeclarations(text: string): Written[] {
  const declarations: Written[] = [];
  const script: Script = {
    text,
    steps: SCRIPT_STEPS * text.length,
    lastClose: text.lastIndexOf('*/'),
  };
  const attribute = /(?<![\w$.-])(?<!\b(?:const|let|var)\s{1,8})style\s*=\s*\{/y;
  for (let index = 0; index < text.length; index++) {
    const skipped = skipScript(script, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    attribute.lastIndex = index;
    if (text[index] !== 's' || !attribute.test(text)) continue;
    const open = attribute.lastIndex - 1;
    const end = closeOf(script, open);
    if (end > text.length) continue;
    for (let inner = open + 1; inner < end - 1; inner++) {
      const skipped = skipScript(script, inner);
      if (skipped !== inner) {
        inner = skipped - 1;
        continue;
      }
      if (text[inner] !== '{') continue;
      const close = closeOf(script, inner);
      for (const entry of entries(script, inner + 1, close - 1)) {
        const match =
          /^\s*(?:([A-Za-z_$][\w$]*)|'([^']*)'|"([^"]*)")\s*:\s*('[^'\\\n]*'|"[^"\\\n]*"|`[^`$\\]*`|-?(?:\d+(?:\.\d*)?|\.\d+))\s*$/.exec(
            entry.text,
          );
        if (!match) continue;
        const key = match[1] ?? match[2] ?? match[3] ?? '';
        const literal = match[4] ?? '';
        const quoted = /^['"`]/.test(literal);
        const number = Number(literal);
        declarations.push({
          property: key.startsWith('--')
            ? key
            : key
                .replace(/^ms(?=[A-Z])/, '-ms')
                .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
          value: quoted ? literal.slice(1, -1) : number === 0 ? '0' : `${literal}px`,
          at: entry.at + entry.text.trimEnd().length - literal.length + (quoted ? 1 : 0),
        });
      }
      inner = close - 1;
    }
    index = end - 1;
  }
  return declarations;
}

// Top-level entries of an object literal body between `start` and `end`, each with the offset it
// starts at. Comments read as spaces, so a note beside an entry hides nothing.
function entries(script: Script, start: number, end: number): { at: number; text: string }[] {
  const { text } = script;
  const found: { at: number; text: string }[] = [];
  let at = start;
  let entry = '';
  let copied = start;
  for (let index = start; index <= end; index++) {
    const skipped = skipScript(script, index);
    if (skipped !== index) {
      if (text[index] === '/') {
        entry += text.slice(copied, index) + ' '.repeat(skipped - index);
        copied = skipped;
      }
      index = skipped - 1;
    } else if (/[{([]/.test(text[index] ?? '')) {
      index = closeOf(script, index) - 1;
    } else if (index === end || text[index] === ',') {
      found.push({ at, text: entry + text.slice(copied, index) });
      entry = '';
      at = copied = index + 1;
    }
  }
  return found;
}

// The index after the bracket that closes the one at `open`, or past the end when none does.
// `depth` counts the template literals around it.
function closeOf(script: Script, open: number, depth = 0): number {
  if (depth > MAX_DEPTH) throw tooDeep();
  const { text } = script;
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
  const stack = [pairs[text[open] ?? ''] ?? ''];
  let index = open + 1;
  while (index < text.length && stack.length > 0) {
    const skipped = skipScript(script, index, depth);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const char = text[index] ?? '';
    if (pairs[char]) stack.push(pairs[char]);
    else if (char === stack.at(-1)) stack.pop();
    index = advance(script, index, index + 1);
  }
  return stack.length > 0 ? text.length + 1 : index;
}

// The index after a string, template or comment that starts at `index`, or `index` itself. JSX
// text is read as script. A quote right after a letter or digit (Don't) and `//` right after a
// colon (https://) start nothing, since formatted script never starts a string or comment there.
// A template or block comment that never closes is JSX text too, since script would not parse with
// one left open.
function skipScript(script: Script, index: number, depth = 0): number {
  const { text } = script;
  const char = text[index];
  const before = text[index - 1] ?? '';
  if ((char === '"' || char === "'") && !/[\p{L}\p{N}_$]/u.test(before))
    return advance(script, index, stringEnd(text, index));
  if (char === '/' && text[index + 1] === '/' && before !== ':') {
    const newline = text.indexOf('\n', index);
    return advance(script, index, newline < 0 ? text.length : newline);
  }
  if (char === '/' && text[index + 1] === '*')
    return script.lastClose < index + 2
      ? index
      : advance(script, index, text.indexOf('*/', index + 2) + 2);
  if (char !== '`') return index;
  let at = index + 1;
  while (at < text.length && text[at] !== '`') {
    if (text[at] === '\\') at = advance(script, at, at + 2);
    else if (text[at] === '$' && text[at + 1] === '{') at = closeOf(script, at + 1, depth + 1);
    else at = advance(script, at, at + 1);
  }
  return at < text.length ? at + 1 : index;
}

// Moves a walk on to `to`, and counts what it passed against the file's steps.
function advance(script: Script, from: number, to: number): number {
  script.steps -= to - from;
  if (script.steps < 0) throw tooDeep();
  return to;
}

// The step nearest a size, and whether the size equals it: positive, the same number of pixels,
// and in px or rem, the units a token holds.
function nearestDimension(tokens: TokenSet, group: 'spacing' | 'radius', size: Dimension): Nearest {
  const scale = PX[size.unit];
  if (scale === undefined) return NONE;
  const target = Math.abs(size.value * scale);
  let best: { name: string; distance: number; px: number } | null = null;
  for (const [name, token] of Object.entries(tokens[group])) {
    const px = token.$value.value * (token.$value.unit === 'rem' ? 16 : 1);
    const distance = Math.abs(px - target);
    // A value halfway between two steps takes the larger one.
    if (!best || distance < best.distance || (distance === best.distance && px > best.px))
      best = { name, distance, px };
  }
  if (!best) return NONE;
  return {
    nearestToken: `${group}.${best.name}`,
    exact: best.distance < SAME && size.value > 0 && (size.unit === 'px' || size.unit === 'rem'),
  };
}

// The color token that looks closest, by distance in OKLab, and whether it is the same color. A
// full step of alpha weighs as much as black to white.
function nearestColor(text: string, palette: readonly [string, Color][]): Nearest {
  const target = colorOf(text);
  if (!target) return NONE;
  let best: { name: string; distance: number } | null = null;
  for (const [name, color] of palette) {
    const distance =
      Math.hypot(color[0] - target[0], color[1] - target[1], color[2] - target[2]) +
      Math.abs(color[3] - target[3]);
    if (!best || distance < best.distance) best = { name, distance };
  }
  return best ? { nearestToken: `color.${best.name}`, exact: best.distance < SAME } : NONE;
}

// A CSS color in OKLab with alpha, or null for one this cannot place: color(), device-cmyk(), a
// relative color, transparent or currentColor. A var() follows the color tokens.
function colorOf(text: string, tokens?: TokenSet, steps = 0): Color | null {
  const value = text.trim().toLowerCase();
  const alias = /^var\(\s*--([\w-]+)\s*\)$/.exec(value);
  if (alias) {
    const token = tokens?.color[alias[1] ?? ''];
    return token && steps < ALIAS_STEPS ? colorOf(token.$value, tokens, steps + 1) : null;
  }
  const hex = (NAMED_COLORS.get(value) ?? value).match(/^#([0-9a-f]+)$/)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const digits =
      hex.length <= 4 ? [...hex].map((digit) => digit + digit) : (hex.match(/../g) ?? []);
    const [r = 0, g = 0, b = 0, alpha = 1] = digits.map((pair) => Number.parseInt(pair, 16) / 255);
    return [...fromRgb([r, g, b]), alpha] as Color;
  }
  const call = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((.*)\)$/.exec(value);
  if (!call) return null;
  const [x = '', y = '', z = '', a] = (call[2] ?? '').split(/[\s,/]+/).filter(Boolean);
  // A percentage is a share of `whole`; a bare number is multiplied by `scale`.
  const number = (part: string, whole: number, scale = 1) =>
    part.endsWith('%') ? (Number.parseFloat(part) / 100) * whole : Number.parseFloat(part) * scale;
  const space = (call[1] ?? '').replace(/a$/, '');
  let lab: number[];
  if (space === 'rgb') lab = fromRgb([x, y, z].map((part) => number(part, 1, 1 / 255)));
  else if (space === 'hsl') lab = fromRgb(hsl(hue(x), number(y, 1, 0.01), number(z, 1, 0.01)));
  else if (space === 'hwb') {
    const white = number(y, 1, 0.01);
    const black = number(z, 1, 0.01);
    // White and black that add up to 100% or more make a gray.
    const gray = white / (white + black);
    lab = fromRgb(
      white + black >= 1
        ? [gray, gray, gray]
        : hsl(hue(x), 1, 0.5).map((channel) => channel * (1 - white - black) + white),
    );
  } else if (space === 'oklab') lab = [number(x, 1), number(y, 0.4), number(z, 0.4)];
  else if (space === 'oklch') lab = [number(x, 1), ...polar(number(y, 0.4), hue(z))];
  else if (space === 'lab') lab = fromCieLab(number(x, 100), number(y, 125), number(z, 125));
  else lab = fromCieLab(number(x, 100), ...polar(number(y, 150), hue(z)));
  const color = [...lab, a === undefined ? 1 : number(a, 1)];
  return color.every(Number.isFinite) ? (color as Color) : null;
}

// HSL to sRGB channels from 0 to 1. Saturation and lightness run from 0 to 1.
function hsl(degrees: number, saturation: number, lightness: number): number[] {
  const chroma = saturation * Math.min(lightness, 1 - lightness);
  return [0, 8, 4].map((offset) => {
    const step = (offset + (((degrees % 360) + 360) % 360) / 30) % 12;
    return lightness - chroma * Math.max(-1, Math.min(step - 3, 9 - step, 1));
  });
}

// A hue in degrees. A bare number is degrees.
function hue(part: string): number {
  const size = dimension(part);
  return size ? size.value * (HUE_UNITS[size.unit] ?? Number.NaN) : Number.NaN;
}

function polar(chroma: number, degrees: number): [number, number] {
  const radians = (degrees * Math.PI) / 180;
  return [chroma * Math.cos(radians), chroma * Math.sin(radians)];
}

// sRGB channels from 0 to 1 to OKLab, through linear light and XYZ.
function fromRgb(rgb: number[]): number[] {
  const linear = rgb.map((channel) => {
    const size = Math.abs(channel);
    return size <= 0.04045 ? channel / 12.92 : Math.sign(channel) * ((size + 0.055) / 1.055) ** 2.4;
  });
  return oklab(times(RGB_TO_XYZ, linear));
}

// CIE Lab against the D50 white to OKLab, through XYZ.
function fromCieLab(lightness: number, a: number, b: number): number[] {
  const y = (lightness + 16) / 116;
  // Lab compresses with a cube root, and a straight segment near black.
  const expand = (f: number) => (f ** 3 > 216 / 24389 ? f ** 3 : (116 * f - 16) / (24389 / 27));
  return oklab(
    times(D50_TO_D65, [expand(y + a / 500) * D50_X, expand(y), expand(y - b / 200) * D50_Z]),
  );
}

function oklab(xyz: number[]): number[] {
  return times(LMS_TO_OKLAB, times(XYZ_TO_LMS, xyz).map(Math.cbrt));
}

function times(matrix: number[][], vector: number[]): number[] {
  return matrix.map((row) =>
    row.reduce((sum, value, index) => sum + value * (vector[index] ?? 0), 0),
  );
}

// A family token holds one name or a CSS family list. Both read as lower case names.
function familyNames(value: string | string[]): string[] {
  return [value]
    .flat()
    .flatMap((list) =>
      list.split(',').map((name) => unquote(name.trim()).replace(/\s+/g, ' ').toLowerCase()),
    );
}

// The family token that shares a generic family with the list found, or the first family token.
function nearestFont(
  fonts: readonly { name: string; families: string[] }[],
  pieces: Piece[],
): string | null {
  const generics = new Set(
    pieces
      .map((piece) => unquote(piece.text).toLowerCase())
      .filter((name) => GENERIC_FAMILIES.has(name)),
  );
  const match = fonts.find((font) => font.families.some((name) => generics.has(name))) ?? fonts[0];
  return match ? `type.${match.name}` : null;
}

type ShadowLayer = {
  color: string;
  offsetX: Dimension & { unit: 'px' | 'rem' };
  offsetY: Dimension & { unit: 'px' | 'rem' };
  blur: Dimension & { unit: 'px' | 'rem' };
  spread: Dimension & { unit: 'px' | 'rem' };
  inset?: boolean;
};

function shadowLayer(pieces: Piece[]): ShadowLayer | null {
  const sizes: (Dimension & { unit: 'px' | 'rem' })[] = [];
  const color: string[] = [];
  let inset = false;
  for (const piece of pieces) {
    const size = piece.kind === 'word' ? dimension(piece.text) : null;
    if (piece.text.toLowerCase() === 'inset') inset = true;
    else if (size && (size.unit === 'px' || size.unit === 'rem' || size.value === 0))
      sizes.push({ value: size.value, unit: size.unit === 'rem' ? 'rem' : 'px' });
    else color.push(piece.text);
  }
  const [offsetX, offsetY, blur = { value: 0, unit: 'px' }, spread = { value: 0, unit: 'px' }] =
    sizes;
  if (!offsetX || !offsetY || sizes.length > 4) return null;
  return {
    color: color.join(' ') || 'currentcolor',
    offsetX,
    offsetY,
    blur,
    spread,
    ...(inset ? { inset } : {}),
  };
}

// The shadow token with the closest geometry; color breaks a tie.
function nearestShadow(tokens: TokenSet, pieces: Piece[]): string | null {
  const found = shadowLayer(pieces);
  if (!found) return null;
  let best: { name: string; distance: number } | null = null;
  for (const [name, token] of Object.entries(tokens.shadow)) {
    const [layer] = [token.$value].flat();
    if (!layer) continue;
    const distance = shadowDistance(layer, found);
    if (!best || distance < best.distance) best = { name, distance };
  }
  return best ? `shadow.${best.name}` : null;
}

// Pixels apart in offsets, blur and spread. A different inset outweighs any size, and a color
// written differently adds half a pixel. Zero means the same layer.
function shadowDistance(layer: ShadowLayer, found: ShadowLayer): number {
  const px = (size: { value: number; unit: string }) => size.value * (size.unit === 'rem' ? 16 : 1);
  return (
    Math.abs(px(layer.offsetX) - px(found.offsetX)) +
    Math.abs(px(layer.offsetY) - px(found.offsetY)) +
    Math.abs(px(layer.blur) - px(found.blur)) +
    Math.abs(px(layer.spread) - px(found.spread)) +
    (Boolean(layer.inset) === Boolean(found.inset) ? 0 : 1000) +
    (layer.color.replace(/\s+/g, '').toLowerCase() === found.color.replace(/\s+/g, '').toLowerCase()
      ? 0
      : 0.5)
  );
}
