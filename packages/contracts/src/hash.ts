import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.ts';
import {
  type HandoffPacket,
  HandoffPacketSchema,
  type SealedHandoffPacket,
  SealedHandoffPacketSchema,
} from './index.ts';

export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function sealHandoff(packet: HandoffPacket): SealedHandoffPacket {
  const validated = HandoffPacketSchema.parse(packet);
  return { packet: validated, checksum: hashCanonical(validated) };
}

export function verifyHandoff(value: unknown): value is SealedHandoffPacket {
  const parsed = SealedHandoffPacketSchema.safeParse(value);
  return parsed.success && parsed.data.checksum === hashCanonical(parsed.data.packet);
}
