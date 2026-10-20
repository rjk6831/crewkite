import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assembleSlices } from './integration.ts';
import type { FileContent } from './source.ts';

const base = 'a'.repeat(40);
function file(path: string, value: string | Buffer, mode: FileContent['mode'] = '100644') {
  const content = Buffer.from(value);
  return {
    path,
    mode,
    content,
    hash: createHash('sha256').update(content).digest('hex'),
    bytes: content.length,
  };
}
type Member = { base: string; scope: string[]; dependencies: string[]; files: FileContent[] };
function input(): { base: string; files: FileContent[]; members: [Member, Member] } {
  const files = [file('a.mjs', 'a'), file('b.mjs', 'b'), file('old.bin', Buffer.from([0, 255]))];
  return {
    base,
    files,
    members: [
      {
        base,
        scope: ['a.mjs', 'old.bin', 'new.bin'],
        dependencies: [],
        files: [file('a.mjs', 'changed'), files[1], file('new.bin', Buffer.from([255, 0]))],
      },
      {
        base,
        scope: ['b.mjs'],
        dependencies: [],
        files: [files[0], file('b.mjs', 'b', '100755'), files[2]],
      },
    ],
  };
}

test('serial assembly accepts only frozen scoped deltas', () => {
  const prepared = input();
  const unchanged = structuredClone(prepared);
  const steps = assembleSlices(prepared);
  assert.deepEqual(steps[0].files, [
    file('a.mjs', 'changed'),
    file('b.mjs', 'b'),
    file('new.bin', Buffer.from([255, 0])),
  ]);
  assert.deepEqual(steps[1].files, [
    file('a.mjs', 'changed'),
    file('b.mjs', 'b', '100755'),
    file('new.bin', Buffer.from([255, 0])),
  ]);
  assert.deepEqual(
    steps.map((step) =>
      step.changes.map(({ path, before, after }) => [
        path,
        before?.mode ?? null,
        after?.mode ?? null,
      ]),
    ),
    [
      [
        ['a.mjs', '100644', '100644'],
        ['new.bin', null, '100644'],
        ['old.bin', '100644', null],
      ],
      [['b.mjs', '100644', '100755']],
    ],
  );
  assert.deepEqual(steps[0].changes[0].before, prepared.files[0]);
  assert.deepEqual(steps[0].changes[0].after, file('a.mjs', 'changed'));
  assert.deepEqual(prepared, input());
  assert.deepEqual(structuredClone(prepared), unchanged);
  const reordered = input();
  reordered.files.reverse();
  for (const member of reordered.members) {
    member.files.reverse();
    member.scope.reverse();
  }
  assert.deepEqual(assembleSlices(reordered), steps);
  const noChange = input();
  noChange.members[1].files = noChange.files;
  const retained = assembleSlices(noChange);
  assert.deepEqual(retained[1].changes, []);
  assert.deepEqual(retained[1].files, retained[0].files);
  steps[0].files[0].content.fill(0);
  assert.equal(steps[1].files[0].content.toString(), 'changed');
  assert.equal(prepared.members[0].files[0].content.toString(), 'changed');

  const cases: {
    name: string;
    change: (value: ReturnType<typeof input>) => void;
    reason: RegExp;
  }[] = [
    {
      name: 'one member',
      change: (value) => {
        value.members.pop();
      },
      reason: /exactly two/,
    },
    {
      name: 'three members',
      change: (value) => {
        value.members.push(value.members[1]);
      },
      reason: /exactly two/,
    },
    {
      name: 'different base',
      change: (value) => {
        value.members[1].base = 'b'.repeat(40);
      },
      reason: /base changed/,
    },
    {
      name: 'dependent member',
      change: (value) => {
        value.members[1].dependencies = ['slice-1'];
      },
      reason: /no dependencies/,
    },
    {
      name: 'missing scope',
      change: (value) => {
        value.members[0].scope = [];
      },
      reason: /bounded exact scope/,
    },
    {
      name: 'overlapping scope',
      change: (value) => {
        value.members[1].scope.push('a.mjs');
      },
      reason: /collision/,
    },
    {
      name: 'case collision',
      change: (value) => {
        value.members[1].scope.push('A.mjs');
      },
      reason: /collision/,
    },
    {
      name: 'scope prefix collision',
      change: (value) => {
        value.members[1].scope.push('a.mjs/child');
      },
      reason: /collision/,
    },
    {
      name: 'unowned modification',
      change: (value) => {
        value.members[1].files[0] = file('a.mjs', 'unowned');
      },
      reason: /outside its scope/,
    },
    {
      name: 'unowned addition',
      change: (value) => {
        value.members[1].files.push(file('other.mjs', 'new'));
      },
      reason: /outside its scope/,
    },
    {
      name: 'unowned deletion',
      change: (value) => {
        value.members[1].files.pop();
      },
      reason: /outside its scope/,
    },
    {
      name: 'unowned mode change',
      change: (value) => {
        value.members[1].files[0] = file('a.mjs', 'a', '100755');
      },
      reason: /outside its scope/,
    },
    {
      name: 'untrusted content identity',
      change: (value) => {
        value.members[1].files[1] = { ...value.members[1].files[1], hash: '0'.repeat(64) };
      },
      reason: /file identity changed/,
    },
  ];
  for (const { name, change, reason } of cases) {
    const value = input();
    change(value);
    assert.throws(() => assembleSlices(value), reason, name);
    assert.deepEqual(value.files, input().files, name);
  }

  const full = Array.from({ length: 9_999 }, (_, index) => file(`file-${index}`, ''));
  assert.throws(
    () =>
      assembleSlices({
        base,
        files: full,
        members: [
          { base, scope: ['first'], dependencies: [], files: [...full, file('first', '')] },
          { base, scope: ['second'], dependencies: [], files: [...full, file('second', '')] },
        ],
      }),
    /file limit/,
    'the combined inventory must fit even when both members fit separately',
  );
});
