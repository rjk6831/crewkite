import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.ts';
import {
  type HandoffPacket,
  HandoffPacketSchema,
  type SealedHandoffPacket,
  SealedHandoffPacketSchema,
} from './index.ts';
import {
  WRITING_RULES,
  WRITING_RULES_CATALOGUE_VERSION,
  type WritingRule,
} from './writing-rules.ts';

export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * The identity of one enabled rule set: the catalogue version, then each enabled rule's ID,
 * version and text in catalogue order. The order `enabled` arrives in does not matter. An ID the
 * catalogue lacks throws, so a misspelled rule never hashes the same as the set without it.
 */
export function writingRuleDigest(
  enabled: readonly string[],
  catalogue: readonly WritingRule[] = WRITING_RULES,
  catalogueVersion: number = WRITING_RULES_CATALOGUE_VERSION,
): string {
  if (enabled.some((id) => !catalogue.some((rule) => rule.id === id)))
    throw new Error('The rule set names a rule the catalogue does not hold.');
  return hashCanonical({
    catalogueVersion,
    rules: catalogue
      .filter((rule) => enabled.includes(rule.id))
      .map(({ id, version, text }) => ({ id, version, text })),
  });
}

export function sealHandoff(packet: HandoffPacket): SealedHandoffPacket {
  const validated = HandoffPacketSchema.parse(packet);
  return { packet: validated, checksum: hashCanonical(validated) };
}

export function verifyHandoff(value: unknown): value is SealedHandoffPacket {
  const parsed = SealedHandoffPacketSchema.safeParse(value);
  return parsed.success && parsed.data.checksum === hashCanonical(parsed.data.packet);
}
