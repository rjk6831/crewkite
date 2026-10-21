import {
  ConversationModelCatalogEntriesSchema,
  type ConversationModelRequest,
  ConversationModelRequestSchema,
} from '@crewkite/contracts';
import { z } from 'zod';

const retainedObservation = z.strictObject({
  observation: ConversationModelRequestSchema.shape.observation,
  models: ConversationModelCatalogEntriesSchema,
});

export const legacyOpenAiProjectSelection = Object.freeze({
  model: 'gpt-6.1-sol',
  effort: 'low',
  source: 'legacy-profile' as const,
});

export type RetainedOpenAiModelObservation = z.input<typeof retainedObservation>;

/**
 * Resolve an explicit project writer choice only from a controller-verified retained catalog.
 * The caller owns verification of the observation artifact, client and task binding before this
 * pair check. Omission keeps the existing repository profile meaning for legacy commands.
 */
export function resolveOpenAiProjectSelection(
  retained: RetainedOpenAiModelObservation | undefined,
  requested: ConversationModelRequest | undefined,
) {
  if (!requested) return legacyOpenAiProjectSelection;
  const selection = ConversationModelRequestSchema.parse(requested);
  const catalog = retainedObservation.parse(retained);
  if (
    catalog.observation.artifactId !== selection.observation.artifactId ||
    catalog.observation.hash !== selection.observation.hash
  )
    throw new Error('The OpenAI project model observation changed.');
  const model = catalog.models.find((entry) => entry.model === selection.model);
  if (!model) throw new Error('The OpenAI project model is not advertised.');
  if (!model.efforts.includes(selection.effort))
    throw new Error('The OpenAI project effort is not advertised for this model.');
  return Object.freeze({
    model: selection.model,
    effort: selection.effort,
    source: 'retained-advertisement' as const,
    observation: Object.freeze({ ...selection.observation }),
  });
}
