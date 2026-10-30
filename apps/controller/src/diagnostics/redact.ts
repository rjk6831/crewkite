import { homedir } from 'node:os';
import { redact as redactSecrets } from '../chat/redact.ts';

// What a diagnostics bundle and a crash record may say. Keys, bearer tokens and secret
// assignments go through the controller's existing redaction. This adds the person's home folder,
// which becomes ~, and email addresses. It misses shapes it does not know, like the redaction it
// builds on.

const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g;
// A key whose name ends like a secret loses its whole value, whatever its type or shape.
const SECRET_KEY =
  /(token|secret|password|passwd|pwd|key|apikey|authorization|credential|cookie)s?$/i;

function homePattern(home: string): RegExp | null {
  const trimmed = home.replace(/\/+$/, '');
  if (trimmed === '') return null;
  // The folder name must end where the path does, so /Users/ann leaves /Users/annette alone.
  return new RegExp(
    `${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`,
    'g',
  );
}

export function redactDiagnosticText(text: string, home: string = homedir()): string {
  const pattern = homePattern(home);
  const plain = redactSecrets(text);
  return (pattern ? plain.replace(pattern, '~') : plain).replace(EMAIL, '[redacted]');
}

/** The same rules over every string of a value, plus a key rule for structured data. */
export function redactDiagnosticValue(value: unknown, home: string = homedir()): unknown {
  if (typeof value === 'string') return redactDiagnosticText(value, home);
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue(item, home));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        item !== null && SECRET_KEY.test(key) ? '[redacted]' : redactDiagnosticValue(item, home),
      ]),
    );
  return value;
}
