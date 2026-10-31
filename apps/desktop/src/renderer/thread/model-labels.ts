import type { ChatCatalogRead } from '@crewkite/contracts';
import { createContext, useContext } from 'react';

/** The name a family's picker shows for a model ID, with its version, in place of the raw ID. */
export type ModelLabel = (family: string, model: string) => string;

const plain: ModelLabel = (_family, model) => model;

/**
 * Labels from the catalog the composer already holds. A model the catalog does not list, such as
 * an older ID typed in, shows its ID.
 */
export function catalogLabels(catalog: ChatCatalogRead | null): ModelLabel {
  if (!catalog) return plain;
  const labels = new Map<string, string>();
  for (const entry of catalog.families)
    for (const model of entry.models) labels.set(`${entry.family}\n${model.model}`, model.label);
  return (family, model) => labels.get(`${family}\n${model}`) ?? model;
}

export const ModelLabels = createContext<ModelLabel>(plain);

export const useModelLabel = () => useContext(ModelLabels);
