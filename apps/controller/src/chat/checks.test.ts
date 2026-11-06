import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { addedProblem, commandWords, detectChecks, testsLine } from './checks.ts';

// Claim: the controller reads the declared checks from the project files and nothing else. A
// command is plain words, never a shell line. The table is the whole detection contract.
test('detection reads package scripts, python tools, pytest, make targets, cargo and go', (t) => {
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
    {
      name: 'pytest named as a dependency, with no tool table',
      files: {
        'pyproject.toml':
          '[project]\ndependencies = []\n[dependency-groups]\ndev = ["pytest>=8"]\n',
      },
      found: [['pyproject.toml:test', 'python3 -m pytest']],
    },
    {
      name: 'pytest in a Poetry table',
      files: { 'pyproject.toml': '[tool.poetry.group.dev.dependencies]\npytest = "^8"\n' },
      found: [['pyproject.toml:test', 'python3 -m pytest']],
    },
    {
      name: 'a pytest plugin alone is not pytest',
      files: { 'pyproject.toml': '[project]\ndependencies = ["pytest-cov"]\n' },
      found: [],
    },
    {
      name: 'a pytest.ini with no pyproject',
      files: { 'pytest.ini': '[pytest]\n' },
      found: [['pytest.ini:test', 'python3 -m pytest']],
    },
    {
      name: 'a pytest.ini beside a pyproject that declares pytest gives one test check',
      files: { 'pyproject.toml': '[tool.pytest.ini_options]\n', 'pytest.ini': '[pytest]\n' },
      found: [['pyproject.toml:test', 'python3 -m pytest']],
    },
    {
      name: 'make rules that name several targets, and no special targets or assignments',
      files: {
        Makefile: '.PHONY: test lint\ntypecheck := mypy\ntest lint: deps\n\techo both\n',
      },
      found: [
        ['Makefile:test', 'make test'],
        ['Makefile:lint', 'make lint'],
      ],
    },
    {
      name: 'a go module',
      files: { 'go.mod': 'module example.com/x\n\ngo 1.23\n' },
      found: [
        ['go.mod:test', 'go test ./...'],
        ['go.mod:lint', 'go vet ./...'],
      ],
    },
    {
      name: 'a mixed project lists every stack in order',
      files: {
        'package.json': '{"scripts":{"test":"x"}}',
        'pyproject.toml': '[tool.ruff]\n',
        'go.mod': 'module x\n',
      },
      found: [
        ['package.json:test', 'npm run test'],
        ['pyproject.toml:lint', 'ruff check'],
        ['go.mod:test', 'go test ./...'],
        ['go.mod:lint', 'go vet ./...'],
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
  // The resolved text shows the pre and post scripts that npm runs, and a pnpm run shows none.
  const resolvedFor = (files: Record<string, string>) => {
    const directory = mkdtempSync(join(tmpdir(), 'crewkite-detect-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
    return detectChecks(directory).map((item) => item.resolved);
  };
  const scripts = '{"scripts":{"pretest":"a","test":"b","posttest":"c"}}';
  assert.deepEqual(resolvedFor({ 'package.json': scripts }), [
    'npm run test runs pretest: a; test: b; posttest: c',
  ]);
  assert.deepEqual(resolvedFor({ 'package.json': scripts, 'pnpm-lock.yaml': '' }), [
    'pnpm run test runs test: b',
  ]);
  assert.deepEqual(resolvedFor({ Makefile: 'test:\n\tgo vet\n\tgo test\n' }), [
    'make test runs go vet; go test',
  ]);
  assert.deepEqual(resolvedFor({ Makefile: 'lint:' }), ['make lint runs no recipe']);
  // A command a person adds cannot start a shell or a wrapper, run inline code or leave the copy.
  const scratch = '/home/example/scratch';
  for (const [line, refused] of [
    ['node gate.mjs', false],
    ['python3 -m pytest tests/', false],
    ['node scripts/gate.mjs --flag=1', false],
    [`node ${scratch}/gate.mjs`, false],
    ['env FOO=1 node gate.mjs', true],
    ['nice node gate.mjs', true],
    ['npx vitest', true],
    ['node -e 1', true],
    ['node --eval=1', true],
    ['python3 -c x', true],
    ['node /etc/passwd', true],
    ['node --require=/etc/x gate.mjs', true],
    ['node ../gate.mjs', true],
  ] as const) {
    const words = commandWords(line);
    assert.ok(words, line);
    assert.equal(addedProblem(words, scratch) !== null, refused, line);
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

// Claim: the Run tests line names the command that failed with its own exit status, however many
// test commands ran and in whatever order, and one command reads as it always has.
test('the run tests line names the failed command, not the last one', () => {
  const run = (command: string, status: 'passed' | 'failed', exitCode: number | null) => ({
    command,
    status,
    exitCode,
  });
  const cases: [Parameters<typeof testsLine>, string][] = [
    [
      ['failed', [run('npm run test', 'failed', 1), run('make test', 'passed', 0)]],
      'Tests failed: npm run test (exit 1), 1 of 2 commands failed. The output is under Checks.',
    ],
    [
      [
        'failed',
        [
          run('npm run test', 'passed', 0),
          run('make test', 'failed', 2),
          run('cargo test', 'failed', 101),
        ],
      ],
      'Tests failed: make test (exit 2), 2 of 3 commands failed. The output is under Checks.',
    ],
    [
      ['failed', [run('npm run test', 'failed', 1)]],
      'Tests failed: npm run test (exit 1). The output is under Checks.',
    ],
    [
      ['failed', [run('npm run test', 'failed', null)]],
      'Tests failed: npm run test. The output is under Checks.',
    ],
    [['passed', [run('npm run test', 'passed', 0)]], 'Tests passed: npm run test (exit 0).'],
    [
      ['passed', [run('npm run test', 'passed', 0), run('make test', 'passed', 0)]],
      'Tests passed: all 2 commands. The output is under Checks.',
    ],
  ];
  for (const [input, line] of cases) assert.equal(testsLine(...input), line);
});
