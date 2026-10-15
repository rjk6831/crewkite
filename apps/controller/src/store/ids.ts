import { randomBytes } from 'node:crypto';

export type IdPrefix =
  | 'prj'
  | 'tsk'
  | 'run'
  | 'att'
  | 'rte'
  | 'apr'
  | 'art'
  | 'cnd'
  | 'hnd'
  | 'evt'
  | 'cmd';
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function createIds(now: () => string): (prefix: IdPrefix) => string {
  return (prefix) => {
    const bytes = randomBytes(16);
    const time = BigInt(Date.parse(now()));
    if (time < 0n || time > 281474976710655n) throw new Error('ID clock exceeds ULID bounds.');
    for (let index = 0; index < 6; index++)
      bytes[index] = Number((time >> BigInt((5 - index) * 8)) & 255n);
    let value = BigInt(`0x${bytes.toString('hex')}`);
    let encoded = '';
    for (let index = 0; index < 26; index++) {
      encoded = alphabet[Number(value & 31n)] + encoded;
      value >>= 5n;
    }
    return `${prefix}_${encoded}`;
  };
}
