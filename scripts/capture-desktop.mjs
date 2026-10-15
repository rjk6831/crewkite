import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';
import { prepareStateDirectory } from './demo-state.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const internal = existsSync(join(root, 'internal/tools'))
  ? dirname(realpathSync(join(root, 'internal/tools')))
  : join(root, 'internal');
if (!process.env.CREWKITE_HOME) throw new Error('Choose the connected journey home to capture.');
const home = realpathSync(process.env.CREWKITE_HOME);
if (!home.startsWith(`${internal}/`)) throw new Error('Capture a repository-contained demo home.');
const profile = join(home, 'capture-profile');
const require = createRequire(join(root, 'apps/desktop/package.json'));
const application = await _electron.launch({
  executablePath: require('electron'),
  args: [join(root, 'apps/desktop')],
  env: {
    PATH: process.env.PATH,
    ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
    ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
    CREWKITE_HOME: home,
    CREWKITE_PROFILE: profile,
    CREWKITE_SOURCE_NODE: process.execPath,
    CREWKITE_SOURCE_NODE_HASH: createHash('sha256')
      .update(readFileSync(process.execPath))
      .digest('hex'),
  },
  timeout: 15000,
});
try {
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByText('Controller connected', { exact: true }).waitFor();
  await page
    .getByRole('heading', { name: 'Add netMinor(subtotalMinor, discountMinor)', exact: true })
    .waitFor();
  await page.getByRole('tab', { name: 'Checks and review', exact: true }).click();
  const output = join(internal, 'screenshots');
  prepareStateDirectory(internal, output);
  for (const theme of ['dark', 'light']) {
    if ((await page.locator('html').getAttribute('data-theme')) !== theme)
      await page.getByRole('button', { name: `Switch to ${theme} theme`, exact: true }).click();
    await page.screenshot({ path: join(output, `workspace-${theme}.png`), animations: 'disabled' });
  }
  console.log(`Connected 1440x900 screenshots: ${output}`);
} finally {
  await application.close();
}
