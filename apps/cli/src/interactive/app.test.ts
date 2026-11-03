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
import { beforeGoogleConnection } from './google-gate.ts';

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
  const until = (match: (screen: string) => boolean) =>
    new Promise<void>((done) => {
      if (match(stdout.screen)) done();
      else waiters.push({ match, done });
    });
  const shows = (text: string) => until((screen) => screen.includes(text));
  const hides = (text: string) => until((screen) => !screen.includes(text));
  return { stdin, stdout, shows, hides, type: (keys: string) => stdin.write(keys) };
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
  // The Google terms gate asks only without a current acknowledgement and sends it on a yes only.
  const sent: unknown[] = [];
  const gate = (googleTerms: { version: string; at: string } | null, answer: boolean) => ({
    read: async () => ({ googleAcpSetup: { googleTerms } as never }),
    send: async (_command: string, payload: unknown) => {
      sent.push(payload);
      return { outcome: 'applied' as const };
    },
    ask: async () => answer,
  });
  const old = { version: '0000-00-00', at: '2026-10-28T00:00:00.000Z' };
  assert.equal(await beforeGoogleConnection(gate(old, false)), false);
  assert.deepEqual(sent, []);
  assert.equal(await beforeGoogleConnection(gate(old, true)), true);
  assert.equal(sent.length, 1);
  assert.equal(saved, 0);
});

test('the interactive app lets /provider, the /model list and /model id set the first turn', {
  timeout: 60_000,
}, async (t) => {
  const { home, repository } = await startScriptedController(t, [
    [{ kind: 'text', itemId: 'done', chunks: ['Done.'] }],
  ]);
  const client = await connectChat(home);
  t.after(() => client.transport.close());
  await client.send('RegisterProject', { path: repository });
  const screen = terminal();
  const app = render(
    h(App, {
      client,
      settings: defaultSettings(),
      settingsProblem: null,
      saveSettings: (next) => next,
      animation: 'off',
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
  // The gauge row waits for the catalog, and it names every provider, Google included.
  await screen.shows('G connect');
  await screen.shows('project shop');
  screen.type('/provider anthropic');
  await screen.shows('/provider anthropic');
  screen.type('\r');
  await screen.shows('First message: Anthropic');
  const firstDefault = /First message: Anthropic ([^\s.]+)/.exec(screen.stdout.screen)?.[1];
  assert.equal((await client.listThreads()).threads.length, 0);
  // An ID no family lists opens the model list filtered by it, with nothing matching.
  screen.type('/model none');
  await screen.shows('/model none');
  screen.type('\r');
  await screen.shows('No connected model matches.');
  await screen.shows('No connected provider lists none.');
  for (let i = 0; i < 4; i++) screen.type('\u007f');
  await screen.shows('A Anthropic');
  // Typing filters the list, Right moves the row's effort and Enter picks it.
  const models = (await client.readCatalog()).families.find(
    (entry) => entry.family === 'anthropic',
  )?.models;
  const target = models?.find((model) => model.model !== firstDefault);
  assert.ok(target);
  const levels = target.efforts.filter((effort) => effort !== 'default');
  screen.type(target.model);
  await screen.shows(`matching ${target.model}`);
  await screen.shows(`› ${target.model}`);
  screen.type('\u001b[C');
  const effort =
    levels.length === 0
      ? target.defaultEffort
      : levels[Math.min(levels.indexOf(target.defaultEffort) + 1, levels.length - 1)];
  if (levels.length > 0) await screen.shows(`[${effort}]`);
  screen.type('\r');
  await screen.shows(`First message: Anthropic ${target.model}`);
  // An ID typed after /model, with an effort after a colon, still applies at once.
  const direct = models?.find((model) => model.efforts.includes('high'));
  assert.ok(direct);
  screen.type(`/model ${direct.model}:high`);
  await screen.shows(`/model ${direct.model}:high`);
  screen.type('\r');
  await screen.shows(`First message: Anthropic ${direct.model} high.`);
  const chosen = direct.model;
  screen.type('Hello there');
  await screen.shows('Hello there');
  screen.type('\r');
  await screen.shows('Done.');
  const [thread] = (await client.listThreads()).threads;
  assert.deepEqual((await client.readThread(thread.id)).thread.selection, {
    family: 'anthropic',
    model: chosen,
    effort: 'high',
  });
  screen.type('\u0003');
  await app.waitUntilExit();
});

test('the interactive /crew list offers the presets and the crews saved in the desktop and applies one', {
  timeout: 60_000,
}, async (t) => {
  const { home, repository } = await startScriptedController(t, [
    [{ kind: 'text', itemId: 'done', chunks: ['Done.'] }],
  ]);
  const client = await connectChat(home);
  t.after(() => client.transport.close());
  await client.send('RegisterProject', { path: repository });
  // The desktop saves crews and the default through the controller; the terminal reads them.
  await client.run('SaveCrew', {
    crew: {
      id: 'crew-a',
      name: 'Review heavy',
      members: [
        { role: 'builder', selection: null },
        { role: 'reviewer', selection: null },
      ],
      flightMode: 'balanced',
    },
  });
  await client.run('SetDefaultCrew', { id: 'saved:crew-a' });
  const screen = terminal();
  const app = render(
    h(App, {
      client,
      settings: {
        ...defaultSettings(),
        selection: { family: 'anthropic', model: 'model-a', effort: 'low' },
      },
      settingsProblem: null,
      saveSettings: (next) => next,
      animation: 'off',
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
  await screen.shows('project shop');
  screen.type('Hello');
  await screen.shows('Hello');
  screen.type('\r');
  await screen.shows('Done.');
  // Enter takes the completion first, and the second Enter runs the command.
  screen.type('/crew');
  await screen.shows('Show the crew and the flight mode');
  screen.type('\r');
  await screen.hides('Show the crew and the flight mode');
  screen.type('\r');
  // The thread has no crew yet, so the list starts on the default.
  await screen.shows('› 4 Review heavy  default');
  assert.ok(screen.stdout.screen.includes('1 Solo'));
  assert.ok(screen.stdout.screen.includes('Crew: none'));
  screen.type('\r');
  await screen.shows('Crew: Review heavy.');
  const [thread] = (await client.listThreads()).threads;
  const read = (await client.readThread(thread.id)).thread;
  assert.equal(read.crew?.name, 'Review heavy');
  assert.deepEqual(
    read.crew?.members.map((member) => member.role),
    ['builder', 'reviewer'],
  );
  assert.equal(read.flightMode, 'balanced');
  // A digit applies the crew in that place.
  screen.type('2');
  await screen.shows('Crew: Tandem.');
  assert.equal((await client.readThread(thread.id)).thread.crew?.name, 'Tandem');
  screen.type('\u0003');
  await app.waitUntilExit();
});
