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
      {
        name: 'fine grained token with underscores',
        input: 'use github_pat_11ABCDEFG0_abcdefghijklmnop_qrstuv now',
        gone: ['github_pat_11', 'qrstuv'],
        kept: ['use', 'now'],
      },
      {
        name: 'slack bot and user tokens',
        input: 'xoxb-123456789012-abcdefABCDEF and xoxp-9876543210-zyxwvuZYXWVU',
        gone: ['xoxb-1234', 'xoxp-9876', 'abcdefABCDEF'],
        kept: [' and '],
      },
      {
        name: 'aws key id then secret',
        input: 'AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY ok',
        gone: ['AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI'],
        kept: ['ok'],
      },
      {
        name: 'aws secret then key id',
        input: 'aws wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY, "AKIAIOSFODNN7EXAMPLE" ok',
        gone: ['AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI'],
        kept: ['aws', 'ok'],
      },
      {
        name: 'aws key id alone',
        input: 'id ASIAIOSFODNN7EXAMPLE',
        gone: ['ASIAIOSFODNN7EXAMPLE'],
      },
      {
        name: 'google api key',
        input: 'key AIzaSyA-abcdefghijklmnopqrstuvwxyz012345 end',
        gone: ['AIzaSyA'],
        kept: ['end'],
      },
      {
        name: 'authorization token scheme',
        input: 'Authorization: token abc123def456\nnext',
        gone: ['abc123def456'],
        kept: ['next'],
      },
      {
        name: 'set-cookie line',
        input: 'Set-Cookie: sid=abc123; Path=/; HttpOnly\nnext line',
        gone: ['abc123', 'HttpOnly'],
        kept: ['next line'],
      },
      {
        name: 'cookie inside a curl argument',
        input: "curl -H 'Cookie: sid=abc123; theme=dark' https://example.com/x",
        gone: ['abc123', 'theme=dark'],
        kept: ['https://example.com/x'],
      },
      {
        name: 'value on the next line after an equals sign',
        input: 'GITHUB_TOKEN=\n  ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        gone: ['ghp_abcdef'],
        kept: ['GITHUB_TOKEN='],
      },
      {
        name: 'plain value on the next line',
        input: 'API_SECRET:\n  plainvalue99',
        gone: ['plainvalue99'],
      },
      {
        name: 'key split by a zero width space',
        input: 'sk-an\u200bt-abc123456789',
        gone: ['abc123456789'],
      },
      {
        name: 'key split by a soft hyphen, a byte order mark, a word joiner and tag characters',
        input:
          'sk-\u00adab\ufeffcd\u{e0041}ef1234567890 and ghp_\u2060abcdefghijklmnopqrstuvwxyz0123456789',
        gone: ['ef1234567890', 'ghp_abcdef'],
      },
      {
        name: 'assignment name split by a zero width space',
        input: 'pass\u200bword=hunter2',
        gone: ['hunter2'],
      },
      {
        name: 'emoji joiner kept',
        input: '\u{1f468}\u200d\u{1f469} and a\u200db',
        kept: ['\u{1f468}\u200d\u{1f469} and ab'],
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

test('shared and diagnostic redaction read a 256 KiB adversarial string in well under a second', () => {
  const size = 256 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  for (const unit of [
    'a',
    'a.',
    'a-',
    'a_',
    '--a',
    '--key',
    'Bearer ',
    'Basic ',
    'token ',
    'token=',
    'key:',
    'a://',
    'a.a://',
    'a:b@',
    'a.b@',
    'password=',
    'Cookie:',
    'AKIAAAAAAAAAAAAAAAAA ',
    `${'A'.repeat(40)} `,
    'eyJaaaa.eyJaaaa.',
    '-----BEGIN PRIVATE KEY-----',
    '\u200b',
    'token=\n',
    ' ',
  ]) {
    const text = fill(unit);
    const started = performance.now();
    redactDiagnosticText(text, home);
    const took = performance.now() - started;
    assert.ok(took < 200, `${JSON.stringify(unit)} took ${Math.round(took)} ms`);
  }
});
