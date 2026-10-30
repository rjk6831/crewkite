import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redact } from '../chat/redact.ts';
import { redactDiagnosticText, redactDiagnosticValue } from './redact.ts';

const home = '/home/ann';
const digest = 'a'.repeat(64);
const pem =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90\nline-two-of-key\n-----END RSA PRIVATE KEY-----';

type Row = { name: string; input: string; gone?: string[]; kept?: string[] };

function check(rows: Row[], run: (text: string) => string) {
  for (const { name, input, gone = [], kept = [] } of rows) {
    const output = run(input);
    for (const text of gone) assert.equal(output.includes(text), false, `${name}: ${text}`);
    for (const text of kept) assert.equal(output.includes(text), true, `${name}: ${text}`);
  }
}

test('shared redaction removes every secret shape and leaves ordinary words, digests and paths', () => {
  check(
    [
      { name: 'sk key', input: 'failed with sk-test1234567890', gone: ['sk-test1234567890'] },
      {
        name: 'bearer',
        input: 'Authorization: Bearer abc.def-ghi',
        gone: ['abc.def-ghi'],
        kept: ['[redacted]'],
      },
      {
        name: 'basic',
        input: 'Authorization: Basic dXNlcjpwYXNzd29yZA==',
        gone: ['dXNlcjpwYXNzd29yZA'],
      },
      {
        name: 'upper case assignment',
        input: 'API_KEY=hunter2value',
        gone: ['hunter2value'],
        kept: ['API_KEY='],
      },
      { name: 'bare password', input: 'password=hunter2', gone: ['hunter2'], kept: ['password='] },
      { name: 'passwd', input: 'passwd: hunter2', gone: ['hunter2'] },
      { name: 'pwd', input: 'db_pwd=hunter2', gone: ['hunter2'] },
      { name: 'json secret', input: '{"secret": "s3cr3t"}', gone: ['s3cr3t'], kept: ['"secret'] },
      { name: 'bare key', input: 'key: k3yvalue', gone: ['k3yvalue'] },
      { name: 'camel case token', input: '"accessToken": "tok-value-1"', gone: ['tok-value-1'] },
      { name: 'plural', input: 'tokens=abc123 keys: k1', gone: ['abc123', 'k1'] },
      { name: 'credential', input: 'credential=cred-value', gone: ['cred-value'] },
      {
        name: 'url query',
        input: 'GET /cb?code=1&token=abc123&x=2',
        gone: ['abc123'],
        kept: ['x=2'],
      },
      {
        name: 'cookie header',
        input: 'Cookie: sid=abc123; theme=dark\nnext line',
        gone: ['abc123', 'theme=dark'],
        kept: ['next line'],
      },
      {
        name: 'github personal',
        input: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        gone: ['ghp_abcdef'],
      },
      {
        name: 'github oauth',
        input: 'gho_abcdefghijklmnopqrstuvwxyz0123456789',
        gone: ['gho_abcdef'],
      },
      {
        name: 'github server',
        input: 'ghs_abcdefghijklmnopqrstuvwxyz0123456789',
        gone: ['ghs_abcdef'],
      },
      {
        name: 'github user',
        input: 'ghu_abcdefghijklmnopqrstuvwxyz0123456789',
        gone: ['ghu_abcdef'],
      },
      {
        name: 'github refresh',
        input: 'ghr_abcdefghijklmnopqrstuvwxyz0123456789',
        gone: ['ghr_abcdef'],
      },
      {
        name: 'github fine grained',
        input: 'github_pat_11ABCDEFG0abcdefghijklmnop',
        gone: ['github_pat_11'],
      },
      {
        name: 'jwt',
        input: 'got eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJl here',
        gone: ['eyJhbGci', 'c2lnbmF0dXJl'],
        kept: ['got', 'here'],
      },
      { name: 'google oauth', input: 'token ya29.a0AfH6SMBx-abc_123', gone: ['ya29.a0AfH6'] },
      {
        name: 'pem block',
        input: `before\n${pem}\nafter`,
        gone: ['MIIBOg', 'line-two-of-key', 'END RSA'],
        kept: ['before', 'after'],
      },
      {
        name: 'cut pem block',
        input: 'x\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN',
        gone: ['MIIEvQ'],
        kept: ['x'],
      },
      {
        name: 'argv pair',
        input: 'run --api-key abc123 --verbose',
        gone: ['abc123'],
        kept: ['--verbose'],
      },
      { name: 'argv token', input: 'run --token abc123', gone: ['abc123'] },
      { name: 'argv password equals', input: 'run --password="a b c"', gone: ['a b c'] },
      {
        name: 'url userinfo',
        input: 'clone https://user:pass123@example.com/repo.git',
        gone: ['pass123', 'user:'],
        kept: ['example.com/repo.git'],
      },
      {
        name: 'value split across a JSON line',
        input: '{\n  "apiToken":\n    "line-split-value"\n}',
        gone: ['line-split-value'],
        kept: ['apiToken'],
      },
      // Text that must survive.
      {
        name: 'keyboard',
        input: 'the keyboard layout and a tokenizer',
        kept: ['the keyboard layout and a tokenizer'],
      },
      { name: 'sha256 digest', input: `"sha256": "${digest}"`, kept: [digest] },
      {
        name: 'path with secret',
        input: 'open /srv/secret/notes.txt and ./keys/readme',
        kept: ['/srv/secret/notes.txt', './keys/readme'],
      },
      {
        name: 'plain basic',
        input: 'Basic information about the setup',
        kept: ['Basic information about the setup'],
      },
      {
        name: 'url without userinfo',
        input: 'https://example.com:8080/path',
        kept: ['https://example.com:8080/path'],
      },
    ],
    redact,
  );
});

test('diagnostic redaction adds home paths and emails and redacts any value under a secret key', () => {
  check(
    [
      {
        name: 'home path',
        input: 'cwd /home/ann/work and /home/annette/work',
        gone: ['/home/ann/work'],
        kept: ['~/work', '/home/annette/work'],
      },
      {
        name: 'home path at sentence end',
        input: 'It lives in /home/ann.',
        gone: ['/home/ann'],
        kept: ['~.'],
      },
      {
        name: 'home path before a dotted name',
        input: 'see /home/ann.bak',
        kept: ['/home/ann.bak'],
      },
      {
        name: 'email',
        input: 'owner ann.lee+tag@example.com wrote',
        gone: ['ann.lee+tag@example.com'],
        kept: ['owner [redacted] wrote'],
      },
      {
        name: 'shared rules still apply',
        input: 'password=hunter2 sk-test1234567890',
        gone: ['hunter2', 'sk-test1234567890'],
      },
    ],
    (text) => redactDiagnosticText(text, home),
  );

  // Structured data stays valid. A secret key loses a string, a number, an array or an object.
  assert.deepEqual(
    redactDiagnosticValue(
      {
        password: 'plain',
        tokens: ['a', 'b'],
        apiKey: 12345,
        credentials: { user: 'u', pass: 'p' },
        cookie: 'sid=1',
        empty: null,
        nested: [{ note: 'mail a@b.co from /home/ann' }],
        count: 3,
      },
      home,
    ),
    {
      password: '[redacted]',
      tokens: '[redacted]',
      apiKey: '[redacted]',
      credentials: '[redacted]',
      cookie: '[redacted]',
      empty: null,
      nested: [{ note: 'mail [redacted] from ~' }],
      count: 3,
    },
  );
});
