import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Artifact,
  ArtifactSchema,
  type Candidate,
  CandidateSchema,
  CheckEventSchema,
  type CheckResult,
  CheckResultSchema,
  canonicalJson,
  HashSchema,
  NativeTargetPathSchema,
  type ReadData,
  ReadDataSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { syntheticCheckDefinition } from '@crewkite/testkit/repository';
import { z } from 'zod';
import type { ArtifactFiles } from '../artifacts/index.ts';
import {
  type FileContent,
  type FileEntry,
  git,
  materialize,
  readFiles,
  safePath,
  treeFromFiles,
} from '../host/source.ts';
import type { IdPrefix } from '../store/ids.ts';

type Manifest = { base: string; files: FileEntry[] };
const checkFile = z.strictObject({
  path: NativeTargetPathSchema,
  mode: z.enum(['100644', '100755']),
  hash: HashSchema,
  bytes: z.number().int().nonnegative(),
});
export const NodeCheckDefinitionSchema = z.strictObject({
  recipeId: z.literal('node-tests-v1'),
  argv: z.array(z.string().min(1).max(4096)).min(1).max(1003),
  candidateId: CandidateSchema.shape.id,
  candidateHash: HashSchema,
  definitionHash: HashSchema,
  evaluator: z.string().min(1).max(200),
  criteria: z.array(z.string().min(1).max(4096)).min(1).max(100),
  collection: z.array(checkFile).min(1).max(1000),
  required: z.strictObject({
    path: NativeTargetPathSchema,
    hash: HashSchema,
    tests: z.array(z.string().min(1).max(4096)).min(1).max(1000),
    count: z.number().int().min(1).max(1000),
  }),
  reporterHash: HashSchema,
});
export type NodeCheckDefinition = z.infer<typeof NodeCheckDefinitionSchema>;

export type CheckPlan = {
  directory: string;
  argv: string[];
  candidateId: string;
  candidateHash: string;
  definitionHash: string;
  evaluator: string;
  criteria: string[];
  collection: FileEntry[];
  required: { path: string; hash: string; tests: string[]; count: number };
  reporterHash: string;
};

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PREVIEW = 262144;
const reporterPath = fileURLToPath(new URL('./reporter.ts', import.meta.url));
const digest = (content: Buffer) => createHash('sha256').update(content).digest('hex');
const entry = ({ path, mode, hash, bytes }: FileEntry): FileEntry => ({ path, mode, hash, bytes });

function manifest(base: string, files: readonly FileEntry[]): Manifest {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base) || files.length > 10000)
    throw new Error('Invalid candidate source identity or file count.');
  const seen = new Set<string>();
  const prefixes = new Map<string, string>();
  let bytes = 0;
  const sorted = files
    .map((file) => {
      if (
        typeof file.path !== 'string' ||
        !['100644', '100755'].includes(file.mode) ||
        !/^[a-f0-9]{64}$/.test(file.hash) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0
      )
        throw new Error('Invalid candidate file metadata.');
      safePath(file.path, seen, prefixes);
      bytes += file.bytes;
      if (bytes > MAX_BYTES) throw new Error('Candidate exceeds the source byte limit.');
      return entry(file);
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { base, files: sorted };
}

function verified(base: string, files: readonly FileContent[]): Manifest {
  const result = manifest(base, files);
  for (const file of files)
    if (
      !Buffer.isBuffer(file.content) ||
      file.content.length !== file.bytes ||
      digest(file.content) !== file.hash
    )
      throw new Error('Candidate content does not match its identity.');
  return result;
}

// shortcut: Node test files define the D0 collection. Upgrade: qualified project check definitions.
function isTest(path: string): boolean {
  if (path.split('/').includes('node_modules')) return false;
  return (
    /(?:^|\/)(?:test|tests)\/.*\.(?:[cm]?js|[cm]?ts)$/.test(path) ||
    /(?:^|\/)(?:test|test-[^/]+|[^/]+[._-]test)\.(?:[cm]?js|[cm]?ts)$/.test(path)
  );
}

function evaluator(): string {
  return `node:${process.version}:${digest(readFileSync(process.execPath))}`;
}

function definition(
  plan: Pick<
    CheckPlan,
    'argv' | 'collection' | 'criteria' | 'evaluator' | 'required' | 'reporterHash'
  >,
): string {
  return hashCanonical({
    argv: plan.argv,
    collection: plan.collection,
    criteria: plan.criteria,
    evaluator: plan.evaluator,
    required: plan.required,
    reporterHash: plan.reporterHash,
  });
}

export function completedCheckDefinitionMatches(
  saved: NodeCheckDefinition,
  current: NodeCheckDefinition,
): boolean {
  const historical = NodeCheckDefinitionSchema.safeParse(saved);
  const observed = NodeCheckDefinitionSchema.safeParse(current);
  if (!historical.success || !observed.success) return false;
  const previous = historical.data;
  const present = observed.data;
  for (const value of [previous, present]) {
    const reporter = value.argv[1] ?? '';
    if (
      definition(value) !== value.definitionHash ||
      value.argv.length !== value.collection.length + 3 ||
      value.argv[0] !== '--test' ||
      !reporter.startsWith('--test-reporter=') ||
      !isAbsolute(reporter.slice('--test-reporter='.length)) ||
      value.argv[2] !== '--' ||
      value.collection.some((file, index) => value.argv[index + 3] !== `./${file.path}`)
    )
      return false;
  }
  if (present.argv[1] !== `--test-reporter=${reporterPath}`) return false;
  // Completed evidence survives moving identical runtime files. Saved argv is never executed here.
  return (
    hashCanonical({
      ...previous,
      argv: previous.argv.map((argument, index) => (index === 1 ? present.argv[1] : argument)),
      definitionHash: present.definitionHash,
    }) === hashCanonical(present)
  );
}

function report(
  output: Buffer,
  required: CheckPlan['required'],
): { complete: boolean; tests: number } {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(output);
  const rows = text
    .trimEnd()
    .split('\n')
    .map((line) => CheckEventSchema.parse(JSON.parse(line)));
  const first = rows[0];
  if (
    !text.endsWith('\n') ||
    first?.type !== 'start' ||
    first.version !== 1 ||
    rows.at(-1)?.type !== 'end'
  )
    return { complete: false, tests: 0 };
  if (
    rows.filter((row) => row.type === 'start').length !== 1 ||
    rows.filter((row) => row.type === 'end').length !== 1
  )
    return { complete: false, tests: 0 };
  const summaries = rows.filter((row) => row.type === 'summary' && row.file === null);
  const summary = summaries[0];
  if (summaries.length !== 1 || summary.type !== 'summary') return { complete: false, tests: 0 };
  const counts = summary.counts;
  const tests = rows.filter((row) => row.type === 'test');
  const complete =
    summary.success === true &&
    Number.isSafeInteger(counts.tests) &&
    counts.tests >= required.count &&
    counts.passed === counts.tests &&
    ['failed', 'cancelled', 'skipped', 'todo'].every(
      (name) => counts[name as keyof typeof counts] === 0,
    ) &&
    tests.length === counts.tests + counts.suites &&
    tests.every((test) => test.passed === true && test.skipped === false && test.todo === false) &&
    required.tests.every(
      (name) =>
        tests.filter(
          (test) => test.file === required.path && test.kind === 'test' && test.name === name,
        ).length === 1,
    );
  return { complete, tests: counts.tests };
}

export class CandidateEvidence {
  private readonly home: string;
  private readonly artifacts: ArtifactFiles;
  private readonly id: (prefix: IdPrefix) => string;
  private readonly getArtifact: (id: string) => Artifact;

  constructor(options: {
    home: string;
    artifacts: ArtifactFiles;
    id: (prefix: IdPrefix) => string;
    getArtifact: (id: string) => Artifact;
  }) {
    this.home = join(options.home, 'evidence');
    this.artifacts = options.artifacts;
    this.id = options.id;
    this.getArtifact = options.getArtifact;
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const state = lstatSync(this.home);
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new Error('Evidence needs an independent directory.');
  }

  private publish(content: Buffer, mediaType: string): Artifact {
    const stored = this.artifacts.publish(content);
    return ArtifactSchema.parse({ id: this.id('art'), ...stored, mediaType });
  }

  hash(base: string, files: readonly FileContent[]): string {
    return hashCanonical(verified(base, files));
  }

  capture(input: { taskId: string; base: string; files: FileContent[]; existing: Candidate[] }): {
    candidate: Candidate;
    artifacts: Artifact[];
  } {
    const sealed = verified(input.base, input.files);
    const hash = hashCanonical(sealed);
    const previous = input.existing.find(
      (candidate) => candidate.taskId === input.taskId && candidate.hash === hash,
    );
    if (previous) {
      this.read(previous);
      return { candidate: previous, artifacts: [] };
    }
    const artifacts = input.files.map((file) =>
      this.publish(file.content, 'application/octet-stream'),
    );
    const artifact = this.publish(
      Buffer.from(canonicalJson(sealed)),
      'application/vnd.crewkite.candidate+json',
    );
    artifacts.push(artifact);
    const candidate = CandidateSchema.parse({
      id: this.id('cnd'),
      taskId: input.taskId,
      hash,
      artifactId: artifact.id,
      revision: 0,
    });
    return { candidate, artifacts };
  }

  read(candidate: Candidate): { base: string; files: FileContent[] } {
    CandidateSchema.parse(candidate);
    const artifact = ArtifactSchema.parse(this.getArtifact(candidate.artifactId));
    if (
      artifact.id !== candidate.artifactId ||
      artifact.hash !== candidate.hash ||
      artifact.bytes > MAX_BYTES
    )
      throw new Error('Candidate manifest reference changed.');
    const bytes = this.artifacts.read(artifact.hash);
    if (bytes.length !== artifact.bytes) throw new Error('Candidate manifest size changed.');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid candidate manifest.');
    const raw = value as Manifest;
    if (typeof raw.base !== 'string' || !Array.isArray(raw.files))
      throw new Error('Invalid candidate manifest.');
    const sealed = manifest(raw.base, raw.files);
    if (hashCanonical(sealed) !== candidate.hash)
      throw new Error('Candidate manifest identity changed.');
    const files = sealed.files.map((file) => {
      const content = this.artifacts.read(file.hash);
      if (content.length !== file.bytes) throw new Error('Candidate content size changed.');
      return { ...file, content };
    });
    return { base: sealed.base, files };
  }

  changes(input: {
    taskId: string;
    candidateId: string | null;
    base: string;
    sourceFiles: FileContent[];
    files: FileContent[];
  }): {
    data: Extract<ReadData, { kind: 'changes' }>;
    artifacts: Artifact[];
    repository: string;
    treeOid: string;
    baseTreeOid: string;
  } {
    verified(input.base, input.sourceFiles);
    verified(input.base, input.files);
    const repository = mkdtempSync(join(this.home, 'diff-'));
    const baseTreeOid = treeFromFiles(repository, input.sourceFiles);
    const treeOid = treeFromFiles(repository, input.files);
    const patch = git(repository, [
      'diff',
      '--binary',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      baseTreeOid,
      treeOid,
      '--',
    ]);
    const artifact = this.publish(patch, 'text/x-patch');
    const before = new Map(input.sourceFiles.map((file) => [file.path, file]));
    const after = new Map(input.files.map((file) => [file.path, file]));
    const stats = git(repository, [
      'diff',
      '--numstat',
      '-z',
      '--no-renames',
      baseTreeOid,
      treeOid,
      '--',
    ])
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    if (stats.length > 1000) throw new Error('Changes exceed the bounded file list.');
    const files = stats.map((record) => {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record);
      if (!match) throw new Error('Invalid change statistics.');
      const [, added, deleted, path] = match;
      return {
        path,
        status: !before.has(path) ? 'added' : !after.has(path) ? 'deleted' : 'modified',
        binary: added === '-',
        oversized:
          Math.max(before.get(path)?.bytes ?? 0, after.get(path)?.bytes ?? 0) > MAX_PREVIEW,
        additions: added === '-' ? 0 : Number(added),
        deletions: deleted === '-' ? 0 : Number(deleted),
      };
    });
    const full = patch.toString('utf8');
    const data = ReadDataSchema.parse({
      kind: 'changes',
      taskId: input.taskId,
      candidateId: input.candidateId,
      artifactId: artifact.id,
      files,
      diff: full.slice(0, MAX_PREVIEW),
      truncated: full.length > MAX_PREVIEW,
    });
    if (data.kind !== 'changes') throw new Error('Invalid changes result.');
    return { data, artifacts: [artifact], repository, treeOid, baseTreeOid };
  }

  describeChecks(input: {
    candidate: Candidate;
    sourceFiles: FileContent[];
    criteria: string[];
  }): NodeCheckDefinition {
    const { base, files } = this.read(input.candidate);
    verified(base, input.sourceFiles);
    const originals = input.sourceFiles.filter((file) => isTest(file.path));
    // shortcut: only the synthetic check definition is qualified. Upgrade: project definitions.
    if (
      originals.length !== 1 ||
      originals[0].path !== syntheticCheckDefinition.path ||
      originals[0].hash !== syntheticCheckDefinition.hash
    )
      throw new Error('The original check definition is unqualified in D0.');
    const byPath = new Map(files.map((file) => [file.path, file]));
    // A smaller or rewritten baseline could make an unchanged defect disappear from checks.
    for (const original of originals) {
      const current = byPath.get(original.path);
      if (!current || canonicalJson(entry(current)) !== canonicalJson(entry(original)))
        throw new Error('The original test collection or content changed.');
    }
    const collection = files.filter((file) => isTest(file.path)).map(entry);
    if (collection.length === 0) throw new Error('No required Node tests were collected.');
    const fields = {
      argv: [
        '--test',
        `--test-reporter=${reporterPath}`,
        '--',
        ...collection.map((file) => `./${file.path}`),
      ],
      collection,
      criteria: [...input.criteria],
      evaluator: evaluator(),
      required: {
        path: syntheticCheckDefinition.path,
        hash: syntheticCheckDefinition.hash,
        tests: [...syntheticCheckDefinition.requiredTests],
        count: syntheticCheckDefinition.requiredTests.length,
      },
      reporterHash: digest(readFileSync(reporterPath)),
    };
    return NodeCheckDefinitionSchema.parse({
      recipeId: 'node-tests-v1',
      candidateId: input.candidate.id,
      candidateHash: input.candidate.hash,
      ...fields,
      definitionHash: definition(fields),
    });
  }

  prepareChecks(input: {
    candidate: Candidate;
    sourceFiles: FileContent[];
    criteria: string[];
    expected?: NodeCheckDefinition;
  }): CheckPlan {
    const current = this.describeChecks(input);
    if (input.expected && hashCanonical(current) !== hashCanonical(input.expected))
      throw new Error('The frozen check definition changed.');
    const directory = mkdtempSync(join(this.home, 'check-'));
    materialize(directory, this.read(input.candidate).files);
    return { ...current, directory };
  }

  recordCheck(input: { candidate: Candidate; plan: CheckPlan; passed: boolean; output: Buffer }): {
    evidence: CheckResult;
    artifacts: Artifact[];
  } {
    const { candidate, plan } = input;
    if (
      plan.candidateId !== candidate.id ||
      plan.candidateHash !== candidate.hash ||
      definition(plan) !== plan.definitionHash
    )
      throw new Error('Check plan does not bind this candidate and definition.');
    const { base } = this.read(candidate);
    let unchanged = false;
    let complete = false;
    let tests = 0;
    try {
      // Exit zero cannot bless a test that rewrites the code it just evaluated.
      unchanged =
        this.hash(base, readFiles(plan.directory)) === candidate.hash &&
        evaluator() === plan.evaluator &&
        digest(readFileSync(reporterPath)) === plan.reporterHash;
      // Node can pass a file that exits during import without running its original tests.
      ({ complete, tests } = report(input.output, plan.required));
    } catch {
      // An unreadable copy or incomplete report cannot establish a passing check.
    }
    const passed = input.passed && unchanged && complete;
    const log = this.publish(input.output, 'text/plain');
    const metadata = this.publish(
      Buffer.from(
        canonicalJson({
          candidateId: candidate.id,
          candidateHash: candidate.hash,
          definitionHash: plan.definitionHash,
          evaluator: plan.evaluator,
          passed,
          unchanged,
          complete,
          tests,
          log,
        }),
      ),
      'application/vnd.crewkite.check+json',
    );
    const evidence = CheckResultSchema.parse({
      candidateId: candidate.id,
      candidateHash: candidate.hash,
      definitionHash: plan.definitionHash,
      evaluator: plan.evaluator,
      passed,
      artifactId: metadata.id,
    });
    return { evidence, artifacts: [log, metadata] };
  }
}
