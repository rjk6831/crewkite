#!/usr/bin/env node
// Repository policy checks. Zero dependencies, so they run before install,
// in git hooks and as the first CI job.
//
//   node scripts/policy.mjs branch <name>
//   node scripts/policy.mjs commit <message-file>
//   node scripts/policy.mjs commits [<range>]
//   node scripts/policy.mjs staged
//   node scripts/policy.mjs all            tree + prose + provenance on tracked files

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TYPES = [
  'feat',
  'fix',
  'docs',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];

const BRANCH = new RegExp(`^(main|(${TYPES.join('|')})/[a-z0-9]+(-[a-z0-9]+)*)$`);
const SUBJECT = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9-]+\\))?!?: \\S.*$`);

// Tracked paths may start with a dot only for these entries.
const DOT_OK = new Set([
  '.github',
  '.githooks',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.nvmrc',
  '.npmrc',
]);
// Upper-case Markdown names are reserved for these files. Tool instruction files stay local.
const UPPER_MD_OK = new Set(['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md']);

// Prose rules for Markdown. Each entry is [pattern, message].
const PROSE_MD = [
  [/\brather\s+than\b/i, 'comparison framing; state the choice directly'],
  [/\binstead\s+of\b/i, 'comparison framing; state the choice directly'],
  [/\bnot\s+(just|only|merely)\b/i, 'contrast framing; state the claim directly'],
  [
    /\b(seamless(ly)?|effortless(ly)?|blazing|revolutionary|game-?changing|cutting-edge|supercharge[sd]?|unleash(es)?|delve)\b/i,
    'hype word; describe what it does',
  ],
  [
    /\b(leverag(e|es|ed|ing)|robust|comprehensive|streamlin(e|es|ed|ing)|empower(s|ed|ing)?|holistic|tapestry|pivotal|moreover|furthermore|it'?s worth noting)\b/i,
    'filler or stock phrasing; say it plainly',
  ],
  [/^\s*([-*+]|\d+\.)\s+\*\*[^*]+\*\*/, 'bold lead-in on a list item'],
  [/^\*\*[^*]+[.:]\*\*/, 'bold lead-in on a paragraph'],
];
// Prose rules for every tracked text file.
const PROSE_ALL = [
  [/[\u2013\u2014]/, 'en or em dash; use a comma, colon, period or hyphen'],
  [/\bthe\s+founder\b/i, 'third-person reference to the author; write in first person'],
];

const TEXT = /\.(md|mdx|ts|tsx|js|mjs|cjs|json|ya?ml|css|html|sh|txt)$|(^|\/)[^.]+$/;
const SKIP = /(^|\/)(pnpm-lock\.yaml|LICENSE|NOTICE)$/;
// Agent and model product names may appear only where the product integrates with them.
const PROVIDER_PATH = /(^|\/)providers(\/|\.md$)/;

export function checkBranch(name, pattern) {
  const errors = BRANCH.test(name)
    ? []
    : [`branch "${name}" must be main or <type>/<kebab-topic>, for example feat/usage-gauges`];
  if (pattern?.test(name)) errors.push('branch name includes a tool name');
  return errors;
}

export function checkCommit(message, pattern) {
  const lines = message.split('\n').filter((line) => !line.startsWith('#'));
  const subject = lines[0] ?? '';
  const errors = [];
  if (!SUBJECT.test(subject))
    errors.push(
      `subject "${subject}" must be <type>(<scope>)?: <summary> with type in ${TYPES.join(', ')}`,
    );
  if (/:[ ]+[A-Z]/.test(subject)) errors.push('summary must start with lower case');
  if (subject.length > 72) errors.push('subject is longer than 72 characters');
  if (/\.\s*$/.test(subject)) errors.push('subject ends with a period');
  if (lines.length > 1 && lines[1].trim() !== '')
    errors.push('leave a blank line after the subject');
  const body = lines
    .slice(2)
    .filter((line) => !/^Signed-off-by:/i.test(line))
    .join(' ')
    .trim();
  if (body.length < 20) errors.push('body must explain why the change is needed');
  if (!/^Signed-off-by: [^<>\n]+ <[^<>\s]+@[^<>\s]+>$/im.test(message))
    errors.push('DCO sign-off is required');
  if (/^(?:co-authored-by:|generated (?:with|by)\b|authored by:)/im.test(message))
    errors.push('authoring trailers are not allowed');
  for (const [rule, why] of PROSE_ALL)
    if (rule.test(message)) errors.push(`commit message: ${why}`);
  if (pattern?.test(message))
    errors.push('commit message names an agent or carries an authoring trailer');
  return errors;
}

export function checkTree(paths) {
  const errors = [];
  for (const path of paths) {
    const parts = path.split('/');
    if (parts[0] === 'internal') errors.push(`${path}: internal/ is private and never tracked`);
    const dotted = parts.find((part) => part.startsWith('.') && !DOT_OK.has(part));
    if (dotted) errors.push(`${path}: dot path "${dotted}" is not tracked`);
    const base = parts.at(-1);
    if (/^[A-Z][A-Z0-9_-]*\.md$/.test(base) && !UPPER_MD_OK.has(base))
      errors.push(`${path}: instruction-style file names stay local`);
  }
  return errors;
}

export function checkProse(path, text) {
  const errors = [];
  const rules = path.endsWith('.md') ? [...PROSE_ALL, ...PROSE_MD] : PROSE_ALL;
  let fenced = false;
  text.split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('```')) fenced = !fenced;
    for (const [rule, why] of rules) {
      if (fenced && PROSE_MD.some(([md]) => md === rule)) continue;
      if (rule.test(line)) errors.push(`${path}:${i + 1}: ${why}`);
    }
  });
  return errors;
}

export function checkProvenance(path, text, pattern) {
  if (!pattern || PROVIDER_PATH.test(path)) return [];
  return text
    .split('\n')
    .flatMap((line, i) =>
      pattern.test(line) ? [`${path}:${i + 1}: names an agent outside providers/`] : [],
    );
}

export function loadPattern(env = process.env) {
  const source =
    env.PROVENANCE_PATTERN ||
    (existsSync('internal/provenance-pattern.txt')
      ? readFileSync('internal/provenance-pattern.txt', 'utf8').trim()
      : '');
  return source ? new RegExp(source, 'i') : null;
}

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const lines = (out) => out.split('\n').filter(Boolean);

function scanFiles(paths, pattern) {
  return paths
    .filter((path) => TEXT.test(path) && !SKIP.test(path) && existsSync(path))
    .flatMap((path) => {
      const text = readFileSync(path, 'utf8');
      return [...checkProse(path, text), ...checkProvenance(path, text, pattern)];
    });
}

function run([command, arg]) {
  const pattern = loadPattern();
  switch (command) {
    case 'branch':
      return checkBranch(arg ?? git('branch', '--show-current').trim(), pattern);
    case 'commit':
      return checkCommit(readFileSync(arg, 'utf8'), pattern);
    case 'commits': {
      const shas = arg
        ? lines(git('rev-list', '--no-merges', arg))
        : [git('rev-parse', 'HEAD').trim()];
      return shas.flatMap((sha) =>
        checkCommit(git('log', '-1', '--format=%B', sha).trim(), pattern).map(
          (e) => `${sha.slice(0, 8)}: ${e}`,
        ),
      );
    }
    case 'staged': {
      const staged = lines(git('diff', '--cached', '--name-only', '--diff-filter=ACR'));
      return [...checkTree(staged), ...scanFiles(staged, pattern)];
    }
    case 'all': {
      if (!pattern && process.env.CI)
        return ['PROVENANCE_PATTERN is not set; the provenance check fails closed in CI'];
      if (!pattern)
        console.warn('policy: provenance pattern not found locally; skipping that check');
      const tracked = lines(git('ls-files'));
      return [...checkTree(tracked), ...scanFiles(tracked, pattern)];
    }
    default:
      return [`unknown command "${command}"`];
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = run(process.argv.slice(2));
  for (const error of errors) console.error(`policy: ${error}`);
  process.exit(errors.length ? 1 : 0);
}
