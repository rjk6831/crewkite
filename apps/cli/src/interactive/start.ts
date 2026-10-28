import { render } from 'ink';
import { createElement as h } from 'react';
import { connectChat } from '../chat/connect.ts';
import { crewkiteHome, loadSettings, saveSettings } from '../settings.ts';
import { App } from './app.ts';

/** Opens the interactive CLI on this terminal and resolves with the exit code. */
export async function startInteractive(args: readonly string[]): Promise<number> {
  const at = args.indexOf('--home');
  const flag = at === -1 ? args.find((arg) => arg.startsWith('--home='))?.slice(7) : args[at + 1];
  const home = crewkiteHome(flag);
  let client: Awaited<ReturnType<typeof connectChat>>;
  try {
    client = await connectChat(home);
  } catch (failure) {
    process.stderr.write(
      `${failure instanceof Error ? failure.message : 'The controller is not reachable.'} Start the desktop or the controller first.\n`,
    );
    return 1;
  }
  const loaded = loadSettings(home);
  const instance = render(
    h(App, {
      client,
      settings: loaded.settings,
      settingsProblem: loaded.problem,
      saveSettings: (next) => saveSettings(home, next),
      animation: args.includes('--no-animation') ? 'off' : 'full',
      env: process.env,
    }),
    { exitOnCtrlC: false, patchConsole: true },
  );
  try {
    await instance.waitUntilExit();
    return 0;
  } finally {
    client.transport.close();
  }
}
