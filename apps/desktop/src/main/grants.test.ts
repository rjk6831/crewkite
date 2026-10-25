import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Command, CommandSchema } from '@crewkite/contracts';
import { droppedPaths } from '../shared/attach.ts';
import { attachmentTarget } from '../shared/open-file.ts';
import { PathGrants, storedAttachmentPath } from './grants.ts';

const taskId = `tsk_${'0'.repeat(25)}1`;
const picked = '/Users/me/Documents/plan.pdf';
const pasted = '/tmp/crewkite-paste-abc/pasted-image-1.png';
const secret = '/Users/me/.ssh/id_ed25519';

const command = (name: string, payload: object): Command =>
  CommandSchema.parse({
    protocol: 1,
    key: `cmd_${'0'.repeat(25)}1`,
    actor: { id: 'desktop', kind: 'desktop' },
    expectedRevision: 0,
    command: name,
    payload,
  });
const fromPath = (path: string) => command('ImportChatAttachment', { taskId, source: { path } });

test('main sends an import by path only for a path it gave the window', () => {
  const grants = new PathGrants();
  grants.grant(picked);
  grants.grant(pasted);
  const rows: [string, Command, boolean][] = [
    ['a path main never handed out is refused', fromPath(secret), false],
    ['a picker path is accepted', fromPath(picked), true],
    ['a saved clipboard image is accepted', fromPath(pasted), true],
    [
      'pasted bytes need no grant',
      command('ImportChatAttachment', {
        taskId,
        source: { name: 'note.txt', mimeType: 'text/plain', base64: 'aGk=' },
      }),
      true,
    ],
    ['other commands pass', command('RenameChatThread', { taskId, title: 'Plan' }), true],
  ];
  for (const [claim, value, allowed] of rows)
    assert.equal(grants.refusal(value) === null, allowed, claim);

  grants.revoke(pasted);
  assert.notEqual(grants.refusal(fromPath(pasted)), null, 'a removed clipboard image is refused');

  // The preload names a dropped file through webUtils only. A raw path string from the renderer
  // never reaches main's attach call, so main neither describes nor grants it.
  const file = new File(['x'], 'plan.pdf');
  const pathOf = (value: File) => (value === file ? picked : '');
  assert.deepEqual(droppedPaths([secret], pathOf), [], 'attach with a raw path string is refused');
  assert.deepEqual(droppedPaths([file, secret, null], pathOf), [picked], 'a dropped file is named');

  // A stored attachment is named by thread, hash and name. Main builds the path itself and refuses
  // anything that would leave that thread's files folder.
  const home = '/home/crewkite';
  const hash = 'a'.repeat(64);
  const stored = `${home}/chat/${taskId}/files/${hash}`;
  const open = (change: object) => ({
    action: 'preview',
    taskId,
    id: hash,
    name: 'plan.pdf',
    ...change,
  });
  const resolved = (input: unknown) => {
    const target = attachmentTarget(input);
    return target && storedAttachmentPath(home, target);
  };
  const opens: [string, unknown, string | null][] = [
    ['a stored file resolves under its thread', open({}), `${stored}/plan.pdf`],
    ['a name that climbs out is refused', open({ name: '../../x' }), null],
    ['a parent name is refused', open({ name: '..' }), null],
    ['a folder part in the name is refused', open({ name: 'a/b.pdf' }), null],
    ['a hash that is not a hash is refused', open({ id: '../..' }), null],
    ['a thread id that is not a thread id is refused', open({ taskId: '../../etc' }), null],
    ['an absolute path in the name is refused', open({ name: secret }), null],
    ['an unknown action is refused', open({ action: 'run' }), null],
    ['an extra field is refused', open({ path: secret }), null],
  ];
  for (const [claim, input, want] of opens) assert.equal(resolved(input), want, claim);
});
