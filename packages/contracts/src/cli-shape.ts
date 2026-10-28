import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical.ts';
import { CliJsonLineSchema } from './cli.ts';

/** The hash of the shape every CLI JSON line takes, embedded chat shapes included. */
export const cliJsonLineShape = (): string =>
  createHash('sha256')
    .update(
      canonicalJson(z.toJSONSchema(CliJsonLineSchema, { unrepresentable: 'any', io: 'input' })),
    )
    .digest('hex');
