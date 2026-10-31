// Names that mark a value as a secret. The word must end the name, so keyboard and tokenizer stay.
const SECRET_WORDS =
  '(?:token|secret|password|passwd|pwd|key|apikey|authorization|credential|cookie)s?';
// A Bearer or Basic credential an earlier rule already replaced stays as it is.
const VALUE = `(?!(?:Bearer|Basic) \\[redacted\\])(?:Token\\s+)?(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s,;}&"']+)`;

const PATTERNS: Array<[RegExp, string]> = [
  // A private key block, across lines, or to the end of the text when the block is cut off.
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[redacted]',
  ],
  // https://user:password@host. The scheme starts where its run of characters starts, so a long
  // run with no :// is read once.
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/:@"'`]+:[^\s/@"'`]+@/gi, '$1[redacted]@'],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '[redacted]'],
  [/\bya29\.[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, '[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{6,}/g, '[redacted]'],
  // Slack tokens and app tokens.
  [/\b(?:xox[abposr]|xapp)-[A-Za-z0-9-]{6,}/g, '[redacted]'],
  // Google API keys.
  [/\bAIza[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  // An AWS access key id, with the 40 character secret that sits next to it on either side.
  [
    /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])[\s"',:=]{1,20}\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    '[redacted]',
  ],
  [
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b(?:[\s"',:=]{1,20}(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+]))?/g,
    '[redacted]',
  ],
  [/\bBearer\s+[^\s"'`]+/gi, 'Bearer [redacted]'],
  // Basic is also a plain word, so the credential must look like base64 with a digit, sign or
  // inner capital.
  [
    /\bBasic\s+(?=[A-Za-z0-9+/]*(?:[0-9+/=]|[a-z][A-Z]))[A-Za-z0-9+/]{8,}={0,2}/g,
    'Basic [redacted]',
  ],
  // Cookie headers carry the rest of their line, or up to the quote that closes a curl argument.
  [/(?<![A-Za-z0-9_-])((?:Set-)?Cookie[ \t]*:)[ \t]*[^\n"'`]+/gi, '$1 [redacted]'],
  // --api-key abc, --token=abc, --password "a b"
  [
    /(?<![A-Za-z0-9_-])(--[A-Za-z0-9-]*(?:key|token|password|passwd|pwd|secret))(=|[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi,
    '$1$2[redacted]',
  ],
  // name=value, name: value and "name": "value", in any case, bare or prefixed.
  [
    // The name starts where its run of name characters starts, so `a.a.a.a` is read once.
    new RegExp(
      `(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]*${SECRET_WORDS})(["']?\\s*[:=]\\s*)(${VALUE})`,
      'gi',
    ),
    '$1$2[redacted]',
  ],
];

// Format characters (zero width spaces, the soft hyphen, the byte order mark, tag characters) are
// invisible and split a secret in two without changing how it reads. They go before any rule runs.
// A zero width joiner stays between two characters that are not ASCII, where emoji need it.
const HIDDEN = /\p{Cf}/gu;
export function withoutHiddenCharacters(text: string): string {
  return text.replace(HIDDEN, (found, at: number) =>
    found === '\u200d' && text.charCodeAt(at - 1) > 0x7f && text.charCodeAt(at + 1) > 0x7f
      ? found
      : '',
  );
}

/**
 * Pattern redaction, a second guard for text a model or a command printed. It misses shapes it
 * does not know, and ADR 0044 says so.
 */
export function redact(text: string): string {
  let next = withoutHiddenCharacters(text);
  for (const [pattern, replacement] of PATTERNS) next = next.replace(pattern, replacement);
  return next;
}
