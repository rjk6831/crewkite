import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { render } from 'ink';
import { createElement as h } from 'react';
import { connectChat } from '../chat/connect.ts';
import { startScriptedController } from '../scripted-controller.ts';
import { defaultSettings } from '../settings.ts';
import { App } from './app.ts';

/** A terminal the test types into. Each frame Ink writes replaces the screen. */
function terminal() {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });
  const waiters: { match: (screen: string) => boolean; done: () => void }[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 100,
    rows: 60,
    screen: '',
    write(chunk: string, done?: () => void) {
      done?.();
      if (chunk === '') return true;
      stdout.screen = stripVTControlCharacters(chunk);
      for (const waiter of [...waiters])
        if (waiter.match(stdout.screen)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.done();
        }
      return true;
    },
  });
  const shows = (text: string) =>
    new Promise<void>((done) => {
      const match = (screen: string) => screen.includes(text);
      if (match(stdout.screen)) done();
      else waiters.push({ match, done });
    });
  return { stdin, stdout, shows, type: (keys: string) => stdin.write(keys) };
}

test('the interactive app sends a typed message, answers a permission by digit and asks before leaving a running reply', {
  timeout: 60_000,
}, async (t) => {
  const { home, repository } = await startScriptedController(t, [
    [
      { kind: 'permission', requestId: 'edit-1', question: 'Edit net.mjs?' },
      { kind: 'text', itemId: 'done', chunks: ['Edited ', 'net.mjs.'] },
    ],
    [{ kind: 'wait' }],
  ]);
  const client = await connectChat(home);
  t.after(() => client.transport.close());
  await client.send('RegisterProject', { path: repository });
  const screen = terminal();
  let saved = 0;
  const app = render(
    h(App, {
      client,
      settings: {
        ...defaultSettings(),
        selection: { family: 'anthropic', model: 'fixture-model', effort: 'default' },
        // Only offered: the new thread keeps asking unless the person says yes.
        permissionPolicy: 'allow-all',
      },
      settingsProblem: null,
      saveSettings: (next) => {
        saved++;
        return next;
      },
      animation: 'off',
      // The terminal started inside the project, as pnpm reports it through INIT_CWD.
      env: { NO_COLOR: '1', PATH: process.env.PATH, INIT_CWD: repository },
    }),
    {
      stdin: screen.stdin as never,
      stdout: screen.stdout as never,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  await screen.shows('Ask about this project');
  await screen.shows('project shop');
  screen.type('Clamp the discount');
  await screen.shows('Clamp the discount');
  screen.type('\r');
  await screen.shows('Switch it to Allow all? (y/n)');
  screen.type('n');
  await screen.shows('Press Tab to answer.');
  // A digit typed in the message box stays text; Tab gives the request focus, then 1 answers.
  screen.type('1');
  await screen.shows('│ 1');
  screen.type('\u007f');
  screen.type('\t');
  await screen.shows('Press 1 or 2 to answer, Tab to go back.');
  screen.type('1');
  await screen.shows('Edited net.mjs.');
  const [thread] = (await client.listThreads()).threads;
  assert.equal((await client.readThread(thread.id)).thread.permissionPolicy, 'ask');

  // A saved prompt lands in the box, unsent, with an unfilled placeholder named in the note.
  await client.run('SaveChatPrompt', { name: 'review', body: 'Review {{area}} for {{risk}}.' });
  screen.type('/prompt review area="the parser"');
  await screen.shows('/prompt review area="the parser"');
  screen.type('\r');
  await screen.shows('Review the parser for {{risk}}.');
  await screen.shows('Fill in risk.');
  for (let i = 0; i < 'Review the parser for {{risk}}.'.length; i++) screen.type('\u007f');
  screen.type('/prompt nothing');
  await screen.shows('│ /prompt nothing');
  screen.type('\r');
  await screen.shows('No saved prompt is named nothing.');

  // A running reply: Ctrl+C asks first, n keeps the app, Escape stops the reply.
  screen.type('Wait here');
  await screen.shows('Wait here');
  screen.type('\r');
  await screen.shows('Working');
  screen.type('\u0003');
  await screen.shows('A reply is running. Leave CrewKite?');
  screen.type('n');
  screen.type('\u001b');
  await screen.shows('Stopping.');
  await screen.shows('Stopped');
  screen.type('\u0003');
  await app.waitUntilExit();
  assert.equal(saved, 0);
});
