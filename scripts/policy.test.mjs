// One test per rule family. Each case list covers the inputs that matter for that rule.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkBranch, checkCommit, checkProse, checkProvenance, checkTree } from './policy.mjs';

const tool = /\bacme-agent\b/i;

test('branch names follow <type>/<kebab-topic>', () => {
  for (const ok of ['main', 'feat/usage-gauges', 'fix/stale-approval', 'docs/adr-0006'])
    assert.deepEqual(checkBranch(ok), [], ok);
  assert.ok(checkBranch('feat/acme-agent-usage', tool).length);
  for (const bad of [
    'acme-agent/usage',
    'feature/x',
    'feat/Usage',
    'feat/usage_gauges',
    'feat/',
    'wip',
  ])
    assert.equal(checkBranch(bad).length, 1, bad);
});

test('commit messages use conventional subjects and carry no authoring marks', () => {
  const valid =
    'feat(router): prefer routes that reset sooner\n\nSpend allowance before its reset while keeping the configured reserve.\n\nSigned-off-by: Ray Kraft <ray@example.com>';
  assert.deepEqual(checkCommit(valid, tool), []);
  for (const invalid of [
    valid.replace('prefer', 'Prefer'),
    valid.replace(/Signed-off-by:.+/, ''),
    valid.replace(
      'Spend allowance before its reset while keeping the configured reserve.',
      'Body.',
    ),
    `${valid}\nCo-authored-by: Someone <someone@example.com>`,
    `${valid}\nGenerated with a tool`,
  ])
    assert.ok(checkCommit(invalid).length);
  assert.ok(checkCommit('Add router', tool).length);
  assert.ok(checkCommit('feat: add router.', tool).length);
  assert.ok(checkCommit(`feat: ${'x'.repeat(80)}`, tool).length);
  assert.ok(checkCommit('feat: add router\nno blank line', tool).length);
  assert.ok(
    checkCommit('feat: add router\n\nCo-authored-by: Acme-Agent <bot@example.com>', tool).length,
  );
});

test('tool instruction files, dot folders and internal/ never enter the tree', () => {
  assert.deepEqual(
    checkTree([
      'README.md',
      'docs/adr/0001-scope.md',
      '.github/workflows/ci.yml',
      'apps/cli/README.md',
    ]),
    [],
  );
  for (const bad of [
    'NOTES.md',
    'apps/cli/RULES.md',
    '.vscode/settings.json',
    'apps/x/.cache/a',
    'internal/spec.md',
  ])
    assert.equal(checkTree([bad]).length, 1, bad);
});

test('prose rules flag dashes, framing and bold lead-ins outside code fences', () => {
  const dash = String.fromCharCode(0x2014);
  assert.deepEqual(
    checkProse(
      'a.md',
      'I chose SQLite.\n\n| **Area** | **State** |\n```\n- **ok** inside a fence\n```',
    ),
    [],
  );
  assert.equal(checkProse('a.md', `One${dash}two`).length, 1);
  assert.equal(checkProse('a.md', 'Use files rather than a server.').length, 1);
  assert.equal(checkProse('a.md', '- **Fast.** It is fast.').length, 1);
  assert.equal(checkProse('a.ts', '// use files rather than a server').length, 0);
});

test('agent names are allowed only under providers/', () => {
  assert.equal(
    checkProvenance('apps/controller/src/router.ts', '// tuned with acme-agent', tool).length,
    1,
  );
  assert.deepEqual(
    checkProvenance('apps/controller/src/providers/acme.ts', "bin: 'acme-agent'", tool),
    [],
  );
  assert.deepEqual(checkProvenance('docs/providers.md', 'acme-agent route', tool), []);
});
