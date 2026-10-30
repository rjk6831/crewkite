/**
 * Pattern redaction, a second guard for text a model or a command printed. It misses shapes it
 * does not know, and ADR 0044 says so.
 */
export function redact(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(/\bBearer\s+[^\s"'`]+/gi, 'Bearer [redacted]')
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_.-]*(?:TOKEN|SECRET|KEY)[A-Za-z0-9_]*)(["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
      '$1$2[redacted]',
    );
}
