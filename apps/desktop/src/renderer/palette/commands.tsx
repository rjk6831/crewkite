import {
  ArrowUpDown,
  CircleHelp,
  Cpu,
  FileDiff,
  FileDown,
  Folder,
  Info,
  MessageSquareText,
  PanelLeft,
  Plug,
  Settings,
  Share2,
  SquarePen,
  SunMoon,
  Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { provision } from './actions.ts';
import { type EntryIcon, type PaletteApp, paletteEntries } from './entries.ts';
import type { FuzzyMatch } from './fuzzy.ts';

export { rankCommands } from './fuzzy.ts';

/** One row of the palette. `hint` is the second line, and `explicit` keeps it off Enter's default. */
export type PaletteCommand = {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon: ReactNode;
  run: () => void;
  disabled?: boolean;
  // Commands with consequences are never highlighted for you, so Enter after typing cannot run them.
  explicit?: boolean;
};

const ICONS: Record<EntryIcon, ReactNode> = {
  new: <SquarePen size={17} />,
  settings: <Settings size={17} />,
  model: <Cpu size={17} />,
  crew: <Users size={17} />,
  changes: <FileDiff size={17} />,
  help: <CircleHelp size={17} />,
  prompt: <MessageSquareText size={17} />,
  export: <FileDown size={17} />,
  share: <Share2 size={17} />,
  thread: <ArrowUpDown size={17} />,
  folder: <Folder size={17} />,
  theme: <SunMoon size={17} />,
  sidebar: <PanelLeft size={17} />,
  about: <Info size={17} />,
  connect: <Plug size={17} />,
};

// A view's action opens a control that takes focus, so it runs once focus is back where it was.
const afterFocusReturns = (action: () => void) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => action());
  else action();
};

/** Every command the window offers right now, for the palette. */
export function buildPaletteCommands(app: PaletteApp): PaletteCommand[] {
  return paletteEntries(app, provision, afterFocusReturns).map((entry) => ({
    ...entry,
    icon: ICONS[entry.icon],
  }));
}

/** A label with its matched letters marked. */
export function FuzzyText({ text, match }: { text: string; match: FuzzyMatch | null }) {
  if (!match || match.indexes.length === 0) return text;
  const marked = new Set(match.indexes);
  const parts: ReactNode[] = [];
  let run = '';
  let on = false;
  const flush = (key: number) => {
    if (!run) return;
    parts.push(on ? <mark key={key}>{run}</mark> : run);
    run = '';
  };
  let offset = 0;
  for (const character of text) {
    // A matched character covers each UTF-16 unit it takes.
    const hit = marked.has(offset);
    if (hit !== on) {
      flush(offset);
      on = hit;
    }
    run += character;
    offset += character.length;
  }
  flush(offset);
  return <>{parts}</>;
}
