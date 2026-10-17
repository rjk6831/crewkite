import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AttemptSchema,
  type ConversationEntry,
  ConversationTurnBindingSchema,
  RunSchema,
  TaskSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { createDemoFixtures, createTestClock, createTestIds } from '@crewkite/testkit';
import { Store } from '../store/index.ts';
import { type FrozenConversationTurn, TaskConversation } from './conversation.ts';

test('durable conversation keeps questions and queued input within the owned turn', (t) => {
  const directory = mkdtempSync(join(resolve('internal'), 'conversation-test-'));
  const path = join(directory, 'state.sqlite');
  let store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.applyMigrations(fileURLToPath(new URL('../../migrations/', import.meta.url)));
  const clock = createTestClock();
  const id = createTestIds(clock.now(), 1000n);
  const fixtures = createDemoFixtures(clock.now());
  const run = RunSchema.parse({
    id: id('run'),
    taskId: fixtures.task.id,
    source: {
      projectId: fixtures.task.projectId,
      base: 'a'.repeat(40),
      branch: 'main',
      dirtyCount: 0,
      untrackedCount: 0,
    },
    policy: { policy: fixtures.policy, hash: hashCanonical(fixtures.policy) },
    roles: [
      {
        role: 'lead',
        routeId: fixtures.snapshot.routes[0].id,
        pinned: true,
        approvedFallbacks: [],
      },
    ],
    decision: {
      chosen: fixtures.snapshot.routes[0].id,
      rejected: [],
      rule: 'manual',
      inputsHash: 'b'.repeat(64),
    },
    revision: 0,
  });
  const attempt = AttemptSchema.parse({
    id: id('att'),
    runId: run.id,
    routeId: run.roles[0].routeId,
    generation: 0,
    state: 'running',
    revision: 0,
  });
  const task = TaskSchema.parse({ ...fixtures.task, runId: run.id, state: 'running' });
  const other = TaskSchema.parse({ ...fixtures.task, id: id('tsk') });
  store.transaction(() => {
    store.put('project', fixtures.snapshot.projects[0].id, 0, fixtures.snapshot.projects[0]);
    store.put('task', task.id, task.revision, task);
    store.put('task', other.id, other.revision, other);
    store.put('run', run.id, 0, run);
    store.put('attempt', attempt.id, 0, attempt);
  });
  let messageNumber = 0;
  let ownsTurn = false;
  const makeConversation = () =>
    new TaskConversation(store, {
      now: clock.now,
      messageId: () => `msg_${String(messageNumber++).padStart(26, '0')}`,
      ownsTurn: () => ownsTurn,
      publish: (entries, updated) => {
        store.append({
          protocol: 1,
          id: id('evt'),
          at: clock.now(),
          taskId: updated.id,
          revision: updated.revision,
          type: 'task.updated',
          payload: updated,
        });
        for (const entry of entries)
          store.append({
            protocol: 1,
            id: id('evt'),
            at: clock.now(),
            taskId: updated.id,
            revision: updated.revision,
            type: 'conversation.entry',
            payload: entry,
          });
      },
    });
  let conversation = makeConversation();
  assert.throws(() => conversation.recordMessage(task.id, 'No detached write.'));
  assert.equal(conversation.page(task.id).entries.length, 0);
  const user = store.transaction(() =>
    conversation.recordMessage(task.id, 'Keep the public export.'),
  );
  assert(user.applied);
  const scope = { paths: ['src/main.ts'], roles: ['coder' as const], checks: ['node-tests-v1'] };
  const binding = ConversationTurnBindingSchema.parse({
    taskId: task.id,
    runId: run.id,
    attemptId: attempt.id,
    routeId: attempt.routeId,
    generation: 0,
    role: 'lead',
    taskRevision: user.task.revision,
    conversationRevision: conversation.revision(task.id),
    scopeHash: hashCanonical(scope),
    limitMinutes: 1,
  });
  const turn: FrozenConversationTurn = {
    binding,
    scope,
    bindingHash: hashCanonical({ binding, scope, history: conversation.page(task.id).entries }),
  };
  const proposal = {
    summary: 'Change the module.',
    criteria: ['Keep the export.'],
    slices: [
      {
        id: 'module',
        title: 'Change the module',
        role: 'coder',
        scope: ['src/main.ts'],
        dependsOn: [],
      },
    ],
    checks: ['node-tests-v1'],
  };
  const output = {
    version: 1,
    bindingHash: turn.bindingHash,
    message: 'I need one decision before coding.',
    questions: ['Which export must remain?', 'Which failure should the check protect?'],
    proposal,
  };
  assert.deepEqual(
    store.transaction(() => conversation.recordReply(turn, output)),
    { applied: false, reason: 'turn-binding-changed' },
  );
  ownsTurn = true;
  const originalRun = store.get('run', run.id);
  const originalAuthority = {
    outcome: user.task.outcome,
    criteria: user.task.criteria,
    state: user.task.state,
    runId: user.task.runId,
  };
  for (const invalid of [
    { ...output, grants: [] },
    { ...output, bindingHash: 'c'.repeat(64) },
    { ...output, proposal: { ...proposal, checks: ['caller-command'] } },
    { ...output, proposal: { ...proposal, slices: [{ ...proposal.slices[0], role: 'reviewer' }] } },
    {
      ...output,
      proposal: { ...proposal, slices: [{ ...proposal.slices[0], scope: ['src/other.ts'] }] },
    },
  ]) {
    const cursor = store.cursor();
    const revision = conversation.revision(task.id);
    const refused = store.transaction(() => conversation.recordReply(turn, invalid));
    assert.equal(refused.applied, false);
    assert.equal(store.cursor(), cursor);
    assert.equal(conversation.revision(task.id), revision);
  }
  assert.equal(conversation.pendingInputs(task.id).length, 1);
  const delivery = store.transaction(() => conversation.includeInputs(turn, [user.entries[0].id]));
  assert(delivery.applied);
  assert.equal(delivery.entries[0].kind, 'input-delivery');
  assert.equal(conversation.pendingInputs(task.id).length, 0);
  assert.equal(
    store.transaction(() => conversation.includeInputs(turn, [user.entries[0].id])).applied,
    false,
  );
  const reply = store.transaction(() => conversation.recordReply(turn, output));
  assert(reply.applied);
  const question = reply.entries.find((entry) => entry.kind === 'question');
  assert(question);
  assert.equal(conversation.pendingQuestions(task.id).length, 2);
  assert.equal(store.transaction(() => conversation.recordReply(turn, output)).applied, false);
  assert.deepEqual(
    store.transaction(() => conversation.answerQuestion(other.id, question.id, 'Other task.')),
    { applied: false, reason: 'question-not-found' },
  );
  const answer = store.transaction(() =>
    conversation.answerQuestion(task.id, question.id, 'Keep the named export.'),
  );
  assert(answer.applied);
  assert.equal(conversation.pendingQuestions(task.id).length, 1);
  assert.deepEqual(
    store.transaction(() => conversation.answerQuestion(task.id, question.id, 'Repeat.')),
    { applied: false, reason: 'question-already-answered' },
  );
  const guidance = store.transaction(() =>
    conversation.recordMessage(task.id, 'Use the existing helper.', 'guidance'),
  );
  assert(guidance.applied);
  const queued = conversation.pendingInputs(task.id);
  assert.deepEqual(
    queued.map((entry) => entry.kind),
    ['answer', 'guidance'],
  );
  assert.equal(
    store.transaction(() => conversation.includeInputs(turn, [guidance.entries[0].id])).applied,
    false,
  );
  const saved = conversation.page(task.id);
  const events = store.eventsAfter('0');
  assert(
    events.some((event) => event.type === 'conversation.entry' && event.payload.id === question.id),
  );
  const current = TaskSchema.parse(store.get('task', task.id));
  assert.deepEqual(
    {
      outcome: current.outcome,
      criteria: current.criteria,
      state: current.state,
      runId: current.runId,
    },
    originalAuthority,
  );
  assert.deepEqual(store.get('run', run.id), originalRun);
  assert.deepEqual(store.get('attempt', attempt.id), attempt);
  store.close();
  store = new Store(path);
  conversation = makeConversation();
  assert.deepEqual(conversation.page(task.id), saved);
  assert.deepEqual(conversation.pendingInputs(task.id), queued);
  assert.deepEqual(store.eventsAfter('0'), events);
  for (let index = 0; index < 110; index++)
    store.transaction(() => conversation.recordMessage(task.id, '\\'.repeat(4096)));
  const all: ConversationEntry[] = [];
  let before: string | undefined;
  do {
    const page = conversation.page(task.id, before);
    assert(page.entries.length <= 100);
    assert(Buffer.byteLength(JSON.stringify(page)) <= 524288);
    all.unshift(...page.entries);
    before = page.nextBeforeCursor ?? undefined;
  } while (before !== undefined);
  assert.equal(new Set(all.map((entry) => entry.id)).size, saved.entries.length + 110);
  assert(
    all.every(
      (entry, index) => index === 0 || BigInt(all[index - 1].cursor) < BigInt(entry.cursor),
    ),
  );
  const obsoleteQuestion = reply.entries.filter((entry) => entry.kind === 'question')[1];
  store.transaction(() => {
    const currentTask = TaskSchema.parse(store.get('task', task.id));
    store.put('task', task.id, currentTask.revision + 1, {
      ...currentTask,
      runId: null,
      revision: currentTask.revision + 1,
    });
  });
  assert.equal(conversation.pendingQuestions(task.id).length, 0);
  assert.deepEqual(
    store.transaction(() =>
      conversation.answerQuestion(task.id, obsoleteQuestion.id, 'Late answer.'),
    ),
    { applied: false, reason: 'question-not-current' },
  );
});
