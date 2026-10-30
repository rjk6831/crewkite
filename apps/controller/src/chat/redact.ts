// Names that mark a value as a secret. The word must end the name, so keyboard and tokenizer stay.
const SECRET_WORDS =
  '(?:token|secret|password|passwd|pwd|key|apikey|authorization|credential|cookie)s?';
const VALUE = `(?:(?:Bearer|Basic|Token)\\s+)?(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s,;}&"']+)`;

const PATTERNS: Array<[RegExp, string]> = [
  // A private key block, across lines, or to the end of the text when the block is cut off.
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[redacted]',
  ],
  // https://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@"'`]+:[^\s/@"'`]+@/gi, '$1[redacted]@'],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '[redacted]'],
  [/\bya29\.[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, '[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{6,}/g, '[redacted]'],
  [/\bBearer\s+[^\s"'`]+/gi, 'Bearer [redacted]'],
  // Basic is also a plain word, so the credential must look like base64 with a digit, sign or
  // inner capital.
  [
    /\bBasic\s+(?=[A-Za-z0-9+/]*(?:[0-9+/=]|[a-z][A-Z]))[A-Za-z0-9+/]{8,}={0,2}/g,
    'Basic [redacted]',
  ],
  // Cookie headers carry the rest of their line.
  [/^([ \t]*(?:Set-)?Cookie[ \t]*:)[ \t]*[^\n]+/gim, '$1 [redacted]'],
  // --api-key abc, --token=abc, --password "a b"
  [
    /(--[A-Za-z0-9-]*(?:key|token|password|passwd|pwd|secret))(=|[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi,
    '$1$2[redacted]',
  ],
  // name=value, name: value and "name": "value", in any case, bare or prefixed.
  [
    new RegExp(`\\b([A-Za-z0-9_.-]*${SECRET_WORDS})(["']?\\s*[:=]\\s*)(${VALUE})`, 'gi'),
    '$1$2[redacted]',
  ],
];

/**
 * Pattern redaction, a second guard for text a model or a command printed. It misses shapes it
 * does not know, and ADR 0044 says so.
 */
export function redact(text: string): string {
  let next = text;
  for (const [pattern, replacement] of PATTERNS) next = next.replace(pattern, replacement);
  return next;
}
