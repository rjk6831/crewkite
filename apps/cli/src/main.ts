import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type ControllerClient,
  connectController,
  createCommandKey,
  readControllerEndpoint,
} from '@crewkite/client/node';
import {
  ArtifactSchema,
  type Command,
  type CommandResult,
  CommandSchema,
  canonicalJson,
  MAX_FRAME_BYTES,
  ProjectNodeTestFilesSchema,
  type Snapshot,
  type Task,
  TaskSchema,
} from '@crewkite/contracts';

const help = `Usage: crewkite task <list|show|watch|start|stop|resume|switch|approve|deny> [id] [--json] [--home path]
       crewkite task switch <task-id> <route-id> [--json] [--home path]
       crewkite native profiles [--json] [--home path]
       crewkite task prepare-native <task-id> <profile-id> <path> --policy file [--native-trust --source-consent] [--existing-credits]
       crewkite task prepare-evaluation <task-id> <profile-id> --grants file [--recipe node-tests-v1|project-node-tests-v1] [--test-file path ...] [--native-trust --source-consent] [--existing-credits]
       crewkite task <start-checks|start-review> <task-id> [--json] [--home path]
       crewkite task accept <task-id> <destination-ref> [--json] [--home path]
       crewkite task changes <task-id> [--json] [--home path]
       crewkite task export <task-id> --output new-file [--json] [--home path]
       crewkite health [--json] [--home path]
       crewkite retry <receipt-file> [--output new-file] [--json] [--home path]

Approval commands take an approval ID. Other task commands take a task ID.
Create tasks in the desktop. Native preparation uses explicit consent or the controller's exact saved consent.
`;
interface Output {
  out: (text: string) => void;
  err: (text: string) => void;
}

const terminalText = (value: string) =>
  value.replace(/\p{Cc}/gu, (character) =>
    ['\n', '\t'].includes(character)
      ? character
      : `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

export async function runCli(
  args: string[],
  output: Output = {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
): Promise<number> {
  let client: ControllerClient | undefined;
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        home: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        policy: { type: 'string' },
        grants: { type: 'string' },
        recipe: { type: 'string' },
        'test-file': { type: 'string', multiple: true },
        'native-trust': { type: 'boolean' },
        'source-consent': { type: 'boolean' },
        'existing-credits': { type: 'boolean' },
        output: { type: 'string' },
      },
    });
    if (values.help || positionals.length === 0) {
      output.out(help);
      return 0;
    }
    const [area, action, id, ...extra] = positionals;
    if (
      (extra.length &&
        !(
          area === 'task' &&
          ((['switch', 'accept'].includes(action) && extra.length === 1) ||
            (action === 'prepare-native' && extra.length === 2) ||
            (action === 'prepare-evaluation' && extra.length === 1))
        )) ||
      !['task', 'native', 'health', 'retry'].includes(area)
    )
      throw new Error('Unknown command. Use --help.');
    const supported = [
      'list',
      'show',
      'watch',
      'start',
      'stop',
      'resume',
      'switch',
      'accept',
      'approve',
      'deny',
      'prepare-native',
      'prepare-evaluation',
      'start-checks',
      'start-review',
      'changes',
      'export',
    ];
    if (
      area === 'task' &&
      (!action ||
        !supported.includes(action) ||
        (['switch', 'accept'].includes(action) && extra.length !== 1) ||
        (action === 'prepare-native' && extra.length !== 2) ||
        (action === 'prepare-evaluation' && extra.length !== 1) ||
        (action === 'list' ? id !== undefined : id === undefined))
    )
      throw new Error('Invalid task command. Use --help.');
    if (area === 'health' && action !== undefined)
      throw new Error('Health takes no positional arguments.');
    if (area === 'retry' && (!action || id !== undefined))
      throw new Error('Retry takes one receipt file.');
    if (area === 'native' && (action !== 'profiles' || id !== undefined))
      throw new Error('Use native profiles to list supported profiles.');
    const preparing = area === 'task' && action === 'prepare-native';
    const evaluating = area === 'task' && action === 'prepare-evaluation';
    if (!evaluating && (values.recipe !== undefined || values['test-file'] !== undefined))
      throw new Error('Check recipe options require task prepare-evaluation.');
    const recipe = values.recipe ?? 'node-tests-v1';
    if (!['node-tests-v1', 'project-node-tests-v1'].includes(recipe))
      throw new Error('Choose node-tests-v1 or project-node-tests-v1.');
    if (recipe === 'node-tests-v1' && values['test-file'] !== undefined)
      throw new Error('Test files require --recipe project-node-tests-v1.');
    const checkRecipe =
      recipe === 'project-node-tests-v1'
        ? {
            checkRecipeId: 'project-node-tests-v1' as const,
            testFiles: ProjectNodeTestFilesSchema.parse(values['test-file'] ?? []),
          }
        : { checkRecipeId: 'node-tests-v1' as const };
    if (
      !preparing &&
      !evaluating &&
      (values.policy ||
        values['native-trust'] ||
        values['source-consent'] ||
        values['existing-credits'])
    )
      throw new Error('Native consent options require native or evaluation preparation.');
    if (values.policy && !preparing) throw new Error('Policy requires task prepare-native.');
    if (values.grants && !evaluating) throw new Error('Grants require task prepare-evaluation.');
    if (
      preparing &&
      (!values.policy || Boolean(values['native-trust']) !== Boolean(values['source-consent']))
    )
      throw new Error(
        'Supply a policy file and both native consent flags, or neither consent flag for saved consent.',
      );
    if (
      evaluating &&
      (!values.grants || Boolean(values['native-trust']) !== Boolean(values['source-consent']))
    )
      throw new Error(
        'Supply a grants file and both native consent flags, or neither consent flag for saved consent.',
      );
    if (
      values.output &&
      !(area === 'retry' || (area === 'task' && ['export', 'approve'].includes(action ?? '')))
    )
      throw new Error('Output requires an export action or its saved receipt.');
    if (area === 'task' && action === 'export' && !values.output)
      throw new Error('Export requires --output with a new file path.');
    const home = resolve(values.home ?? process.env.CREWKITE_HOME ?? join(homedir(), '.crewkite'));
    const actor = { id: 'terminal', kind: 'cli' as const };
    const connected = await connectController({ ...readControllerEndpoint(home), actor });
    client = connected;
    let sent: Command | undefined;
    const request = (
      command: string,
      payload: Record<string, unknown>,
      expectedRevision?: number,
    ) => {
      sent = CommandSchema.parse({
        protocol: 1,
        key: createCommandKey(),
        actor,
        command,
        payload,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      });
      return connected.command(sent);
    };
    const print = (data: unknown, text: string) =>
      output.out(values.json ? `${JSON.stringify(data)}\n` : `${text}\n`);
    const receipt = (
      result: CommandResult,
      command = sent,
      savedTo?: string,
      nextCommand?: string[],
    ) =>
      print(
        {
          command,
          result,
          ...(savedTo ? { savedTo } : {}),
          ...(nextCommand ? { nextCommand } : {}),
        },
        `${nextCommand ? (command?.command === 'AcceptCandidate' ? 'Local branch approval required.' : 'Export approval required.') : (result.reason ?? result.outcome)}\nCommand key ${command?.key}${savedTo ? `\nPatch saved to ${savedTo}` : ''}${nextCommand ? `\nNext: ${nextCommand.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' ')}` : ''}`,
      );
    const finishAction = async (result: CommandResult) => {
      const command = sent;
      let savedTo: string | undefined;
      try {
        const pending = TaskSchema.safeParse(result.entity);
        if (
          command &&
          (command.command === 'AcceptCandidate' || command.command === 'ExportPatch') &&
          succeeded(result) &&
          pending.success &&
          pending.data.state === 'waiting' &&
          pending.data.waitingReason === 'approval'
        ) {
          const fresh = await connected.snapshot();
          const task = fresh.tasks.find((value) => value.id === command.payload.taskId);
          const candidate = fresh.candidates.filter((value) => value.taskId === task?.id).at(-1);
          const action =
            command.command === 'AcceptCandidate' ? 'accept-candidate' : 'export-patch';
          const target =
            command.command === 'AcceptCandidate'
              ? command.payload.destinationRef
              : command.payload.taskId;
          const matches = fresh.approvals.filter((approval) => {
            const attempt = fresh.attempts.find((value) => value.id === approval.attemptId);
            return (
              approval.status === 'pending' &&
              approval.taskId === command.payload.taskId &&
              approval.action === action &&
              approval.target === target &&
              attempt?.runId === task?.runId &&
              attempt?.generation === approval.generation
            );
          });
          if (
            pending.data.id !== command.payload.taskId ||
            !task?.runId ||
            !fresh.runs.some((run) => run.id === task.runId && run.taskId === task.id) ||
            canonicalJson(task) !== canonicalJson(pending.data) ||
            candidate?.id !== command.payload.candidateId ||
            matches.length !== 1
          )
            throw new Error(
              'The pending action changed. Inspect the current task and approval before retrying.',
            );
          receipt(result, command, undefined, [
            'crewkite',
            'task',
            'approve',
            matches[0].approvalId,
            ...(command.command === 'ExportPatch' && values.output
              ? ['--output', resolve(values.output)]
              : []),
            '--home',
            home,
            ...(values.json ? ['--json'] : []),
          ]);
          return 0;
        }
        if (values.output && succeeded(result)) {
          const artifact = ArtifactSchema.parse(result.entity);
          if (artifact.bytes > 64 * 1024 * 1024)
            throw new Error('The patch exceeds the save bound.');
          const chunks: Buffer[] = [];
          let offset = 0;
          while (offset < artifact.bytes || offset === 0) {
            const part = await request('GetArtifact', {
              artifactId: artifact.id,
              offset,
              limit: 65536,
            });
            if (!succeeded(part) || part.data?.kind !== 'artifact')
              throw new Error('The patch is unavailable.');
            const data = part.data;
            if (
              canonicalJson(data.artifact) !== canonicalJson(artifact) ||
              data.offset !== offset ||
              data.encoding !== 'base64'
            )
              throw new Error('The patch identity changed.');
            const bytes = Buffer.from(data.content, 'base64');
            if (
              bytes.toString('base64') !== data.content ||
              bytes.length > 65536 ||
              (bytes.length === 0 && offset !== artifact.bytes)
            )
              throw new Error('The patch chunk is invalid.');
            chunks.push(bytes);
            offset += bytes.length;
            if (offset > artifact.bytes || data.eof !== (offset === artifact.bytes))
              throw new Error('The patch length changed.');
            if (data.eof) break;
          }
          const bytes = Buffer.concat(chunks);
          if (
            bytes.length !== artifact.bytes ||
            createHash('sha256').update(bytes).digest('hex') !== artifact.hash
          )
            throw new Error('The patch checksum changed.');
          savedTo = resolve(values.output);
          const file = openSync(
            savedTo,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            writeFileSync(file, bytes);
            fsyncSync(file);
          } finally {
            closeSync(file);
          }
        }
      } catch (error) {
        receipt(result, command);
        throw error;
      }
      receipt(result, command, savedTo);
      return succeeded(result) ? 0 : 2;
    };
    if (area === 'retry') {
      const value = readJson(action);
      if (value === null || typeof value !== 'object' || !('command' in value))
        throw new Error('Receipt has no saved command.');
      sent = CommandSchema.parse(value.command);
      if (values.output && !['ExportPatch', 'ResolveApproval'].includes(sent.command))
        throw new Error('This receipt cannot export a patch.');
      if (
        values.output &&
        sent.command === 'ResolveApproval' &&
        sent.payload.binding.action !== 'export-patch'
      )
        throw new Error('This approval does not export a patch.');
      const result = await connected.command(sent);
      return await finishAction(result);
    }
    if (area === 'health') {
      const result = await request('GetHealth', {});
      print(
        result,
        result.data?.kind === 'health' ? result.data.status : (result.reason ?? result.outcome),
      );
      return succeeded(result) ? 0 : 2;
    }
    const snapshot = await client.snapshot();
    if (area === 'native') {
      print(
        { profiles: snapshot.nativeProfiles },
        snapshot.nativeProfiles
          .map(
            (profile) =>
              `${profile.id}  ${profile.model}  ${profile.effort}  ${profile.available ? 'available' : profile.reason}`,
          )
          .join('\n') || 'No native profiles.',
      );
      return 0;
    }
    if (action === 'list') {
      print(
        { cursor: snapshot.cursor, tasks: snapshot.tasks },
        snapshot.tasks.length
          ? snapshot.tasks.map((task) => `${task.id}  ${task.state}  ${task.title}`).join('\n')
          : 'No tasks.',
      );
      return 0;
    }
    if (action === 'approve' || action === 'deny') {
      const approval = snapshot.approvals.find((item) => item.approvalId === id);
      if (!approval) throw new Error('Approval was not found.');
      const task = requireTask(snapshot, approval.taskId);
      const {
        approvalId,
        taskId,
        attemptId,
        generation,
        action: effect,
        target,
        revision,
      } = approval;
      if (values.output && effect !== 'export-patch')
        throw new Error('This approval does not export a patch.');
      const result = await request(
        'ResolveApproval',
        {
          binding: { approvalId, taskId, attemptId, generation, action: effect, target, revision },
          decision: action === 'approve' ? 'approved' : 'denied',
        },
        task.revision,
      );
      return await finishAction(result);
    }
    if (!id) throw new Error('A task ID is required.');
    const task = requireTask(snapshot, id);
    if (action === 'prepare-evaluation') {
      const profile = snapshot.nativeProfiles.find((profile) => profile.id === extra[0]);
      const run = snapshot.runs.find((run) => run.id === task.runId);
      const candidate = snapshot.candidates.filter((value) => value.taskId === task.id).at(-1);
      const methods = run?.policy.policy.methods ?? [];
      if (
        !profile?.available ||
        !run ||
        !candidate ||
        task.state !== 'stopped' ||
        !snapshot.nativeRuns.some((value) => value.runId === run.id)
      )
        throw new Error('A stopped native candidate and available reviewer profile are required.');
      if (methods.length !== 1 || methods[0].id !== 'keep-it-simple' || methods[0].cycles !== 1)
        throw new Error(
          'Evaluation requires the saved single keep-it-simple method and one cycle.',
        );
      const creditPolicy = values['existing-credits'] ? 'existing-credits' : 'ordinary';
      if (!profile.creditPolicies.includes(creditPolicy))
        throw new Error('This reviewer profile does not support the selected credit policy.');
      return await finishAction(
        await request(
          'PrepareCandidateEvaluation',
          {
            taskId: task.id,
            candidateId: candidate.id,
            ...checkRecipe,
            reviewer: { profileId: profile.id, methodId: methods[0].id, cycles: 1 },
            creditPolicy,
            consent: values['native-trust'] && values['source-consent'] ? 'explicit' : 'saved',
            grants: readJson(values.grants as string),
          },
          task.revision,
        ),
      );
    }
    if (action === 'start-checks' || action === 'start-review') {
      const evaluation = snapshot.candidateEvaluations.find((value) => value.taskId === task.id);
      if (!evaluation) throw new Error('Prepare a candidate evaluation first.');
      return await finishAction(
        await request(
          action === 'start-checks' ? 'StartCandidateEvaluation' : 'StartCandidateReview',
          {
            taskId: task.id,
            candidateId: evaluation.candidateId,
            preparationId: evaluation.preparationId,
          },
          task.revision,
        ),
      );
    }
    if (action === 'prepare-native') {
      const profile = snapshot.nativeProfiles.find((profile) => profile.id === extra[0]);
      if (!profile?.available)
        throw new Error(`Native profile unavailable: ${profile?.reason ?? 'not-found'}.`);
      const creditPolicy = values['existing-credits'] ? 'existing-credits' : 'ordinary';
      if (!profile.creditPolicies.includes(creditPolicy))
        throw new Error('This profile does not support the selected credit policy.');
      return await finishAction(
        await request(
          'PrepareNativeRun',
          {
            taskId: task.id,
            profileId: profile.id,
            targetPath: extra[1],
            policy: readJson(values.policy as string),
            creditPolicy,
            consent: values['native-trust'] && values['source-consent'] ? 'explicit' : 'saved',
          },
          task.revision,
        ),
      );
    }
    if (action === 'accept') {
      const candidate = snapshot.candidates.filter((value) => value.taskId === task.id).at(-1);
      if (!candidate) throw new Error('No retained candidate is available.');
      return await finishAction(
        await request(
          'AcceptCandidate',
          { taskId: task.id, candidateId: candidate.id, destinationRef: extra[0] },
          task.revision,
        ),
      );
    }
    if (action === 'changes' || action === 'export') {
      const changes = await request('GetChanges', { taskId: task.id });
      if (action === 'changes') {
        if (!values.json && changes.data?.kind === 'changes' && changes.data.truncated)
          output.out('Diff preview is truncated. Export retains the complete patch.\n');
        print(
          changes,
          changes.data?.kind === 'changes'
            ? terminalText(changes.data.diff)
            : (changes.reason ?? changes.outcome),
        );
        return succeeded(changes) ? 0 : 2;
      }
      if (changes.data?.kind !== 'changes' || !changes.data.candidateId) {
        print(changes, changes.reason ?? 'No retained candidate is available.');
        return 2;
      }
      return await finishAction(
        await request(
          'ExportPatch',
          { taskId: task.id, candidateId: changes.data.candidateId },
          task.revision,
        ),
      );
    }
    if (action === 'show') {
      const nativeRun = snapshot.nativeRuns.find((value) => value.runId === task.runId);
      const run = nativeRun
        ? snapshot.runs.find((value) => value.id === nativeRun.runId)
        : undefined;
      const preview = nativeRun
        ? `\nNative ${nativeRun.profileId}, ${nativeRun.stage}\nTarget ${nativeRun.target?.path ?? 'unknown'}\nBase hash ${nativeRun.target?.baseHash ?? 'unknown'}\nBytes ${nativeRun.target?.bytes ?? 'unknown'}\nExpires ${nativeRun.expiresAt ?? 'unknown'}\nSource base ${run?.source.base ?? 'unknown'}`
        : '';
      const evaluation = snapshot.candidateEvaluations.find((value) => value.taskId === task.id);
      const evidence = evaluation
        ? snapshot.evidence.filter((value) => value.candidateId === evaluation.candidateId)
        : [];
      const evaluationText = evaluation
        ? [
            '',
            `Evaluation ${evaluation.stage}`,
            `Preparation ${evaluation.preparationId}`,
            `Recipe ${evaluation.recipe}`,
            ...evaluation.testFiles.map(
              (file) =>
                `Test file ${terminalText(file.path)}, ${file.hash}, ${file.bytes} bytes, ${file.mode}`,
            ),
            `Candidate ${evaluation.candidateHash}`,
            `Target ${evaluation.target.path}`,
            `Original file hash ${evaluation.target.baseHash}`,
            `Candidate content hash ${evaluation.target.candidateContentHash}`,
            `Check definition ${evaluation.definitionHash}`,
            `Reviewer ${evaluation.reviewer.profileId}, ${evaluation.reviewer.assignedRole}, ${evaluation.reviewer.methodId}, cycle ${evaluation.reviewer.cycle}, process-only`,
            `Credits ${evaluation.creditPolicy}`,
            `Expires ${evaluation.expiresAt}`,
            `Remaining total attempts ${evaluation.remainingBudgets.attempts}, minutes ${evaluation.remainingBudgets.minutes}`,
            `Checks ${evaluation.check?.passed ?? 'unrecorded'}, ${evaluation.checkStart.reason}, artifact ${evaluation.check?.artifactId ?? 'unrecorded'}`,
            `Review ${evaluation.review?.outcome ?? 'unrecorded'}, ${evaluation.reviewStart.reason}, artifact ${evaluation.review?.artifactId ?? 'unrecorded'}`,
            'Supplemental allowance: one local check and one additional native review.',
            `Local acceptance ${evaluation.localAcceptance.available ? 'available' : 'unavailable'}, ${evaluation.localAcceptance.reason}. The destination needs its own grant or approval.`,
            ...evidence.flatMap((value) =>
              value.review
                ? [
                    terminalText(value.review.summary),
                    ...value.review.findings.map(
                      (finding) => `${finding.severity}: ${terminalText(finding.message)}`,
                    ),
                  ]
                : [],
            ),
          ].join('\n')
        : '';
      print(
        {
          cursor: snapshot.cursor,
          task,
          ...(nativeRun ? { nativeRun, run } : {}),
          ...(evaluation ? { evaluation, evidence } : {}),
        },
        `${task.id}\n${task.title}\n${task.state}, revision ${task.revision}${preview}${evaluationText}`,
      );
      return 0;
    }
    if (action === 'watch') {
      print(
        { type: 'snapshot', cursor: snapshot.cursor, task },
        `${snapshot.cursor} ${task.state}, revision ${task.revision}`,
      );
      const unsubscribe = await client.subscribe(
        snapshot.cursor,
        (event) => {
          if (event.taskId === task.id)
            print(event, `${event.cursor} ${event.type}, revision ${event.revision}`);
        },
        (fresh) => {
          const current = fresh.tasks.find((item) => item.id === task.id);
          if (current)
            print(
              { type: 'snapshot', cursor: fresh.cursor, task: current },
              `${fresh.cursor} ${current.state}, revision ${current.revision}`,
            );
        },
      );
      const stopConnection = client.onConnection((state) => {
        if (state === 'offline')
          output.err('Controller offline. The last event cursor is retained.\n');
      });
      const waiting = Promise.withResolvers<number>();
      const stop = () => waiting.resolve(0);
      const stopExhausted = client.onReconnectExhausted(() => {
        output.err('Reconnect attempts ended. Start the controller, then run task watch again.\n');
        waiting.resolve(1);
      });
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        return await waiting.promise;
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        stopExhausted();
        unsubscribe();
        stopConnection();
      }
    }
    if (!task.runId)
      throw new Error('Prepare this task in the desktop before controlling its run.');
    if (action === 'switch') {
      const result = await request(
        'SwitchRoute',
        { taskId: task.id, runId: task.runId, routeId: extra[0] },
        task.revision,
      );
      receipt(result);
      return succeeded(result) ? 0 : 2;
    }
    const names = { start: 'StartRun', stop: 'StopRun', resume: 'ResumeRun' } as const;
    const result = await request(
      names[action as keyof typeof names],
      { taskId: task.id, runId: task.runId },
      task.revision,
    );
    receipt(result);
    return succeeded(result) ? 0 : 2;
  } catch (error) {
    output.err(`${error instanceof Error ? error.message : 'CLI command failed.'}\n`);
    return 1;
  } finally {
    client?.close();
  }
}

function readJson(path: string): unknown {
  const file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const state = fstatSync(file);
    if (!state.isFile() || state.size > MAX_FRAME_BYTES)
      throw new Error('Input must be a bounded JSON file.');
    return JSON.parse(readFileSync(file, 'utf8'));
  } finally {
    closeSync(file);
  }
}

function requireTask(snapshot: Snapshot, id: string): Task {
  const task = snapshot.tasks.find((item) => item.id === id);
  if (!task) throw new Error('Task was not found.');
  return task;
}
function succeeded(result: CommandResult) {
  return result.outcome === 'applied' || result.outcome === 'already-applied';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runCli(process.argv.slice(2));
