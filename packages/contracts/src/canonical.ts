// Sorting object keys gives receipts and handoffs one content identity across processes.
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(input: unknown): string {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') {
      return JSON.stringify(input);
    }
    if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
    if (typeof input !== 'object' || input === null) throw new TypeError('Expected JSON data.');
    if (ancestors.has(input)) throw new TypeError('JSON data cannot contain cycles.');
    const prototype = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Expected a plain JSON object.');
    }
    ancestors.add(input);
    try {
      if (Array.isArray(input)) return `[${Array.from(input, encode).join(',')}]`;
      const record = input as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
        .join(',')}}`;
    } finally {
      ancestors.delete(input);
    }
  }
  return encode(value);
}
