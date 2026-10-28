// Capture the README screenshot from the renderer preview. The preview runs the interface on
// scripted data with no controller, so the picture is stable from one machine to the next.
//
//   pnpm build && node scripts/capture-desktop.mjs [output-dir]
//
// Needs the Playwright Chromium build: `pnpm exec playwright install chromium` once per machine.
// Writes thread.png (dark) and settings.png (dark) to docs/images by default.
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const renderer = join(root, 'apps/desktop/out/renderer');
const output = resolve(process.argv[2] ?? join(root, 'docs/images'));
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://preview').pathname;
  try {
    const body = await readFile(join(renderer, path === '/' ? 'index.html' : path));
    response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const { port } = server.address();
mkdirSync(output, { recursive: true });

const browser = await chromium.launch(
  process.env.CREWKITE_CHROMIUM ? { executablePath: process.env.CREWKITE_CHROMIUM } : {},
);
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem('crewkite-theme-mode', 'dark');
    } catch {}
  });
  await page.goto(`http://127.0.0.1:${port}/index.html?preview=1`);
  await page.getByText('Preview data', { exact: true }).waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(output, 'thread.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(output, 'settings.png'), animations: 'disabled' });
  await context.close();
  console.log(`Wrote thread.png and settings.png to ${output}`);
} finally {
  await browser.close();
  server.close();
}
