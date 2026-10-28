import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { commandWords, detectChecks } from './checks.ts';

// Claim: the controller reads the declared checks from the project files and nothing else. A
// command is plain words, never a shell line. The table is the whole detection contract.
test('detection reads package scripts, python tools, make targets and a cargo manifest', (t) => {
  const rows: {
    name: string;
    files: Record<string, string>;
    found: [id: string, command: string][];
  }[] = [
    {
      name: 'npm scripts, three declared',
      files: { 'package.json': '{"scripts":{"test":"x","lint":"y","typecheck":"z","build":"b"}}' },
      found: [
        ['package.json:test', 'npm run test'],
        ['package.json:lint', 'npm run lint'],
        ['package.json:typecheck', 'npm run typecheck'],
      ],
    },
    {
      name: 'the lock file picks the package manager',
      files: { 'package.json': '{"scripts":{"test":"x"}}', 'pnpm-lock.yaml': '' },
      found: [['package.json:test', 'pnpm run test']],
    },
    {
      name: 'a broken manifest and a non-string script declare nothing',
      files: { 'package.json': '{"scripts":{"test":1}' },
      found: [],
    },
    {
      name: 'python tool tables',
      files: { 'pyproject.toml': '[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\n' },
      found: [
        ['pyproject.toml:test', 'python3 -m pytest'],
        ['pyproject.toml:lint', 'ruff check'],
        ['pyproject.toml:typecheck', 'mypy .'],
      ],
    },
    {
      name: 'make targets at the start of a line',
      files: { Makefile: 'all:\n\ttest:\ntest:\n\techo\nlint :\n\techo\n' },
      found: [
        ['Makefile:test', 'make test'],
        ['Makefile:lint', 'make lint'],
      ],
    },
    {
      name: 'a cargo manifest',
      files: { 'Cargo.toml': '[package]\nname = "x"\n' },
      found: [
        ['Cargo.toml:test', 'cargo test'],
        ['Cargo.toml:lint', 'cargo clippy'],
        ['Cargo.toml:typecheck', 'cargo check'],
      ],
    },
    { name: 'an empty project', files: { 'README.md': 'nothing' }, found: [] },
  ];
  for (const row of rows) {
    const directory = mkdtempSync(join(tmpdir(), 'crewkite-detect-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const [name, text] of Object.entries(row.files)) {
      mkdirSync(dirname(join(directory, name)), { recursive: true });
      writeFileSync(join(directory, name), text);
    }
    assert.deepEqual(
      detectChecks(directory).map((item) => [item.id, item.command]),
      row.found,
      row.name,
    );
  }
  // A command that needs a shell to mean what it says is refused.
  for (const bad of ['sh -c x', 'npm test | cat', 'echo $HOME', 'node "a b"', 'a;b', ''])
    assert.equal(commandWords(bad), null, bad);
  assert.deepEqual(commandWords('  python3 -m   pytest tests/ '), [
    'python3',
    '-m',
    'pytest',
    'tests/',
  ]);
});
