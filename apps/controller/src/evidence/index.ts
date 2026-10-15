import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Artifact,
  ArtifactSchema,
  type Candidate,
  CandidateSchema,
  type CheckResult,
  CheckResultSchema,
  canonicalJson,
  type ReadData,
  ReadDataSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
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
export type CheckPlan = {
  directory: string;
  argv: string[];
  candidateId: string;
  candidateHash: string;
  definitionHash: string;
  evaluator: string;
  criteria: string[];
  collection: FileEntry[];
};

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PREVIEW = 262144;
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
  plan: Pick<CheckPlan, 'argv' | 'collection' | 'criteria' | 'evaluator'>,
): string {
  return hashCanonical({
    argv: plan.argv,
    collection: plan.collection,
    criteria: plan.criteria,
    evaluator: plan.evaluator,
  });
}

function report(output: Buffer): { complete: boolean; tests: number } {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(output);
  const lines = text.trimEnd().split(/\r?\n/);
  const names = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const;
  const counts = Object.fromEntries(
    names.map((name) => {
      const matches = lines.filter((line) => new RegExp(`^# ${name} [0-9]+$`).test(line));
      return [name, matches.length === 1 ? Number(matches[0].split(' ')[2]) : -1];
    }),
  ) as Record<(typeof names)[number], number>;
  const plans = lines.filter((line) => /^1\.\.[0-9]+$/.test(line));
  const results = lines.filter((line) => /^(?:not )?ok [0-9]+(?: |$)/.test(line));
  const tail = lines.slice(lines.findIndex((line) => /^# tests [0-9]+$/.test(line)));
  const complete =
    text.endsWith('\n') &&
    lines[0] === 'TAP version 13' &&
    plans.length === 1 &&
    Number(plans[0].slice(3)) > 0 &&
    results.length === Number(plans[0].slice(3)) &&
    results.every((line, index) => line.startsWith(`ok ${index + 1} `)) &&
    !lines.some((line) => /^\s*(?:not ok [0-9]+|Bail out!)/.test(line)) &&
    counts.tests > 0 &&
    counts.pass === counts.tests &&
    names.every((name) => Number.isSafeInteger(counts[name])) &&
    ['fail', 'cancelled', 'skipped', 'todo'].every(
      (name) => counts[name as (typeof names)[number]] === 0,
    ) &&
    tail.length === 8 &&
    /^# suites [0-9]+$/.test(tail[1]) &&
    ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].every((name, index) =>
      new RegExp(`^# ${name} [0-9]+$`).test(tail[index]),
    ) &&
    /^# duration_ms [0-9.]+$/.test(tail[7]);
  return { complete, tests: Math.max(0, counts.tests) };
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

  prepareChecks(input: {
    candidate: Candidate;
    sourceFiles: FileContent[];
    criteria: string[];
  }): CheckPlan {
    const { base, files } = this.read(input.candidate);
    verified(base, input.sourceFiles);
    const byPath = new Map(files.map((file) => [file.path, file]));
    // A smaller or rewritten baseline could make an unchanged defect disappear from checks.
    for (const original of input.sourceFiles.filter((file) => isTest(file.path))) {
      const current = byPath.get(original.path);
      if (!current || canonicalJson(entry(current)) !== canonicalJson(entry(original)))
        throw new Error('The original test collection or content changed.');
    }
    const collection = files.filter((file) => isTest(file.path)).map(entry);
    if (collection.length === 0) throw new Error('No required Node tests were collected.');
    const directory = mkdtempSync(join(this.home, 'check-'));
    materialize(directory, files);
    const fields = {
      argv: ['--test', '--test-reporter=tap', '--', ...collection.map((file) => `./${file.path}`)],
      collection,
      criteria: [...input.criteria],
      evaluator: evaluator(),
    };
    return {
      directory,
      candidateId: input.candidate.id,
      candidateHash: input.candidate.hash,
      ...fields,
      definitionHash: definition(fields),
    };
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
        evaluator() === plan.evaluator;
      ({ complete, tests } = report(input.output));
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
