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
      },
      settingsProblem: null,
      saveSettings: (next) => {
        saved++;
        return next;
      },
      animation: 'off',
      env: { NO_COLOR: '1' },
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
  await screen.shows('[1] Allow once');
  screen.type('1');
  await screen.shows('Edited net.mjs.');

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
