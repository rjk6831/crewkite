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
  CombinedCheckContextSchema,
  canonicalJson,
  HashSchema,
  NativeTargetPathSchema,
  ProjectNodeTestFilesSchema,
  type ReadData,
  ReadDataSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { syntheticCheckDefinition } from '@crewkite/testkit/repository';
import { z } from 'zod';
import type { ArtifactFiles } from '../artifacts/index.ts';
import { type CheckOwner, parseCheckOwner, qualifiedWorkerExit } from '../host/check-ownership.ts';
import {
  type FileContent,
  type FileEntry,
  git,
  materialize,
  readFiles,
  safePath,
  treeFromFiles,
} from '../host/source.ts';
import { groupAbsent } from '../host/worker.ts';
import type { IdPrefix } from '../store/ids.ts';
import {
  type ToolchainDefinition,
  ToolchainDefinitionSchema,
  validToolchainDefinition,
  verificationStages,
} from './toolchain-definition.ts';
import { type VerificationExecution, verificationCommand } from './toolchain-verify.ts';

type Manifest = { base: string; files: FileEntry[] };
const checkFile = z.strictObject({
  path: NativeTargetPathSchema,
  mode: z.enum(['100644', '100755']),
  hash: HashSchema,
  bytes: z.number().int().nonnegative(),
});
const syntheticNodeCheckDefinition = z.strictObject({
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
  combined: CombinedCheckContextSchema.optional(),
});
export const NodeCheckDefinitionSchema = z.discriminatedUnion('recipeId', [
  syntheticNodeCheckDefinition,
  syntheticNodeCheckDefinition.extend({
    recipeId: z.literal('project-node-tests-v1'),
    collection: z.array(checkFile).min(1).max(32),
    required: z.strictObject({ files: ProjectNodeTestFilesSchema }),
    guardHash: HashSchema,
  }),
]);
export type NodeCheckDefinition = z.infer<typeof NodeCheckDefinitionSchema>;
export const CheckDefinitionSchema = z.union([
  NodeCheckDefinitionSchema,
  ToolchainDefinitionSchema,
]);
export type CheckDefinition = z.infer<typeof CheckDefinitionSchema>;
export type CheckPlan = NodeCheckDefinition & { directory: string };
export type NodeCheckSelection =
  | { recipeId: 'node-tests-v1' }
  | { recipeId: 'project-node-tests-v1'; testFiles: string[] };

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PREVIEW = 262144;
const reporterPath = fileURLToPath(new URL('./reporter.ts', import.meta.url));
const guardPath = fileURLToPath(new URL('./import-guard.ts', import.meta.url));
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
  > & { guardHash?: string; combined?: z.infer<typeof CombinedCheckContextSchema> },
): string {
  return hashCanonical({
    argv: plan.argv,
    collection: plan.collection,
    criteria: plan.criteria,
    evaluator: plan.evaluator,
    required: plan.required,
    reporterHash: plan.reporterHash,
    ...(plan.guardHash ? { guardHash: plan.guardHash } : {}),
    ...(plan.combined ? { combined: plan.combined } : {}),
  });
}

export function completedCheckDefinitionMatches(
  saved: CheckDefinition,
  current: CheckDefinition,
): boolean {
  if (saved.recipeId === 'crewkite-verify-v1' || current.recipeId === 'crewkite-verify-v1')
    return (
      saved.recipeId === current.recipeId &&
      validToolchainDefinition(saved) &&
      validToolchainDefinition(current) &&
      hashCanonical(saved) === hashCanonical(current)
    );
  const historical = NodeCheckDefinitionSchema.safeParse(saved);
  const observed = NodeCheckDefinitionSchema.safeParse(current);
  if (!historical.success || !observed.success) return false;
  const previous = historical.data;
  const present = observed.data;
  if (previous.recipeId !== present.recipeId) return false;
  const project = present.recipeId === 'project-node-tests-v1';
  const reporterIndex = project ? 2 : 1;
  const start = project ? 4 : 3;
  for (const value of [previous, present]) {
    const reporter = value.argv[reporterIndex] ?? '';
    if (
      definition(value) !== value.definitionHash ||
      value.argv.length !== value.collection.length + start ||
      value.argv[project ? 1 : 0] !== '--test' ||
      !reporter.startsWith('--test-reporter=') ||
      !isAbsolute(reporter.slice('--test-reporter='.length)) ||
      value.argv[start - 1] !== '--' ||
      value.collection.some((file, index) => value.argv[index + start] !== `./${file.path}`) ||
      (value.recipeId === 'project-node-tests-v1' &&
        (!value.argv[0].startsWith('--import=') ||
          !isAbsolute(value.argv[0].slice('--import='.length)) ||
          hashCanonical(value.required.files) !==
            hashCanonical(value.collection.map((file) => file.path))))
    )
      return false;
  }
  if (
    present.argv[reporterIndex] !== `--test-reporter=${reporterPath}` ||
    (project && present.argv[0] !== `--import=${guardPath}`)
  )
    return false;
  // Completed evidence survives moving identical runtime files. Saved argv is never executed here.
  return (
    hashCanonical({
      ...previous,
      argv: previous.argv.map((argument, index) =>
        index === reporterIndex || (project && index === 0) ? present.argv[index] : argument,
      ),
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
  const fileCountsPass = (row: typeof summary) =>
    row.success &&
    row.counts.tests > 0 &&
    row.counts.passed === row.counts.tests &&
    row.counts.failed === 0 &&
    row.counts.cancelled === 0 &&
    row.counts.skipped === 0 &&
    row.counts.todo === 0;
  const requiredComplete =
    'files' in required
      ? required.files.every((path) => {
          const files = rows.filter((row) => row.type === 'summary' && row.file === path);
          return files.length === 1 && files[0].type === 'summary' && fileCountsPass(files[0]);
        })
      : required.tests.every(
          (name) =>
            tests.filter(
              (test) => test.file === required.path && test.kind === 'test' && test.name === name,
            ).length === 1,
        );
  const complete =
    summary.success === true &&
    Number.isSafeInteger(counts.tests) &&
    counts.tests >= ('files' in required ? required.files.length : required.count) &&
    counts.passed === counts.tests &&
    ['failed', 'cancelled', 'skipped', 'todo'].every(
      (name) => counts[name as keyof typeof counts] === 0,
    ) &&
    tests.length === counts.tests + counts.suites &&
    tests.every((test) => test.passed === true && test.skipped === false && test.todo === false) &&
    requiredComplete;
  return { complete, tests: counts.tests };
}

const positiveInteger = z.number().int().positive();
const signal = z.custom<NodeJS.Signals>(
  (value) => typeof value === 'string' && /^SIG[A-Z0-9]+$/.test(value),
);
const checkOwner = z.custom<CheckOwner>((value) => {
  try {
    parseCheckOwner(value);
    return true;
  } catch {
    return false;
  }
});
const verificationRoot = z
  .strictObject({
    id: z.string().regex(/^[a-f0-9-]{36}\.jsonl$/),
    intent: z.strictObject({
      type: z.literal('intent'),
      owner: checkOwner,
      role: z.enum(['stage', 'fixture', 'worker', 'check', 'controller', 'electron', 'watcher']),
      detached: z.boolean(),
      witness: z.literal('scripted-coder-v1').optional(),
    }),
    acknowledgment: z
      .strictObject({ type: z.literal('ack'), pid: positiveInteger, group: positiveInteger })
      .optional(),
    terminal: z
      .strictObject({
        type: z.literal('close'),
        code: z.number().int().nullable(),
        signal: signal.nullable(),
      })
      .optional(),
    exitEvent: z
      .strictObject({
        type: z.literal('fixture-exit'),
        pid: positiveInteger,
        code: z.number().int().nonnegative(),
      })
      .optional(),
    spawnFailed: z.boolean(),
  })
  .refine(
    (root) =>
      (!root.exitEvent || qualifiedWorkerExit(root)) &&
      (!root.intent.witness ||
        (root.intent.role === 'worker' &&
          root.intent.detached &&
          ['node-tests', 'desktop'].includes(root.intent.owner.stage))),
    'Worker exit witness is not bound to its launch.',
  )
  .refine(
    (root) => root.spawnFailed || (root.terminal?.code ?? 0) >= 0,
    'Only a failed spawn may report a negative terminal code.',
  );
const treeMode = z.number().int().min(0).max(0o7777);
const buildInventory = z.strictObject({
  version: z.literal(1),
  entries: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({
          path: NativeTargetPathSchema,
          kind: z.literal('file'),
          mode: treeMode,
          bytes: z
            .number()
            .int()
            .nonnegative()
            .max(8 * 1024 ** 3),
          hash: HashSchema,
        }),
        z.strictObject({
          path: z.union([z.literal('.'), NativeTargetPathSchema]),
          kind: z.literal('directory'),
          mode: treeMode,
        }),
      ]),
    )
    .min(1)
    .max(500000),
  files: z.number().int().nonnegative(),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(8 * 1024 ** 3),
  hash: HashSchema,
});
const verificationExecution = z.strictObject({
  version: z.literal(1),
  attemptId: z.string().min(1).max(200),
  generation: z.number().int().nonnegative(),
  definitionHash: HashSchema,
  stages: z
    .array(
      z.strictObject({
        stage: z.enum(verificationStages),
        commandHash: HashSchema,
        code: z.number().int().nonnegative().nullable(),
        signal: signal.nullable(),
        closed: z.boolean(),
        stdout: z.string().max(24 * 1024 * 1024),
        stderr: z.string().max(24 * 1024 * 1024),
      }),
    )
    .max(6),
  roots: z.array(verificationRoot).max(4096),
  quiescent: z.boolean(),
  unchanged: z.boolean(),
  build: buildInventory.nullable(),
  failure: z.enum(['cancelled', 'deadline', 'identity', 'stage', 'ownership']).nullable(),
});
const verificationMetadata = z.strictObject({
  candidateId: CandidateSchema.shape.id,
  candidateHash: HashSchema,
  definitionHash: HashSchema,
  evaluator: z.string().min(1).max(200),
  passed: z.boolean(),
  unchanged: z.boolean(),
  complete: z.boolean(),
  tests: z.number().int().nonnegative(),
  log: ArtifactSchema,
  verification: z.strictObject({ artifact: ArtifactSchema, owner: checkOwner }),
});

function verificationReport(
  definition: ToolchainDefinition,
  execution: z.infer<typeof verificationExecution>,
  owner: CheckOwner,
  fresh: boolean,
): { complete: boolean; tests: number } {
  if (
    !validToolchainDefinition(definition) ||
    execution.attemptId !== owner.attemptId ||
    execution.generation !== owner.generation ||
    execution.definitionHash !== definition.definitionHash ||
    execution.failure !== null ||
    !execution.unchanged ||
    !execution.quiescent ||
    execution.stages.length !== verificationStages.length ||
    !execution.build
  )
    return { complete: false, tests: 0 };
  const groups = new Set(
    execution.roots
      .filter((root) => root.intent.detached && root.acknowledgment)
      .map((root) => root.acknowledgment?.group),
  );
  if (
    new Set(execution.roots.map((root) => root.id)).size !== execution.roots.length ||
    execution.roots.some((root) => {
      const context = root.intent.owner;
      const ack = root.acknowledgment;
      return (
        context.attemptId !== owner.attemptId ||
        context.generation !== owner.generation ||
        context.directory !== owner.directory ||
        context.stateRoot !== owner.stateRoot ||
        context.electronExecutable !== owner.electronExecutable ||
        (root.spawnFailed
          ? !!ack || root.intent.role === 'stage'
          : !ack ||
            (!root.terminal && !qualifiedWorkerExit(root)) ||
            (!!root.terminal && root.terminal.code === null && root.terminal.signal === null)) ||
        (!!ack &&
          (ack.group !== (root.intent.detached ? ack.pid : context.parentGroup) ||
            (!root.intent.detached && !groups.has(ack.group)) ||
            (fresh && !groupAbsent(ack.group))))
      );
    })
  )
    return { complete: false, tests: 0 };
  let bytes = 0;
  let tests = 0;
  for (const [index, stage] of execution.stages.entries()) {
    const roots = execution.roots.filter(
      (root) => root.intent.role === 'stage' && root.intent.owner.stage === stage.stage,
    );
    if (
      stage.stage !== verificationStages[index] ||
      stage.commandHash !== hashCanonical(verificationCommand(definition, stage.stage)) ||
      stage.code !== 0 ||
      stage.signal !== null ||
      !stage.closed ||
      roots.length !== 1 ||
      !roots[0].intent.detached ||
      roots[0].terminal?.code !== 0 ||
      roots[0].terminal.signal !== null
    )
      return { complete: false, tests: 0 };
    const outputs = [stage.stdout, stage.stderr].map((text) => {
      const value = Buffer.from(text, 'base64');
      if (value.toString('base64') !== text) throw Error('Verification output encoding changed.');
      bytes += value.length;
      return value;
    });
    if (bytes > 16 * 1024 * 1024) return { complete: false, tests: 0 };
    if (stage.stage !== 'node-tests' && stage.stage !== 'desktop') continue;
    const collection =
      stage.stage === 'node-tests'
        ? definition.collection.map((file) => ({ path: file.path, tests: file.tests }))
        : [{ path: definition.journey.file, tests: [definition.journey.title] }];
    const result = report(outputs[0], { files: collection.map((file) => file.path) });
    const frames = outputs[0]
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => CheckEventSchema.parse(JSON.parse(line)));
    const rows = frames.filter((row) => row.type === 'test');
    const summaries = frames.filter((row) => row.type === 'summary' && row.file !== null);
    const required = collection.flatMap((file) =>
      file.tests.map((name) => ({ path: file.path, name })),
    );
    if (
      !result.complete ||
      result.tests !== required.length ||
      rows.length !== required.length ||
      summaries.length !== collection.length ||
      (stage.stage === 'desktop' &&
        (frames.length !== 5 ||
          frames[1].type !== 'test' ||
          frames[2].type !== 'summary' ||
          frames[2].file !== definition.journey.file ||
          frames[3].type !== 'summary' ||
          frames[3].file !== null)) ||
      required.some(
        (test) =>
          rows.filter(
            (row) => row.kind === 'test' && row.file === test.path && row.name === test.name,
          ).length !== 1,
      )
    )
      return { complete: false, tests: 0 };
    tests += result.tests;
  }
  const build = execution.build;
  const files = build.entries.filter((entry) => entry.kind === 'file');
  const hash = createHash('sha256');
  for (const row of [{ version: 1, files: build.files, bytes: build.bytes }, ...build.entries])
    hash.update(`${JSON.stringify(row)}\n`);
  if (
    build.entries[0].path !== '.' ||
    build.entries[0].kind !== 'directory' ||
    build.entries.some((entry, index, all) => index > 0 && all[index - 1].path >= entry.path) ||
    build.files !== files.length ||
    build.bytes !== files.reduce((sum, file) => sum + file.bytes, 0) ||
    hash.digest('hex') !== build.hash ||
    ['main/index.js', 'preload/index.cjs', 'renderer/index.html'].some(
      (path) => !files.some((file) => file.path === path && file.bytes > 0),
    )
  )
    return { complete: false, tests: 0 };
  return { complete: true, tests };
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
    selection?: NodeCheckSelection;
    combined?: z.infer<typeof CombinedCheckContextSchema>;
  }): NodeCheckDefinition {
    const { base, files } = this.read(input.candidate);
    verified(base, input.sourceFiles);
    if (input.selection?.recipeId === 'project-node-tests-v1') {
      const paths = ProjectNodeTestFilesSchema.parse(input.selection.testFiles).sort();
      const collection = paths.map((path) => {
        const original = input.sourceFiles.find((file) => file.path === path);
        const selected = files.find((file) => file.path === path);
        if (
          !original ||
          !selected ||
          canonicalJson(entry(original)) !== canonicalJson(entry(selected))
        )
          throw Error('A selected committed Node test changed.');
        return entry(original);
      });
      const fields = {
        ...(input.combined ? { combined: CombinedCheckContextSchema.parse(input.combined) } : {}),
        argv: [
          `--import=${guardPath}`,
          '--test',
          `--test-reporter=${reporterPath}`,
          '--',
          ...paths.map((path) => `./${path}`),
        ],
        collection,
        criteria: [...input.criteria],
        evaluator: evaluator(),
        required: { files: paths },
        reporterHash: digest(readFileSync(reporterPath)),
        guardHash: digest(readFileSync(guardPath)),
      };
      return NodeCheckDefinitionSchema.parse({
        recipeId: 'project-node-tests-v1',
        candidateId: input.candidate.id,
        candidateHash: input.candidate.hash,
        ...fields,
        definitionHash: definition(fields),
      });
    }
    const originals = input.sourceFiles.filter((file) => isTest(file.path));
    // The default recipe preserves the original synthetic assertion contract.
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
      ...(input.combined ? { combined: CombinedCheckContextSchema.parse(input.combined) } : {}),
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
    const current = this.describeChecks({
      ...input,
      ...(input.expected?.combined ? { combined: input.expected.combined } : {}),
      selection:
        input.expected?.recipeId === 'project-node-tests-v1'
          ? { recipeId: input.expected.recipeId, testFiles: input.expected.required.files }
          : undefined,
    });
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
        digest(readFileSync(reporterPath)) === plan.reporterHash &&
        (plan.recipeId !== 'project-node-tests-v1' ||
          digest(readFileSync(guardPath)) === plan.guardHash);
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
          ...(plan.combined ? { combined: plan.combined } : {}),
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

  private verificationInventory(definition: ToolchainDefinition): boolean {
    const content = this.artifacts.read(definition.inventory.hash);
    const saved = z
      .object({ version: z.literal(1), hash: HashSchema })
      .parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)));
    return content.length === definition.inventory.bytes && saved.hash === definition.toolchainHash;
  }

  recordVerification(input: {
    candidate: Candidate;
    definition: ToolchainDefinition;
    execution: VerificationExecution;
    owner: CheckOwner;
  }): { evidence: CheckResult; artifacts: Artifact[] } {
    const { candidate, definition } = input;
    const owner = parseCheckOwner(input.owner);
    this.read(candidate);
    if (
      !validToolchainDefinition(definition) ||
      definition.candidateId !== candidate.id ||
      definition.candidateHash !== candidate.hash
    )
      throw Error('Verification does not bind the candidate and definition.');
    const execution = verificationExecution.parse(input.execution);
    const proofBytes = Buffer.from(canonicalJson(execution));
    if (proofBytes.length > MAX_BYTES)
      throw Error('Verification proof exceeds its artifact bound.');
    let unchanged = false;
    let complete = false;
    let tests = 0;
    try {
      unchanged = execution.unchanged && this.verificationInventory(definition);
      ({ complete, tests } = verificationReport(definition, execution, owner, true));
    } catch {
      // Missing records and unreadable artifacts leave a failed check for inspection.
    }
    const passed = unchanged && complete;
    const proof = this.publish(proofBytes, 'application/vnd.crewkite.verification+json');
    const log = this.publish(
      Buffer.from(
        canonicalJson(
          execution.stages.map(({ stage, code, signal, closed }) => ({
            stage,
            code,
            signal,
            closed,
          })),
        ),
      ),
      'text/plain',
    );
    const metadata = this.publish(
      Buffer.from(
        canonicalJson({
          candidateId: candidate.id,
          candidateHash: candidate.hash,
          definitionHash: definition.definitionHash,
          evaluator: definition.evaluator,
          passed,
          unchanged,
          complete,
          tests,
          log,
          verification: { artifact: proof, owner },
        }),
      ),
      'application/vnd.crewkite.check+json',
    );
    const evidence = CheckResultSchema.parse({
      candidateId: candidate.id,
      candidateHash: candidate.hash,
      definitionHash: definition.definitionHash,
      evaluator: definition.evaluator,
      passed,
      artifactId: metadata.id,
    });
    return { evidence, artifacts: [log, proof, metadata] };
  }

  verificationMatches(input: {
    candidate: Candidate;
    definition: ToolchainDefinition;
    metadata: unknown;
    owner: CheckOwner;
  }): boolean {
    try {
      const { candidate, definition } = input;
      const owner = parseCheckOwner(input.owner);
      const metadata = verificationMetadata.parse(input.metadata);
      if (
        !validToolchainDefinition(definition) ||
        candidate.id !== definition.candidateId ||
        candidate.hash !== definition.candidateHash ||
        metadata.candidateId !== candidate.id ||
        metadata.candidateHash !== candidate.hash ||
        metadata.definitionHash !== definition.definitionHash ||
        metadata.evaluator !== definition.evaluator ||
        !metadata.passed ||
        !metadata.complete ||
        !metadata.unchanged ||
        hashCanonical(metadata.verification.owner) !== hashCanonical(owner) ||
        !this.verificationInventory(definition)
      )
        return false;
      this.read(candidate);
      const read = (reference: Artifact) => {
        if (
          hashCanonical(ArtifactSchema.parse(this.getArtifact(reference.id))) !==
          hashCanonical(reference)
        )
          throw Error('Verification artifact reference changed.');
        const bytes = this.artifacts.read(reference.hash);
        if (bytes.length !== reference.bytes) throw Error('Verification artifact size changed.');
        return bytes;
      };
      read(metadata.log);
      const execution = verificationExecution.parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(read(metadata.verification.artifact)),
        ),
      );
      // Saved process identities describe completed work. Reopening never probes reused PIDs.
      const result = verificationReport(definition, execution, owner, false);
      return result.complete && result.tests === metadata.tests;
    } catch {
      return false;
    }
  }
}
