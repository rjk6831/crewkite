import type { ChatFamily } from '@crewkite/contracts';
import { gaugeHue } from '../../../desktop/src/renderer/usage-presentation.ts';

// The desktop's colour tokens in terminal form. The four kite panels keep their family colours:
// teal for OpenAI, coral for Anthropic, indigo for Google and gold for Local. With NO_COLOR every
// colour is left out and shape carries the meaning.

export type Palette = {
  color: boolean;
  text: string | undefined;
  muted: string | undefined;
  accent: string | undefined;
  red: string | undefined;
  green: string | undefined;
  amber: string | undefined;
  border: string | undefined;
  family: Record<ChatFamily, string | undefined>;
  /** The kite panels as drawn, the same in both themes. */
  panel: Record<ChatFamily, string | undefined>;
};

const dark = {
  text: '#e5e8e7',
  muted: '#a1aaa8',
  accent: '#d0e7a1',
  red: '#ec9992',
  green: '#9ed3ad',
  amber: '#e1be83',
  border: '#3a4145',
  family: { openai: '#5fcfc4', anthropic: '#f0917c', google: '#9aa2ec', local: '#e8c56e' },
};
const light = {
  text: '#222b25',
  muted: '#5c6b60',
  accent: '#426326',
  red: '#b64b44',
  green: '#33744a',
  amber: '#8e621c',
  border: '#c7cfc1',
  family: { openai: '#1a6f69', anthropic: '#b4482f', google: '#3d45a0', local: '#7a5d10' },
};
const panel = { openai: '#40b0a8', anthropic: '#e87860', google: '#4850a8', local: '#e0b860' };

/**
 * `system` follows COLORFGBG when the terminal sets it, where a background of 7 or 15 is light.
 * Without it the CLI assumes a dark terminal.
 */
export function resolveTheme(
  theme: 'system' | 'dark' | 'light',
  env: NodeJS.ProcessEnv,
): 'dark' | 'light' {
  if (theme !== 'system') return theme;
  const background = env.COLORFGBG?.split(';').at(-1);
  return background === '7' || background === '15' ? 'light' : 'dark';
}

/** NO_COLOR set to any non-empty value turns colour off, as no-color.org describes. */
export const colorAllowed = (env: NodeJS.ProcessEnv) => !env.NO_COLOR;

export function palette(theme: 'dark' | 'light', color: boolean): Palette {
  const tokens = theme === 'light' ? light : dark;
  const pick = (value: string) => (color ? value : undefined);
  const families = (values: Record<ChatFamily, string>) =>
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, pick(value)])) as Record<
      ChatFamily,
      string | undefined
    >;
  return {
    color,
    text: pick(tokens.text),
    muted: pick(tokens.muted),
    accent: pick(tokens.accent),
    red: pick(tokens.red),
    green: pick(tokens.green),
    amber: pick(tokens.amber),
    border: pick(tokens.border),
    family: families(tokens.family),
    panel: families(panel),
  };
}

export const familyMarks: Record<ChatFamily, string> = {
  openai: 'O',
  anthropic: 'A',
  google: 'G',
  local: 'L',
};
export const familyNames: Record<ChatFamily, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  local: 'Local',
};

/**
 * The gauge colour for a percent remaining, from the desktop's one rule: green down to 40 percent,
 * yellow at 40 and red at empty. The desktop draws `hsl(h 72% 46%)`; this is the same colour in
 * hex, since a terminal takes hex.
 */
export function gaugeHex(percentRemaining: number): string {
  const hue = gaugeHue(percentRemaining);
  const s = 0.72;
  const l = 0.46;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    const value = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/**
 * A gauge as a bar of `width` cells. A read older than 60 minutes draws dotted, the terminal form
 * of the desktop's dotted ring. An unknown percent draws an empty dotted bar.
 */
export function gaugeBar(
  percent: number | null,
  dotted: boolean,
  width: number,
): { filled: string; empty: string } {
  const cells =
    percent === null ? 0 : Math.round((Math.min(100, Math.max(0, percent)) / 100) * width);
  return {
    filled: (dotted ? '┅' : '█').repeat(cells),
    empty: (percent === null || dotted ? '┄' : '░').repeat(width - cells),
  };
}

/** Text from a model, a tool or a provider. Control characters never reach the terminal. */
export const safeText = (value: string) =>
  value.replace(/[\p{Cc}\u2028\u2029]/gu, (character) =>
    character === '\n' || character === '\t' ? character : '\ufffd',
  );
