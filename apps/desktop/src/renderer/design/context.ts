import type { TokenGroup } from '@crewkite/contracts';
import { createContext, useContext } from 'react';

/** What opens the editor: a project, and one of the ways in. */
export type SheetRequest = {
  projectId: string;
  /** The empty editor opens on one of the three ways to start. */
  start?: 'import' | 'template' | 'describe';
  /** Update the system: a draft that adds the found value as a token the person names. */
  add?: { group: TokenGroup; value: string; file: string; line: number };
};

export type DesignSystems = {
  open: (request: SheetRequest) => void;
  /** Counts saves from the editor, so every view that shows the record reads it again. */
  saved: number;
};
export const DesignContext = createContext<DesignSystems>({ open: () => {}, saved: 0 });
export const useDesignSystems = () => useContext(DesignContext);
