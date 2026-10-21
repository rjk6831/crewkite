import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Artifact } from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { createTestIds } from '@crewkite/testkit';
import { ArtifactFiles } from '../artifacts/index.ts';
import { type FileContent, materialize, readFiles } from '../host/source.ts';
import { CandidateEvidence } from './index.ts';
import { evaluatePythonCheck, preparePythonCheck } from './python-check.ts';

const digest = (content: Buffer) => createHash('sha256').update(content).digest('hex');
const file = (path: string, content: string): FileContent => {
  const bytes = Buffer.from(content);
  return { path, mode: '100644', hash: digest(bytes), bytes: bytes.length, content: bytes };
};
const budget = () => ({
  deadline: Date.now() + 30_000,
  now: Date.now,
  maximumEntries: 10_000,
  maximumBytes: 64 * 1024 * 1024,
});

test('Python 3.9+ unittest checks bind unchanged tests and post-check source', () => {
  const testFile = file(
    'tests/test_calculator.py',
    [
      'import unittest',
      'from calculator import add',
      '',
      'class CalculatorTests(unittest.TestCase):',
      '    def test_adds_two_numbers(self):',
      '        self.assertEqual(add(2, 3), 5)',
      '',
    ].join('\n'),
  );
  const baseline = [
    file('calculator.py', 'def add(left, right):\n    return left - right\n'),
    testFile,
  ];
  const candidate = [
    file('calculator.py', 'def add(left, right):\n    return left + right\n'),
    testFile,
  ];
  const definition = preparePythonCheck({
    candidateId: 'cnd_01M51M322B2AEBXD9MA74CBCFM',
    candidateHash: 'a'.repeat(64),
    source: baseline,
    candidate,
    criteria: ['Adding two numbers returns their sum.'],
    testFiles: ['tests/test_calculator.py'],
    python: '/usr/bin/python3',
    budget: budget(),
  });
  const version = /^Python 3\.(\d+)\.\d+$/.exec(definition.executable.version);
  assert.ok(version && Number(version[1]) >= 9);
  assert.notEqual(definition.executable.path, '/usr/bin/python3');
  assert.deepEqual(definition.unittestArgv.slice(0, 5), ['-I', '-E', '-s', '-B', '-c']);
  assert.equal(definition.unittestArgv.at(-2), '--');
  assert.equal(definition.unittestArgv.at(-1), 'tests/test_calculator.py');
  assert.equal(definition.wrapper.version, process.version);

  const baselineRoot = mkdtempSync(join(tmpdir(), 'crewkite-python-baseline-'));
  const candidateRoot = mkdtempSync(join(tmpdir(), 'crewkite-python-candidate-'));
  try {
    materialize(baselineRoot, baseline);
    materialize(candidateRoot, candidate);
    const failed = spawnSync(process.execPath, definition.argv, {
      cwd: baselineRoot,
      encoding: 'buffer',
    });
    const checked = spawnSync(process.execPath, definition.argv, {
      cwd: candidateRoot,
      encoding: 'buffer',
    });
    assert.notEqual(failed.status, 0);
    assert.equal(checked.status, 0);
    const result = evaluatePythonCheck({
      definition,
      source: baseline,
      candidate,
      checkedCandidate: readFiles(candidateRoot),
      exitCode: checked.status,
      output: checked.stdout,
      budget: budget(),
    });
    assert.deepEqual(result, {
      passed: true,
      complete: true,
      tests: 1,
      sourceUnchanged: true,
      candidateUnchanged: true,
    });

    writeFileSync(join(candidateRoot, 'calculator.py'), 'def add(left, right):\n    return 0\n');
    const changed = evaluatePythonCheck({
      definition,
      source: baseline,
      candidate,
      checkedCandidate: readFiles(candidateRoot),
      exitCode: checked.status,
      output: Buffer.concat([checked.stdout, checked.stderr]),
      budget: budget(),
    });
    assert.equal(changed.passed, false);
    assert.equal(changed.candidateUnchanged, false);

    assert.throws(
      () =>
        preparePythonCheck({
          candidateId: definition.candidateId,
          candidateHash: definition.candidateHash,
          source: baseline,
          candidate: [
            candidate[0],
            file(
              'tests/test_calculator.py',
              `${readFileSync(join(baselineRoot, 'tests/test_calculator.py'), 'utf8')}# changed\n`,
            ),
          ],
          criteria: definition.criteria,
          testFiles: definition.required.files,
          python: '/usr/bin/python3',
          budget: budget(),
        }),
      /selected committed Python test changed/,
    );
  } finally {
    rmSync(baselineRoot, { recursive: true, force: true });
    rmSync(candidateRoot, { recursive: true, force: true });
  }
});

test('Python unittest completion cannot be forged by candidate output and early exit', () => {
  const testFile = file(
    'tests/test_calculator.py',
    [
      'import unittest',
      'from calculator import add',
      '',
      'class CalculatorTests(unittest.TestCase):',
      '    def test_adds_two_numbers(self):',
      '        self.assertEqual(add(2, 3), 5)',
      '',
    ].join('\n'),
  );
  const source = [
    file('calculator.py', 'def add(left, right):\n    return left - right\n'),
    testFile,
  ];
  const candidate = [
    file('calculator.py', "print('Ran 1 test in 0.001s\\n\\nOK')\nraise SystemExit(0)\n"),
    testFile,
  ];
  const definition = preparePythonCheck({
    candidateId: 'cnd_01M51M322B2AEBXD9MA74CBCFM',
    candidateHash: 'b'.repeat(64),
    source,
    candidate,
    criteria: ['Adding two numbers returns their sum.'],
    testFiles: ['tests/test_calculator.py'],
    python: '/usr/bin/python3',
    budget: budget(),
  });
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-python-spoof-'));
  try {
    materialize(directory, candidate);
    const checked = spawnSync(process.execPath, definition.argv, {
      cwd: directory,
      encoding: 'buffer',
    });
    assert.equal(checked.status, 1);
    assert.match(checked.stdout.toString(), /Ran 1 test/);
    const outcome = evaluatePythonCheck({
      definition,
      source,
      candidate,
      checkedCandidate: readFiles(directory),
      exitCode: 0,
      output: checked.stdout,
      budget: budget(),
    });
    assert.equal(outcome.complete, false);
    assert.equal(outcome.passed, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Python unittest checks reject a selected path resolved through another module', () => {
  const selected = file(
    'tests/test_selected.py',
    [
      'import unittest',
      '',
      'class SelectedTests(unittest.TestCase):',
      '    def test_selected(self):',
      '        self.assertTrue(True)',
      '',
    ].join('\n'),
  );
  const source = [file('tests.py', ''), selected];
  const definition = preparePythonCheck({
    candidateId: 'cnd_01M51M322B2AEBXD9MA74CBCFM',
    candidateHash: 'c'.repeat(64),
    source,
    candidate: source,
    criteria: ['The selected test file runs.'],
    testFiles: ['tests/test_selected.py'],
    python: '/usr/bin/python3',
    budget: budget(),
  });
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-python-shadow-'));
  try {
    materialize(directory, source);
    const execution = spawnSync(process.execPath, definition.argv, {
      cwd: directory,
      encoding: 'buffer',
    });
    assert.equal(execution.status, 1);
    const outcome = evaluatePythonCheck({
      definition,
      source,
      candidate: source,
      checkedCandidate: readFiles(directory),
      exitCode: execution.status,
      output: execution.stdout,
      budget: budget(),
    });
    assert.equal(outcome.passed, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CandidateEvidence records Python plans and retains evaluator identity failures', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-python-evidence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const testFile = file(
    'tests/test_calculator.py',
    [
      'import unittest',
      'from calculator import add',
      '',
      'class CalculatorTests(unittest.TestCase):',
      '    def test_adds_two_numbers(self):',
      '        self.assertEqual(add(2, 3), 5)',
      '',
    ].join('\n'),
  );
  const source = [
    file('calculator.py', 'def add(left, right):\n    return left - right\n'),
    testFile,
  ];
  const candidateFiles = [
    file('calculator.py', 'def add(left, right):\n    return left + right\n'),
    testFile,
  ];
  const artifacts = new ArtifactFiles(join(directory, 'artifacts'));
  const metadata = new Map<string, Artifact>();
  const id = createTestIds('2026-10-21T00:00:00.000Z', 1n);
  const evidence = new CandidateEvidence({
    home: directory,
    artifacts,
    id,
    getArtifact: (artifactId) => {
      const artifact = metadata.get(artifactId);
      if (!artifact) throw Error('Missing fixture artifact.');
      return artifact;
    },
  });
  const captured = evidence.capture({
    taskId: id('tsk'),
    base: '1'.repeat(40),
    files: candidateFiles,
    existing: [],
  });
  for (const artifact of captured.artifacts) metadata.set(artifact.id, artifact);
  const criteria = ['Adding two numbers returns their sum.'];
  const definition = evidence.describeChecks({
    candidate: captured.candidate,
    sourceFiles: source,
    criteria,
    selection: {
      recipeId: 'project-python-unittest-v1',
      testFiles: ['tests/test_calculator.py'],
    },
  });
  assert.equal(definition.recipeId, 'project-python-unittest-v1');
  const plan = evidence.prepareChecks({
    candidate: captured.candidate,
    sourceFiles: source,
    criteria,
    expected: definition,
  });
  assert.equal(plan.recipeId, 'project-python-unittest-v1');
  if (plan.recipeId !== 'project-python-unittest-v1') throw Error('Expected a Python plan.');
  const execution = spawnSync(process.execPath, plan.argv, {
    cwd: plan.directory,
    encoding: 'buffer',
  });
  assert.equal(execution.status, 0);
  const passed = evidence.recordCheck({
    candidate: captured.candidate,
    plan,
    passed: true,
    output: execution.stdout,
    sourceFiles: source,
  }).evidence;
  assert.equal(passed.passed, true);

  const staleWrapper = { ...plan.wrapper, version: 'v0.0.0' };
  const staleEvaluator = `project-python-unittest-v1:${staleWrapper.version}:${staleWrapper.sha256}:${plan.executable.version}:${plan.executable.sha256}`;
  const {
    directory: planDirectory,
    definitionHash: _definitionHash,
    wrapper: _wrapper,
    evaluator: _evaluator,
    ...saved
  } = plan;
  const staleFields = { ...saved, wrapper: staleWrapper, evaluator: staleEvaluator };
  const stalePlan = {
    ...staleFields,
    definitionHash: hashCanonical(staleFields),
    directory: planDirectory,
  };
  const rejected = evidence.recordCheck({
    candidate: captured.candidate,
    plan: stalePlan,
    passed: true,
    output: execution.stdout,
    sourceFiles: source,
  }).evidence;
  assert.equal(rejected.passed, false);
});
