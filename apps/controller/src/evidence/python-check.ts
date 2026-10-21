import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  CandidateSchema,
  canonicalJson,
  HashSchema,
  NativeTargetPathSchema,
  ProjectPythonTestFilesSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { z } from 'zod';
import type { FileContent } from '../host/source.ts';
import type { CopyBudget } from '../host/toolchain.ts';

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_FILES = 10_000;
const metadata = z.strictObject({
  path: NativeTargetPathSchema,
  mode: z.enum(['100644', '100755']),
  hash: HashSchema,
  bytes: z.number().int().nonnegative().max(MAX_SOURCE_BYTES),
});
const executable = z.strictObject({
  path: z.string().min(1).max(4096),
  version: z.string().min(1).max(200),
  sha256: HashSchema,
});
const pythonEnvironment = { LANG: 'C', LC_ALL: 'C' } as const;
const resultPrefix = 'CREWKITE_PYTHON_UNITTEST_RESULT_V1 ';
const harness = `import json,os,sys,unittest
complete=False
successful=False
tests=0
skipped=0
expected_failures=0
unexpected_successes=0
selected_files=False
paths=sys.argv[2:] if sys.argv[1:2]==['--'] else []
sys.path.insert(0,os.getcwd())
try:
 result=unittest.main(module=None,argv=['unittest','-v']+paths,testRunner=unittest.TextTestRunner(stream=sys.stderr,verbosity=2),exit=False).result
 tests=result.testsRun
 skipped=len(result.skipped)
 expected_failures=len(result.expectedFailures)
 unexpected_successes=len(result.unexpectedSuccesses)
 selected_files=bool(paths) and all(getattr(sys.modules.get(os.path.splitext(path)[0].replace(os.sep,'.')),'__file__',None) is not None and os.path.realpath(sys.modules[os.path.splitext(path)[0].replace(os.sep,'.')].__file__)==os.path.realpath(path) for path in paths)
 complete=True
 successful=result.wasSuccessful() and tests>0 and skipped==0 and expected_failures==0 and unexpected_successes==0 and selected_files
except BaseException:
 sys.stderr.write('The unittest harness did not complete.\\n')
record={'version':1,'complete':complete,'successful':successful,'tests':tests,'skipped':skipped,'expectedFailures':expected_failures,'unexpectedSuccesses':unexpected_successes,'selectedFiles':selected_files}
with os.fdopen(3,'w') as channel:
 channel.write(json.dumps(record,separators=(',',':'))+'\\n')
raise SystemExit(0 if complete and successful else 1)
`;
const runner = `const {spawnSync}=require('node:child_process');const {createHash}=require('node:crypto');const {readFileSync}=require('node:fs');const [python,expected,...argv]=process.argv.slice(1);const digest=()=>createHash('sha256').update(readFileSync(python)).digest('hex');if(digest()!==expected)process.exit(1);const result=spawnSync(python,argv,{cwd:process.cwd(),env:{LANG:'C',LC_ALL:'C'},encoding:'buffer',maxBuffer:67108864,stdio:['ignore','pipe','pipe','pipe']});if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stdout.write(result.stderr);let record;try{const raw=result.output[3].toString('utf8');if(!raw.endsWith('\\n')||raw.indexOf('\\n')!==raw.length-1)throw Error();record=JSON.parse(raw);if(!record||record.version!==1||typeof record.complete!=='boolean'||typeof record.successful!=='boolean'||typeof record.selectedFiles!=='boolean'||!Number.isSafeInteger(record.tests)||record.tests<0||!Number.isSafeInteger(record.skipped)||record.skipped<0||!Number.isSafeInteger(record.expectedFailures)||record.expectedFailures<0||!Number.isSafeInteger(record.unexpectedSuccesses)||record.unexpectedSuccesses<0||Object.keys(record).sort().join(',')!=='complete,expectedFailures,selectedFiles,skipped,successful,tests,unexpectedSuccesses,version')throw Error();process.stdout.write('\\n${resultPrefix}'+JSON.stringify(record)+'\\n');}catch{record=undefined;}const valid=record&&record.complete&&record.successful&&record.selectedFiles&&record.tests>0&&record.skipped===0&&record.expectedFailures===0&&record.unexpectedSuccesses===0&&result.status===0;if(digest()!==expected)process.exit(1);process.exit(valid?0:1);`;
const runnerHash = createHash('sha256').update(runner).digest('hex');
const pythonArguments = (paths: readonly string[]) => [
  '-I',
  '-E',
  '-s',
  '-B',
  '-c',
  harness,
  '--',
  ...paths,
];
const nodeArguments = (
  selected: { path: string; sha256: string },
  unittestArgv: readonly string[],
) => [
  '--input-type=commonjs',
  '--eval',
  runner,
  '--',
  selected.path,
  selected.sha256,
  ...unittestArgv,
];
const evaluator = (
  wrapper: { version: string; sha256: string },
  selected: { version: string; sha256: string },
) =>
  `project-python-unittest-v1:${wrapper.version}:${wrapper.sha256}:${selected.version}:${selected.sha256}`;

export const PythonCheckDefinitionSchema = z.strictObject({
  recipeId: z.literal('project-python-unittest-v1'),
  candidateId: CandidateSchema.shape.id,
  candidateHash: HashSchema,
  definitionHash: HashSchema,
  evaluator: z.string().min(1).max(300),
  criteria: z.array(z.string().min(1).max(4096)).min(1).max(100),
  sourceTreeHash: HashSchema,
  candidateTreeHash: HashSchema,
  collection: z.array(metadata).min(1).max(32),
  required: z.strictObject({ files: ProjectPythonTestFilesSchema }),
  executable,
  wrapper: executable,
  runnerHash: HashSchema,
  unittestArgv: z.array(z.string().min(1).max(16_384)).min(8).max(39),
  argv: z.array(z.string().min(1).max(16_384)).min(14).max(45),
  env: z.strictObject({ LANG: z.literal('C'), LC_ALL: z.literal('C') }),
});
export type PythonCheckDefinition = z.infer<typeof PythonCheckDefinitionSchema>;
export type PythonCheckOutcome = Readonly<{
  passed: boolean;
  complete: boolean;
  tests: number;
  sourceUnchanged: boolean;
  candidateUnchanged: boolean;
}>;

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const compare = (left: { path: string }, right: { path: string }) =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

function checkBudget(budget: CopyBudget) {
  if (budget.signal?.aborted || budget.now() >= budget.deadline)
    throw Error('Python check preparation cancelled or expired.');
}

function snapshot(files: readonly FileContent[]): {
  hash: string;
  files: z.infer<typeof metadata>[];
} {
  if (files.length === 0 || files.length > MAX_SOURCE_FILES)
    throw Error('Python check source file count is outside its bound.');
  const seen = new Set<string>();
  let bytes = 0;
  const entries = files
    .map((file) => {
      const value = metadata.parse({
        path: file.path,
        mode: file.mode,
        hash: file.hash,
        bytes: file.bytes,
      });
      if (seen.has(value.path)) throw Error('Python check source repeats a path.');
      seen.add(value.path);
      bytes += value.bytes;
      if (
        bytes > MAX_SOURCE_BYTES ||
        !Buffer.isBuffer(file.content) ||
        file.content.length !== value.bytes ||
        hash(file.content) !== value.hash
      )
        throw Error('Python check source does not match its recorded identity.');
      return value;
    })
    .sort(compare);
  return { hash: hashCanonical(entries), files: entries };
}

function definitionHash(value: Omit<PythonCheckDefinition, 'definitionHash'>) {
  return hashCanonical(value);
}

export function validPythonCheckDefinition(value: unknown): value is PythonCheckDefinition {
  const parsed = PythonCheckDefinitionSchema.safeParse(value);
  if (!parsed.success) return false;
  const { definitionHash: saved, ...fields } = parsed.data;
  const paths = fields.required.files;
  return (
    saved === definitionHash(fields) &&
    isAbsolute(fields.executable.path) &&
    isAbsolute(fields.wrapper.path) &&
    fields.evaluator === evaluator(fields.wrapper, fields.executable) &&
    fields.runnerHash === runnerHash &&
    canonicalJson(fields.unittestArgv) === canonicalJson(pythonArguments(paths)) &&
    canonicalJson(fields.argv) ===
      canonicalJson(nodeArguments(fields.executable, fields.unittestArgv)) &&
    canonicalJson(fields.env) === canonicalJson(pythonEnvironment) &&
    canonicalJson(fields.collection.map((file) => file.path)) === canonicalJson(paths)
  );
}

function inspectExecutable(path: string) {
  const executablePath = realpathSync(path);
  const state = statSync(executablePath);
  if (!state.isFile() || !(state.mode & 0o111) || state.size > 512 * 1024 * 1024)
    throw Error('The executable is not a bounded regular file.');
  return { path: executablePath, sha256: hash(readFileSync(executablePath)) };
}

function inspectNode() {
  return { ...inspectExecutable(process.execPath), version: process.version };
}

function inspectPython(path: string, budget: CopyBudget) {
  checkBudget(budget);
  if (!isAbsolute(path)) throw Error('Select a concrete Python executable.');
  const selected = spawnSync(
    path,
    ['-I', '-E', '-s', '-B', '-c', 'import os,sys;print(os.path.realpath(sys.executable))'],
    {
      env: pythonEnvironment,
      timeout: Math.max(1, Math.min(5000, budget.deadline - budget.now())),
      maxBuffer: 4096,
      encoding: 'utf8',
    },
  );
  if (selected.error || selected.status !== 0) throw Error('Python selection failed.');
  const selectedPath = selected.stdout.trim();
  if (!isAbsolute(selectedPath) || selectedPath.includes('\n'))
    throw Error('Python did not select one concrete executable.');
  const concrete = inspectExecutable(selectedPath);
  checkBudget(budget);
  const observed = spawnSync(concrete.path, ['--version'], {
    env: pythonEnvironment,
    timeout: Math.max(1, Math.min(5000, budget.deadline - budget.now())),
    maxBuffer: 4096,
    encoding: 'buffer',
  });
  if (observed.error || observed.status !== 0) throw Error('Python version inspection failed.');
  const match = /^Python 3\.(\d+)\.(\d+)$/m.exec(
    Buffer.concat([observed.stdout, observed.stderr]).toString(),
  );
  checkBudget(budget);
  if (!match || Number(match[1]) < 9) throw Error('Python 3.9 or newer is required.');
  const current = inspectExecutable(concrete.path);
  if (canonicalJson(concrete) !== canonicalJson(current))
    throw Error('The Python executable changed during inspection.');
  return { ...current, version: match[0] };
}

export function preparePythonCheck(input: {
  candidateId: string;
  candidateHash: string;
  source: readonly FileContent[];
  candidate: readonly FileContent[];
  criteria: readonly string[];
  testFiles: readonly string[];
  python: string;
  budget: CopyBudget;
}): PythonCheckDefinition {
  const candidateId = CandidateSchema.shape.id.parse(input.candidateId);
  const candidateHash = HashSchema.parse(input.candidateHash);
  const criteria = z.array(z.string().min(1).max(4096)).min(1).max(100).parse(input.criteria);
  const paths = ProjectPythonTestFilesSchema.parse(input.testFiles).sort();
  const source = snapshot(input.source);
  const candidate = snapshot(input.candidate);
  const collection = paths.map((path) => {
    const original = source.files.find((file) => file.path === path);
    const selected = candidate.files.find((file) => file.path === path);
    if (!original || !selected || canonicalJson(original) !== canonicalJson(selected))
      throw Error('A selected committed Python test changed.');
    return original;
  });
  const python = inspectPython(input.python, input.budget);
  const wrapper = inspectNode();
  const unittestArgv = pythonArguments(paths);
  const fields: Omit<PythonCheckDefinition, 'definitionHash'> = {
    recipeId: 'project-python-unittest-v1',
    candidateId,
    candidateHash,
    evaluator: evaluator(wrapper, python),
    criteria,
    sourceTreeHash: source.hash,
    candidateTreeHash: candidate.hash,
    collection,
    required: { files: paths },
    executable: python,
    wrapper,
    runnerHash,
    unittestArgv,
    argv: nodeArguments(python, unittestArgv),
    env: pythonEnvironment,
  };
  return PythonCheckDefinitionSchema.parse({ ...fields, definitionHash: definitionHash(fields) });
}

function report(output: Buffer): { complete: boolean; successful: boolean; tests: number } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(output);
    const records = text.split('\n').filter((line) => line.startsWith(resultPrefix));
    if (records.length !== 1 || text.trimEnd().split('\n').at(-1) !== records[0])
      return { complete: false, successful: false, tests: 0 };
    const record = z
      .strictObject({
        version: z.literal(1),
        complete: z.boolean(),
        successful: z.boolean(),
        tests: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        expectedFailures: z.number().int().nonnegative(),
        unexpectedSuccesses: z.number().int().nonnegative(),
        selectedFiles: z.boolean(),
      })
      .parse(JSON.parse(records[0].slice(resultPrefix.length)));
    const complete = record.complete && record.tests > 0;
    return {
      complete,
      successful:
        complete &&
        record.successful &&
        record.skipped === 0 &&
        record.expectedFailures === 0 &&
        record.unexpectedSuccesses === 0 &&
        record.selectedFiles,
      tests: record.tests,
    };
  } catch {
    return { complete: false, successful: false, tests: 0 };
  }
}

export function evaluatePythonCheck(input: {
  definition: PythonCheckDefinition;
  source: readonly FileContent[];
  candidate: readonly FileContent[];
  checkedCandidate: readonly FileContent[];
  exitCode: number | null;
  output: Buffer;
  budget: CopyBudget;
}): PythonCheckOutcome {
  if (!validPythonCheckDefinition(input.definition))
    throw Error('Python check definition changed.');
  const python = inspectPython(input.definition.executable.path, input.budget);
  const wrapper = inspectNode();
  const source = snapshot(input.source);
  const candidate = snapshot(input.candidate);
  const checkedCandidate = snapshot(input.checkedCandidate);
  const sourceUnchanged = source.hash === input.definition.sourceTreeHash;
  const candidateUnchanged =
    candidate.hash === input.definition.candidateTreeHash &&
    checkedCandidate.hash === input.definition.candidateTreeHash;
  const identityUnchanged = canonicalJson(python) === canonicalJson(input.definition.executable);
  const wrapperUnchanged = canonicalJson(wrapper) === canonicalJson(input.definition.wrapper);
  const { complete, successful, tests } = report(input.output);
  return {
    passed:
      input.exitCode === 0 &&
      complete &&
      successful &&
      sourceUnchanged &&
      candidateUnchanged &&
      identityUnchanged &&
      wrapperUnchanged,
    complete,
    tests,
    sourceUnchanged,
    candidateUnchanged,
  };
}
