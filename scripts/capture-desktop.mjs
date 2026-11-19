// Capture the README screenshot from the renderer preview. The preview runs the interface on
// scripted data with no controller, so the picture is stable from one machine to the next.
//
//   pnpm build && node scripts/capture-desktop.mjs [output-dir]
//   pnpm build && node scripts/capture-desktop.mjs <output-dir> design [name-prefix]
//   pnpm build && node scripts/capture-desktop.mjs <output-dir> github [name-prefix]
//   pnpm build && node scripts/capture-desktop.mjs <output-dir> work [name-prefix]
//   pnpm build && node scripts/capture-desktop.mjs <output-dir> states [name-prefix]
//   pnpm build && node scripts/capture-desktop.mjs <output-dir> setup [name-prefix]
//
// Needs the Playwright Chromium build: `pnpm exec playwright install chromium` once per machine,
// or CREWKITE_CHROMIUM set to an installed Chrome. Writes thread.png (dark) and settings.png (dark)
// to docs/images by default. The design mode writes every named state of the design system editor
// and the Design tab, in dark and light, plus the editor at 640 px wide. The github mode writes
// every state of the GitHub part of the Changes tab, in dark and light, plus a narrow window. The
// work mode writes the Work tab on a queued, running, dependency blocked and finished plan, in dark
// and light, with a row reached by the arrow keys, a thread held by a check with its release panel
// open, and a narrow window. The states mode writes each
// named state of the provider cards, Accept's required checks, the Work tab, the writing rules,
// feedback and API connections, in dark and light, some at the smallest window and some with
// keyboard focus. The setup mode writes the Project setup card in Settings with every part set up,
// with some set up and one read failing, and with nothing set up, in dark and light, at the three
// sizes the recipes mode uses.
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const renderer = join(root, 'apps/desktop/out/renderer');
const output = resolve(process.argv[2] ?? join(root, 'docs/images'));
const mode = process.argv[3] ?? 'readme';
const only = process.argv[4] ?? '';
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

// Each step drives the preview the way a person would, so a shot proves the path works.
const sheet = (page) => page.locator('dialog.ds-sheet');
const settings = async (page) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#settings-design-system').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
};
const editor = async (page) => {
  await settings(page);
  await page.getByRole('button', { name: 'Open editor' }).click();
  await sheet(page).locator('.ds-editor').waitFor();
};
const empty = (way) => async (page) => {
  await settings(page);
  await page.getByRole('button', { name: way }).click();
  await sheet(page).waitFor();
};
// A wide sheet lists the categories in its rail; a narrow one offers them in a Select.
const pick = async (page, name) => {
  const combobox = sheet(page).getByRole('combobox', { name: 'Category' });
  if (await combobox.isVisible()) await combobox.click();
  await sheet(page)
    .getByRole('option', { name: new RegExp(`^${name}`) })
    .click();
};
const category = (name) => async (page) => {
  await editor(page);
  await pick(page, name);
};
const returned = async (page) => {
  // Coming back to the window reads the file and the record again.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await sheet(page).locator('.ds-banner.is-warning').waitFor();
};
const token = (page, label) =>
  sheet(page).getByRole('button', { name: new RegExp(`^${label.replace('.', '\\.')},`) });
const edits = async (page) => {
  await editor(page);
  await token(page, 'color.accent').click();
  await sheet(page).getByLabel('Name', { exact: true }).fill('brand');
  await page.keyboard.press('Enter');
  await pick(page, 'Spacing');
  await token(page, 'spacing.3').click();
  await sheet(page).getByLabel('Value', { exact: true }).fill('16px');
  await page.keyboard.press('Enter');
  await pick(page, 'Radius');
  await token(page, 'radius.pill').click();
  await sheet(page).getByRole('button', { name: 'Remove radius' }).click();
};
const inspector = (tab) => async (page) => {
  await page.getByRole('button', { name: 'Toggle inspector' }).click();
  await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
  await page.waitForTimeout(300);
};
const bar = (page, name) =>
  page.getByRole('group', { name: 'Selected findings' }).getByRole('button', { name });
const findingRow = (page, location) =>
  page
    .locator('tr.ds-finding')
    .filter({ has: page.getByRole('button', { name: `Open ${location} in Changes` }) });

const states = [
  ['card-empty', 'design-empty', settings],
  ['card-record', 'design-record', settings],
  [
    'sheet-empty',
    'design-empty',
    async (page) => {
      await empty('Import from this project')(page);
      await sheet(page).getByRole('list', { name: 'Files found in this project' }).waitFor();
    },
  ],
  ['importing', 'design-probing', empty('Import from this project')],
  [
    'import-draft',
    'design-empty',
    async (page) => {
      await empty('Import from this project')(page);
      await sheet(page)
        .getByRole('button', { name: /src\/styles\/tokens\.css/ })
        .click();
    },
  ],
  [
    'template-crewkite',
    'design-empty',
    async (page) => {
      await empty('Start from a template')(page);
      await sheet(page)
        .getByRole('button', { name: /CrewKite tokens/ })
        .click();
    },
  ],
  [
    'describe',
    'design-empty',
    async (page) => {
      await empty('Describe it')(page);
      await sheet(page)
        .getByLabel('Describe colors, type and density.')
        .fill('Calm greys, one blue accent, dense tables.');
      await sheet(page).getByRole('button', { name: 'Draft', exact: true }).click();
      // The live region repeats the banner's sentence, so the wait names the banner.
      await sheet(page)
        .locator('.ds-banner.is-draft')
        .getByText('Draft from your description. Review every value before you save.')
        .waitFor();
    },
  ],
  [
    'describe-refused',
    'design-describe-refused',
    async (page) => {
      await empty('Describe it')(page);
      await sheet(page)
        .getByLabel('Describe colors, type and density.')
        .fill('Calm greys, one blue accent, dense tables.');
      await sheet(page).getByRole('button', { name: 'Draft', exact: true }).click();
      await sheet(page).getByText('Connect a provider in Settings, then draft again.').waitFor();
    },
  ],
  ['colors', 'design-record', editor],
  ['type', 'design-record', category('Type')],
  ['spacing', 'design-record', category('Spacing')],
  ['radius', 'design-record', category('Radius')],
  ['shadow', 'design-record', category('Shadow')],
  ['motion', 'design-record', category('Motion')],
  ['components', 'design-record', category('Components')],
  ['rules', 'design-record', category('Rules')],
  [
    'invalid-token',
    'design-record',
    async (page) => {
      await editor(page);
      await token(page, 'color.accent').click();
      await sheet(page).getByLabel('Value', { exact: true }).fill('#12345');
    },
  ],
  [
    'conflict',
    'design-conflict',
    async (page) => {
      await editor(page);
      await returned(page);
    },
  ],
  [
    'stale-version',
    'design-stale',
    async (page) => {
      await editor(page);
      await returned(page);
    },
  ],
  ['file-missing', 'design-missing', editor],
  ['file-invalid', 'design-invalid', editor],
  ['diff-live', 'design-record', edits],
  [
    'diff-review',
    'design-record',
    async (page) => {
      await edits(page);
      await page.keyboard.press('ControlOrMeta+s');
      await sheet(page).getByRole('heading', { name: 'Review version 5' }).waitFor();
    },
  ],
  [
    'saved',
    'design-record',
    async (page) => {
      await edits(page);
      await sheet(page).getByRole('button', { name: 'Review and save' }).click();
      await sheet(page).getByRole('button', { name: 'Save version 5' }).click();
      await sheet(page)
        .getByText(/^Version 5, saved/)
        .waitFor();
    },
  ],
  [
    'close-confirm',
    'design-record',
    async (page) => {
      await edits(page);
      await sheet(page).getByRole('button', { name: 'Close design system' }).click();
    },
  ],
  ['findings', 'findings', inspector('Design')],
  [
    'findings-menu',
    'findings',
    async (page) => {
      await inspector('Design')(page);
      await page.getByRole('button', { name: /^Actions for Raw color/ }).click();
    },
  ],
  [
    'findings-allow-once',
    'findings',
    async (page) => {
      await inspector('Design')(page);
      const row = findingRow(page, 'src/components/card.css:22');
      await row.focus();
      await page.keyboard.press('Space');
      await bar(page, 'Allow once').click();
      await page
        .getByRole('textbox', { name: /Why may 13px stay/ })
        .fill('The legacy header keeps 13px until it moves.');
    },
  ],
  [
    'findings-sent',
    'findings',
    async (page) => {
      await inspector('Design')(page);
      await findingRow(page, 'src/components/card.css:14').focus();
      await page.keyboard.press('Space');
      await bar(page, 'Send to fixer').click();
      await page.getByText(/on the fixer's next turn/).waitFor();
    },
  ],
  ['findings-states', 'findings-states', inspector('Design')],
  ['findings-empty', 'findings-empty', inspector('Design')],
  ['findings-no-check', 'findings-none', inspector('Design')],
  [
    'findings-running',
    'findings-running',
    async (page) => {
      await inspector('Design')(page);
      await page.getByRole('button', { name: 'Run again' }).click();
      await page.getByText('Checking changed files.').waitFor();
    },
  ],
  [
    'findings-error',
    'findings-error',
    async (page) => {
      await inspector('Design')(page);
      await page.getByRole('button', { name: 'Run again' }).first().click();
      await page.locator('.ds-findings-error').waitFor();
    },
  ],
  ['findings-cap', 'findings-cap', inspector('Design')],
  ['findings-older', 'findings-older', inspector('Design')],
  ['changes-counts', 'findings', inspector('Changes')],
  [
    'changes-at-line',
    'findings',
    async (page) => {
      await inspector('Design')(page);
      await page
        .getByRole('button', { name: 'Open src/components/card.css:22 in Changes' })
        .click();
      await page.locator('.th-hunk-line.is-target').waitFor();
    },
  ],
  [
    'update-system',
    'findings',
    async (page) => {
      await inspector('Design')(page);
      await findingRow(page, 'src/components/card.css:22').focus();
      await page.keyboard.press('Space');
      await bar(page, 'Update the system').click();
      await sheet(page)
        .getByText(/as a new token/)
        .waitFor();
    },
  ],
];
// States that need the keyboard's focus ring or a media setting the default window does not have.
// The fourth entry is extra context options.
states.push(
  ['motion-reduced', 'design-record', category('Motion'), { reducedMotion: 'reduce' }],
  [
    'path-refused',
    'design-empty',
    async (page) => {
      await empty('Start from a template')(page);
      await sheet(page)
        .getByRole('button', { name: /^Neutral/ })
        .click();
      await sheet(page).getByLabel('File', { exact: true }).fill('../outside.json');
    },
  ],
  [
    'filter-no-match',
    'design-record',
    async (page) => {
      await editor(page);
      await page.keyboard.press('ControlOrMeta+f');
      await page.waitForTimeout(100);
      await page.keyboard.type('teal');
    },
  ],
  [
    'focus-rail',
    'design-record',
    async (page) => {
      await editor(page);
      await sheet(page).getByRole('option', { selected: true }).focus();
      await page.keyboard.press('ArrowDown');
    },
  ],
  [
    'focus-swatch',
    'design-record',
    async (page) => {
      await editor(page);
      await sheet(page).getByRole('option', { selected: true }).focus();
      await page.keyboard.press('Enter');
    },
  ],
  [
    'focus-grid-row',
    'findings',
    async (page) => {
      await inspector('Design')(page);
      await page.locator('tr.ds-finding').first().focus();
      await page.keyboard.press('ArrowDown');
    },
  ],
);

// The narrow layout: the rail becomes a Select and the diff a panel behind a button.
const narrow = [
  ['narrow-editor', 'design-record', edits],
  [
    'narrow-changes',
    'design-record',
    async (page) => {
      await edits(page);
      await sheet(page)
        .getByRole('button', { name: /^Review changes/ })
        .click();
    },
  ],
  [
    'narrow-empty',
    'design-empty',
    async (page) => {
      await empty('Import from this project')(page);
      await sheet(page).getByRole('list', { name: 'Files found in this project' }).waitFor();
    },
  ],
];

// The GitHub part of the Changes tab. Each step opens Changes on a gh- preview state, drives it
// the way a person would and brings the part it shows into view.
const button = (page, name) => page.getByRole('button', { name, exact: true });
const into = async (locator) => {
  await locator.scrollIntoViewIfNeeded();
  await locator.page().waitForTimeout(150);
};
const changesTab = async (page) => {
  await inspector('Changes')(page);
  await page.getByText('Pushed feat/net-minor to origin').or(button(page, 'Push branch')).waitFor();
};
const proposed = async (page) => {
  await changesTab(page);
  await button(page, 'Open pull request').click();
  await page.getByText('Waiting for you').waitFor();
  await into(page.locator('.th-gh-write').first());
};
const confirmed = async (page, state) => {
  await proposed(page);
  await page.locator('.th-gh-write').getByRole('button', { name: 'Open pull request' }).click();
  await page.getByText(state, { exact: true }).waitFor();
  await into(page.locator('.th-gh-write').first());
};
const region = (page, name) => page.getByRole('region', { name });
const merging = async (page) => {
  await changesTab(page);
  await into(region(page, 'Merge'));
  await button(page, 'Squash and merge').click();
};
const githubStates = [
  [
    'push-confirm',
    'gh-push',
    async (page) => {
      await changesTab(page);
      await button(page, 'Push branch').click();
      await page.getByText(/^Push commit/).waitFor();
    },
  ],
  [
    'push-unknown',
    'gh-push-unknown',
    async (page) => {
      await changesTab(page);
      await button(page, 'Push branch').click();
      await button(page, 'Push').click();
      await page.getByText('Unknown', { exact: true }).waitFor();
      await into(page.locator('.th-gh-write').first());
    },
  ],
  [
    'push-settle',
    'gh-push-unknown',
    async (page) => {
      await changesTab(page);
      await button(page, 'Push branch').click();
      await button(page, 'Push').click();
      await button(page, 'Check').click();
      await button(page, 'I checked GitHub').click();
      await page.getByLabel('Mark as done on GitHub').check();
      await page.getByLabel('Note').fill('feat/net-minor is at c41f9a2 on GitHub.');
      await into(page.locator('.th-gh-settle'));
    },
  ],
  ['pr-proposed', 'gh-pr', proposed],
  [
    'pr-edit',
    'gh-pr',
    async (page) => {
      await proposed(page);
      await page.getByRole('button', { name: 'Edit title and description' }).click();
      await page.getByLabel('Title', { exact: true }).fill('feat: add netMinor with input checks');
      await page.getByLabel('Open as a draft').check();
      await into(page.locator('.th-gh-form'));
    },
  ],
  ['pr-sending', 'gh-pr-sending', (page) => confirmed(page, 'Sending')],
  ['pr-refused', 'gh-pr-refused', (page) => confirmed(page, 'Refused')],
  ['pr-unknown', 'gh-pr-unknown', (page) => confirmed(page, 'Unknown')],
  [
    'pr-checked',
    'gh-pr-unknown',
    async (page) => {
      await confirmed(page, 'Unknown');
      await button(page, 'Check').click();
      await page.getByText('Pull request #12').waitFor();
    },
  ],
  ['pr-open', 'gh-open', changesTab],
  ['pr-draft', 'gh-draft', changesTab],
  [
    'pr-ready-preview',
    'gh-draft',
    async (page) => {
      await changesTab(page);
      await button(page, 'Ready for review').click();
      await page.getByText('Waiting for you').waitFor();
      await into(page.locator('.th-gh-write').first());
    },
  ],
  [
    'pr-update-preview',
    'gh-open',
    async (page) => {
      await changesTab(page);
      await button(page, 'Update title and description').click();
      await page.getByLabel('Title', { exact: true }).fill('feat: add netMinor with input checks');
      await button(page, 'Preview update').click();
      await page.getByText('Waiting for you').waitFor();
      await into(page.locator('.th-gh-write').first());
    },
  ],
  [
    'rerun-preview',
    'gh-open',
    async (page) => {
      await changesTab(page);
      await button(page, 'Rerun failed jobs').click();
      await page.getByText('Waiting for you').waitFor();
      await into(page.locator('.th-gh-write').first());
    },
  ],
  [
    'comments',
    'gh-open',
    async (page) => {
      await changesTab(page);
      await into(region(page, 'Review comments'));
    },
  ],
  [
    'comments-sent',
    'gh-open',
    async (page) => {
      await changesTab(page);
      const comments = region(page, 'Review comments');
      await comments.getByRole('checkbox').nth(0).check();
      await comments.getByRole('checkbox').nth(2).check();
      await button(page, 'Send 2 to fixer').click();
      await page.getByText('2 comments sent to the fixer.').waitFor();
      await into(comments);
    },
  ],
  [
    'comments-moved',
    'gh-moved',
    async (page) => {
      await changesTab(page);
      await into(region(page, 'Review comments'));
    },
  ],
  [
    'reply-preview',
    'gh-open',
    async (page) => {
      await changesTab(page);
      const comments = region(page, 'Review comments');
      await comments.getByRole('button', { name: 'Reply' }).first().click();
      await comments
        .getByLabel('Reply to mira-k')
        .fill('Zero is what checkout shows today. I kept it and added a test for it.');
      await button(page, 'Preview reply').click();
      await page.getByText('Waiting for you').waitFor();
      await into(comments.locator('.th-gh-write'));
    },
  ],
  [
    'reply-done',
    'gh-open',
    async (page) => {
      await changesTab(page);
      const comments = region(page, 'Review comments');
      await comments.getByRole('button', { name: 'Reply' }).first().click();
      await comments
        .getByLabel('Reply to mira-k')
        .fill('Zero is what checkout shows today. I kept it and added a test for it.');
      await button(page, 'Preview reply').click();
      await button(page, 'Post reply').click();
      await comments.getByText('Done', { exact: true }).waitFor();
      await into(comments.locator('.th-gh-write'));
    },
  ],
  [
    'merge-waits-on-checks',
    'gh-open',
    async (page) => {
      await changesTab(page);
      await into(region(page, 'Merge'));
    },
  ],
  [
    'merge-head-moved',
    'gh-moved',
    async (page) => {
      await changesTab(page);
      await into(region(page, 'Merge'));
    },
  ],
  [
    'merge-ready',
    'gh-green',
    async (page) => {
      await changesTab(page);
      await into(region(page, 'Merge'));
    },
  ],
  [
    'merge-preview',
    'gh-green',
    async (page) => {
      await merging(page);
      await page.getByText('Waiting for you').waitFor();
      await into(region(page, 'Merge'));
    },
  ],
  [
    'merge-not-ready',
    'gh-blocked',
    async (page) => {
      await changesTab(page);
      await into(region(page, 'Merge'));
      await page.getByText(/^Branch protection blocks this merge/).waitFor();
    },
  ],
  [
    'merge-conflicts',
    'gh-conflict',
    async (page) => {
      await merging(page);
      await button(page, 'Resolve conflicts').waitFor();
      await into(region(page, 'Merge'));
    },
  ],
  [
    'merge-resolving',
    'gh-conflict',
    async (page) => {
      await merging(page);
      await button(page, 'Resolve conflicts').click();
      await page.getByText(/^The fixer resolves 1 file/).waitFor();
      await into(page.getByText(/^The merge with origin\/main waits in the copy/));
    },
  ],
  [
    'merge-unknown',
    'gh-merge-unknown',
    async (page) => {
      await merging(page);
      await button(page, 'Squash and merge c41f9a2').click();
      await page.getByText('Unknown', { exact: true }).waitFor();
      await into(region(page, 'Merge'));
    },
  ],
  [
    'merge-settle',
    'gh-merge-unknown',
    async (page) => {
      await merging(page);
      await button(page, 'Squash and merge c41f9a2').click();
      await page.getByText('Unknown', { exact: true }).waitFor();
      await button(page, 'Check').click();
      await button(page, 'I checked GitHub').click();
      await page.getByLabel('Mark as not sent').check();
      await page.getByLabel('Note').fill('PR #12 is still open and shows no merge.');
      await into(page.locator('.th-gh-settle'));
    },
  ],
  [
    'merge-settled',
    'gh-merge-unknown',
    async (page) => {
      await merging(page);
      await button(page, 'Squash and merge c41f9a2').click();
      await page.getByText('Unknown', { exact: true }).waitFor();
      await button(page, 'Check').click();
      await button(page, 'I checked GitHub').click();
      await page.getByLabel('Mark as not sent').check();
      await page.getByLabel('Note').fill('PR #12 is still open and shows no merge.');
      await button(page, 'Confirm').click();
      await page.getByText('Not sent', { exact: true }).waitFor();
      await into(region(page, 'Merge'));
    },
  ],
  [
    'merge-done',
    'gh-green',
    async (page) => {
      await merging(page);
      await button(page, 'Squash and merge c41f9a2').click();
      await page.getByText('Merged as 5a0e2d9, into main').waitFor();
    },
  ],
];
// The narrow window keeps the inspector beside a thread a third as wide.
const githubNarrow = ['push-confirm', 'pr-proposed', 'pr-open', 'comments', 'merge-preview'];

// The Work tab. Each step opens it on a work- preview state.
const slices = (page) => page.getByRole('list', { name: 'Slices' });
const workTab = async (page) => {
  await inspector('Work')(page);
  await slices(page).waitFor();
};
const workStates = [
  ['queued', 'work-queued', workTab],
  ['running', 'work-running', workTab],
  ['dependency-blocked', 'work-blocked', workTab],
  ['finished', 'work-finished', workTab],
  [
    'keyboard',
    'work-running',
    async (page) => {
      await workTab(page);
      await slices(page).getByRole('button').first().focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
    },
  ],
  [
    'held-release',
    'work-held',
    async (page) => {
      await inspector('Work')(page);
      await page.getByRole('button', { name: 'Release the thread' }).click();
      await page.getByRole('textbox', { name: 'What you checked' }).waitFor();
    },
  ],
];
const workNarrow = ['running', 'dependency-blocked'];

// The named states of the screens the checks, dependency, writing rule and feedback work touched.
// A state whose control is missing fails its step, and the run names it at the end.
const openSettings = (page) => page.getByRole('button', { name: 'Settings', exact: true }).click();
// Only the page's own scroll area moves. The preview banner makes the window one line taller than
// the app, so the window itself stays where it is.
const atTop = async (locator) => {
  await locator.evaluate((element) => {
    element.scrollIntoView({ block: 'start' });
    document.scrollingElement?.scrollTo(0, 0);
  });
  await locator.page().waitForTimeout(200);
};
const providerCard = (family) => async (page) => {
  await openSettings(page);
  await atTop(page.locator(`#st-card-${family}`));
};
const rulesCard = (page) =>
  page
    .locator('section.st-card')
    .filter({ has: page.getByRole('heading', { name: 'Writing rules' }) });
const rules = async (page) => {
  await openSettings(page);
  await atTop(rulesCard(page));
};
const rulesPreviewed = async (page) => {
  await rules(page);
  await rulesCard(page).getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('heading', { name: /rules block in AGENTS\.md/ }).waitFor();
  await atTop(page.getByRole('heading', { name: 'Export' }));
};
const feedback = async (page) => {
  await openSettings(page);
  await page.getByRole('button', { name: 'Send feedback' }).click();
  await page
    .getByLabel('What happened')
    .fill('The Work tab kept the stale line after I installed.');
  await page.getByLabel('App version').check();
  await atTop(page.getByRole('heading', { name: 'Feedback' }));
};
const accepting = async (page) => {
  await inspector('Changes')(page);
  await button(page, 'Accept to branch').click();
  await page.waitForTimeout(300);
  await into(page.locator('form.th-changes'));
};
const checksCard = async (page) => {
  await page.getByRole('region', { name: 'Checks' }).waitFor();
  await into(page.getByRole('region', { name: 'Checks' }));
};
const tabTo = async (locator) => {
  await locator.focus();
  await locator.page().keyboard.press('Shift+Tab');
  await locator.page().keyboard.press('Tab');
};
// The Checks card in the thread offers the same button, so these reach the Work tab's own.
const workPrepare = (page) =>
  page
    .getByRole('region', { name: 'Blocked by' })
    .getByRole('button', { name: 'Prepare dependencies' });
const prepared = async (page) => {
  await workTab(page);
  await workPrepare(page).click();
  // The Checks card and the Work tab share one Prepare, so both show how it ended.
  await page
    .getByText(/^Dependencies prepared/)
    .first()
    .waitFor();
};
// The way from a connected provider to the first accepted change: the welcome's last step, and
// the reply that edited a file once its permission is answered.
const welcome = async (page) => {
  await openSettings(page);
  await page.getByRole('button', { name: 'Show the welcome again' }).click();
  for (let step = 0; step < 3; step++) await button(page, 'Continue').click();
  await page.getByRole('heading', { name: 'Start with a message' }).waitFor();
};
const replied = async (page) => {
  // The queued message would start a new turn once this one ends.
  await page.getByRole('button', { name: /^Remove/ }).click();
  await page.getByRole('button', { name: /^Allow once/ }).click();
  await page.getByText(/^All three tests pass/).waitFor();
  await page.waitForTimeout(400);
};
// API connections: the Settings card from none to a checked connection, Forget's question in
// place, and Use API billing on the Crew tab's roles.
const connectionsCard = (page) =>
  page
    .locator('section.st-card')
    .filter({ has: page.getByRole('heading', { name: 'API connections' }) });
const connectionsSettings = async (page) => {
  await openSettings(page);
  await atTop(connectionsCard(page));
};
const connectionAdded = (family, label) => async (page) => {
  await connectionsSettings(page);
  const card = connectionsCard(page);
  if (family !== 'OpenAI') {
    await card.getByRole('combobox', { name: 'Provider' }).click();
    await page.getByRole('option', { name: family }).click();
  }
  await card.getByLabel('Label', { exact: true }).fill(label);
  await card.getByRole('button', { name: 'Add API connection' }).click();
  await card.getByRole('button', { name: 'Copy the sign-in line' }).waitFor();
  await atTop(card);
};
const connectionChecked = (family, label, outcome) => async (page) => {
  await connectionAdded(family, label)(page);
  const card = connectionsCard(page);
  await card.getByRole('button', { name: 'Check sign-in' }).click();
  await card.getByText(outcome).first().waitFor();
  await atTop(card);
};
const roleChoices = async (page) => {
  await inspector('Crew')(page);
  await page.getByRole('combobox', { name: 'Builder: Use API billing' }).click();
  await page.getByRole('option', { name: 'Client work (Anthropic)' }).waitFor();
};
const touched = [
  ['welcome-last-step', 'onboarding', welcome],
  ['reply-edited', 'onboarding', replied],
  ['provider-fresh', 'provider-fresh', providerCard('openai')],
  ['provider-stale', 'provider-stale', providerCard('openai')],
  ['provider-stale-google', 'provider-stale', providerCard('google')],
  ['provider-blocked', 'provider-blocked', providerCard('google')],
  ['provider-sign-in', 'provider-sign-in', providerCard('anthropic')],
  ['check-preparing', 'accept-preparing', accepting],
  ['check-running', 'accept-running', accepting],
  ['check-passed', 'accept-passed', accepting],
  ['check-failed', 'accept-failed', accepting],
  ['check-owner-unknown', 'accept-unknown', accepting],
  ['check-mutated', 'accept-mutated', accepting],
  ['check-preparation-stale', 'accept-stale', accepting],
  ['checks-card-stale', 'work-blocked', checksCard],
  ['graph-queued', 'work-queued', workTab],
  ['graph-running', 'work-running', workTab],
  ['graph-dependency-blocked', 'work-blocked', workTab],
  ['graph-finished', 'work-finished', workTab],
  ['graph-prepared', 'work-blocked', prepared],
  ['rules-settings', 'rules', rules],
  ['rules-export-preview', 'rules', rulesPreviewed],
  [
    'rules-stale-preview',
    'rules-stale',
    async (page) => {
      await rulesPreviewed(page);
      await page.getByRole('button', { name: 'Write file' }).click();
      await page.getByText(/changed since the preview/).waitFor();
    },
  ],
  ['feedback-preview', 'feedback', feedback],
  ['connections-empty', 'connections', connectionsSettings],
  ['connections-sign-in', 'connections', connectionAdded('OpenAI', 'Team key')],
  [
    'connections-ready',
    'connections',
    connectionChecked('OpenAI', 'Team key', 'Ready. The client reports API billing.'),
  ],
  [
    'connections-mismatch',
    'connections-mismatch',
    connectionChecked(
      'Anthropic',
      'Client work',
      'Sign-in changed. Reconnect this API connection.',
    ),
  ],
  [
    'connections-forget',
    'connections-ready',
    async (page) => {
      await connectionsSettings(page);
      await button(page, 'Forget').first().click();
      await page.getByText(/^Forget OpenAI API billing\?/).waitFor();
    },
  ],
  ['role-api-billing-choices', 'connections-ready', roleChoices],
  [
    'role-api-billing-assigned',
    'connections-ready',
    async (page) => {
      await roleChoices(page);
      await page.getByRole('option', { name: 'Client work (Anthropic)' }).click();
      await page.getByText('Provider charges apply.').first().waitFor();
    },
  ],
  // Keyboard focus: the first rule switch, a feedback box and the Prepare action, each reached by
  // Tab so the ring is the one a keyboard sees.
  [
    'focus-rules-switch',
    'rules',
    async (page) => {
      await rules(page);
      await tabTo(rulesCard(page).getByRole('switch').first());
    },
  ],
  [
    'focus-feedback',
    'feedback',
    async (page) => {
      await feedback(page);
      await tabTo(page.getByLabel('Operating system'));
    },
  ],
  [
    'focus-prepare',
    'work-blocked',
    async (page) => {
      await workTab(page);
      await tabTo(workPrepare(page));
    },
  ],
  [
    'focus-connection-copy',
    'connections',
    async (page) => {
      await connectionAdded('OpenAI', 'Team key')(page);
      await tabTo(page.getByRole('button', { name: 'Copy the sign-in line' }));
    },
  ],
];
// The smallest window the app allows.
const touchedNarrow = [
  'provider-sign-in',
  'check-failed',
  'check-preparation-stale',
  'graph-dependency-blocked',
  'rules-export-preview',
  'feedback-preview',
  'connections-sign-in',
  'role-api-billing-assigned',
];

// The Recipes page's named states. Each opens the page from the rail and then takes its step.
const openRecipes = (page) => page.getByRole('button', { name: 'Recipes', exact: true }).click();
const recipe =
  (step = async () => {}) =>
  async (page) => {
    await openRecipes(page);
    await page.getByRole('heading', { name: 'Steps' }).waitFor();
    await step(page);
  };
const editRecipe = async (page) => {
  await page.getByRole('spinbutton', { name: 'Most slices' }).fill('6');
  await page.getByRole('button', { name: 'Add check' }).click();
  await page.getByRole('textbox', { name: 'Check 3 command' }).fill('pnpm build');
};
const reviewRecipe = async (page) => {
  await editRecipe(page);
  await page.getByRole('button', { name: 'Review changes' }).click();
  await page.getByRole('heading', { name: 'Review changes' }).waitFor();
};
const saveRecipe = (waitFor) => async (page) => {
  await reviewRecipe(page);
  await page.getByRole('button', { name: /^Save version/ }).click();
  await page.getByText(waitFor).first().waitFor();
};
const schedules = (step) => async (page) => {
  await openRecipes(page);
  await page.getByRole('tab', { name: 'Loops' }).click();
  await step(page);
};
const resultsView = (step) => async (page) => {
  await openRecipes(page);
  await page.getByRole('tab', { name: 'Results' }).click();
  await step(page);
};
const recipeStates = [
  [
    'empty',
    'recipes-empty',
    async (page) => {
      await openRecipes(page);
      await page.getByText('No recipes in this project yet.').waitFor();
    },
  ],
  ['clean', 'recipes-clean', recipe()],
  ['edited', 'recipes-clean', recipe(editRecipe)],
  [
    'problem',
    'recipes-clean',
    recipe(async (page) => {
      await page.getByRole('combobox', { name: 'Starts' }).click();
      await page.getByRole('option', { name: 'Every' }).click();
      await page.getByRole('button', { name: 'Review changes' }).click();
      await page.getByText('A loop needs a run limit.').first().waitFor();
    }),
  ],
  ['review', 'recipes-clean', recipe(reviewRecipe)],
  ['review-schedule', 'recipes-schedule', recipe(reviewRecipe)],
  ['saved', 'recipes-clean', recipe(saveRecipe(/Saved version 5\./))],
  ['stale', 'recipes-stale', recipe(saveRecipe(/saved again as version 5 while you edited/))],
  ['refused', 'recipes-refused', recipe(saveRecipe(/changed on disk since the last save/))],
  ['changed-edits', 'recipes-moved', recipe(saveRecipe(/changed on disk since the last save/))],
  [
    'reverted',
    'recipes-clean',
    recipe(async (page) => {
      await page.getByRole('spinbutton', { name: 'Most slices' }).fill('6');
      await page.getByRole('button', { name: 'Review changes' }).click();
      await page.getByRole('button', { name: 'Revert' }).click();
      await page.getByText('Nothing differs from version 4.', { exact: true }).waitFor();
    }),
  ],
  [
    'forget-edits',
    'recipes-clean',
    recipe(async (page) => {
      await editRecipe(page);
      await page.getByRole('button', { name: 'Forget this recipe' }).click();
      await page.getByText('Your unsaved changes go with it.').waitFor();
    }),
  ],
  [
    'run',
    'recipes-clean',
    recipe(async (page) => {
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await page
        .getByRole('textbox', { name: 'Request' })
        .fill('Clamp the discount at zero and add a test for it.');
    }),
  ],
  [
    'version',
    'recipes-clean',
    recipe(async (page) => {
      await page.getByRole('combobox', { name: 'Version' }).click();
      await page.getByRole('option', { name: /^3,/ }).click();
      await page.getByText('Version 3 of 4. Read only.').waitFor();
    }),
  ],
  [
    'report',
    'recipes-clean',
    recipe(async (page) => {
      await page.getByRole('button', { name: /Audit report/ }).click();
      await page.getByText('End with the report.').waitFor();
    }),
  ],
  [
    'new',
    'recipes-clean',
    recipe(async (page) => {
      await page.getByRole('button', { name: 'New recipe' }).click();
      await page.getByText('Not saved yet').waitFor();
    }),
  ],
  [
    'leave',
    'recipes-clean',
    recipe(async (page) => {
      await editRecipe(page);
      await page.getByRole('button', { name: /Audit report/ }).click();
      await page.getByRole('button', { name: 'Keep editing' }).waitFor();
    }),
  ],
  [
    'keyboard',
    'recipes-clean',
    recipe(async (page) => {
      await page.getByRole('button', { name: /Build and review/ }).focus();
      await page.keyboard.press('ArrowDown');
    }),
  ],
  ['not-ready', 'recipes-not-ready', recipe()],
  ['unrecorded', 'recipes-unrecorded', recipe()],
  ['changed', 'recipes-changed', recipe()],
  [
    'changed-file',
    'recipes-changed',
    recipe(async (page) => {
      await page.getByRole('button', { name: "Review the file's version" }).click();
      await page.getByText("This is the file's version, read only.").waitFor();
    }),
  ],
  ['missing', 'recipes-missing', recipe()],
  [
    'invalid',
    'recipes-invalid',
    async (page) => {
      await openRecipes(page);
      await page
        .getByText(/no longer reads as a recipe/)
        .first()
        .waitFor();
    },
  ],
  ['schedule', 'recipes-schedule', recipe()],
  ['paused', 'recipes-paused', recipe()],
  ['stopped', 'recipes-stopped', recipe()],
  [
    'schedules',
    'recipes-schedules',
    schedules(async (page) => {
      await page.getByRole('button', { name: 'Open Build and review' }).waitFor();
    }),
  ],
  [
    'schedules-empty',
    'recipes-schedules-empty',
    schedules(async (page) => {
      await page.getByText('No loops. Give a recipe a trigger to add one.').waitFor();
    }),
  ],
  [
    'schedules-refused',
    'recipes-schedules-refused',
    schedules(async (page) => {
      await page.getByRole('button', { name: 'Resume Nightly fixes' }).click();
      await page
        .getByText('The recipe file changed on disk. Review it and save, then try again.')
        .waitFor();
    }),
  ],
  [
    'schedules-other',
    'recipes-schedules',
    schedules(async (page) => {
      await page.getByRole('button', { name: 'Open Dependency bumps' }).click();
      await page.getByText(/could not read this project's recipes/).waitFor();
    }),
  ],
  [
    'results',
    'recipes-results',
    resultsView(async (page) => {
      await page.getByRole('heading', { name: 'By role and model' }).waitFor();
    }),
  ],
  [
    'results-export',
    'recipes-results',
    resultsView(async (page) => {
      await page.getByRole('button', { name: 'Export JSON' }).click();
      await page.getByText('Wrote 43 records to crewkite-results.json.').waitFor();
    }),
  ],
  [
    'results-export-cancelled',
    'recipes-results-cancelled',
    resultsView(async (page) => {
      await page.getByRole('button', { name: 'Export JSON' }).click();
      await page.waitForTimeout(300);
    }),
  ],
  [
    'results-export-failed',
    'recipes-results-failed',
    resultsView(async (page) => {
      await page.getByRole('button', { name: 'Export JSON' }).click();
      await page.getByText('The file could not be written there. Choose another place.').waitFor();
    }),
  ],
  [
    'results-empty',
    'recipes-results-empty',
    resultsView(async (page) => {
      await page.getByText('No results yet. They start with the next plan run.').waitFor();
    }),
  ],
  [
    'draft',
    'work-finished',
    async (page) => {
      await workTab(page);
      await page.getByRole('button', { name: 'Save as recipe' }).click();
      await page.getByText(/^Drafted from/).waitFor();
    },
  ],
];
// The Project setup card's named states. Each opens Settings and waits until every row has read.
const setupCard = (line) => async (page) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const card = page.locator('section[aria-labelledby="settings-project-setup"]');
  await card.getByText(line).waitFor();
  await page.waitForFunction(
    () => !document.querySelector('.st-setup')?.textContent?.includes('Reading.'),
  );
  // Only the settings column scrolls, so the rail stays where it is.
  await card.evaluate((node) => {
    const column = node.closest('.settings-page');
    if (column)
      column.scrollTop +=
        node.getBoundingClientRect().top - column.getBoundingClientRect().top - 16;
  });
};
const setupStates = [
  ['setup-full', 'setup-full', setupCard(/steps recorded/)],
  ['setup-partial', 'setup-partial', setupCard(/Could not be read/)],
  ['setup-empty', 'setup-empty', setupCard('No loops.')],
];
const recipeNarrow = [
  'clean',
  'schedule',
  'paused',
  'problem',
  'review-schedule',
  'changed',
  'changed-file',
  'unrecorded',
  'version',
  'new',
  'leave',
  'run',
  'stale',
  'changed-edits',
  'reverted',
  'draft',
  'schedules',
  'schedules-empty',
  'schedules-refused',
  'results',
  'results-empty',
];

const browser = await chromium.launch(
  process.env.CREWKITE_CHROMIUM ? { executablePath: process.env.CREWKITE_CHROMIUM } : {},
);
async function open(theme, query, viewport, options = {}) {
  const context = await browser.newContext({ viewport, ...options });
  const page = await context.newPage();
  await page.addInitScript((mode) => {
    try {
      localStorage.setItem('crewkite-theme-mode', mode);
    } catch {}
  }, theme);
  await page.goto(`http://127.0.0.1:${port}/index.html?preview=1${query}`);
  await page.getByText('Preview data', { exact: true }).waitFor();
  return { context, page };
}
try {
  if (mode === 'design') {
    const wide = { width: 1440, height: 900 };
    const runs = [
      ...states.flatMap(([name, state, step, options]) =>
        ['dark', 'light'].map((theme) => [`${name}-${theme}`, state, step, theme, wide, options]),
      ),
      ...narrow.flatMap(([name, state, step]) =>
        ['dark', 'light'].map((theme) => [
          `${name}-${theme}`,
          state,
          step,
          theme,
          { width: 640, height: 900 },
        ]),
      ),
    ].filter(([name]) => name.startsWith(only));
    for (const [name, state, step, theme, viewport, options] of runs) {
      const { context, page } = await open(theme, `&state=${state}`, viewport, options);
      await page.waitForTimeout(400);
      await step(page);
      // The pointer rests outside the window, so no hover state lands in the shot.
      await page.mouse.move(viewport.width - 1, viewport.height - 1);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(output, `${name}.png`), animations: 'disabled' });
      await context.close();
    }
    console.log(`Wrote ${runs.length} design states to ${output}`);
  } else if (mode === 'github' || mode === 'work') {
    const [named, narrowNames, label] =
      mode === 'github' ? [githubStates, githubNarrow, 'GitHub'] : [workStates, workNarrow, 'Work'];
    const sizes = [
      ['', { width: 1440, height: 900 }],
      ['narrow-', { width: 960, height: 900 }],
    ];
    const runs = sizes
      .flatMap(([prefix, viewport]) =>
        named
          .filter(([name]) => !prefix || narrowNames.includes(name))
          .flatMap(([name, state, step]) =>
            ['dark', 'light'].map((theme) => [
              `${prefix}${name}-${theme}`,
              state,
              step,
              theme,
              viewport,
            ]),
          ),
      )
      .filter(([name]) => name.startsWith(only));
    for (const [name, state, step, theme, viewport] of runs) {
      const { context, page } = await open(theme, `&state=${state}`, viewport);
      await page.waitForTimeout(400);
      await step(page);
      await page.mouse.move(viewport.width - 1, viewport.height - 1);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(output, `${name}.png`), animations: 'disabled' });
      await context.close();
    }
    console.log(`Wrote ${runs.length} ${label} states to ${output}`);
  } else if (mode === 'states' || mode === 'recipes' || mode === 'setup') {
    // The Recipes page turns to one column under 960, so its narrow shots sit below that.
    const [states, narrow, small] =
      mode === 'recipes'
        ? [recipeStates, recipeNarrow, { width: 900, height: 900 }]
        : mode === 'setup'
          ? [setupStates, setupStates.map(([name]) => name), { width: 900, height: 900 }]
          : [touched, touchedNarrow, { width: 1080, height: 700 }];
    const sizes = [
      ['', { width: 1440, height: 900 }],
      ['narrow-', small],
      // The smallest window the app allows keeps the list beside a one-column recipe.
      ...(mode !== 'states' ? [['smallest-', { width: 1080, height: 700 }]] : []),
    ];
    const runs = sizes
      .flatMap(([prefix, viewport]) =>
        states
          .filter(([name]) => !prefix || narrow.includes(name))
          .flatMap(([name, state, step]) =>
            ['dark', 'light'].map((theme) => [
              `${prefix}${name}-${theme}`,
              state,
              step,
              theme,
              viewport,
            ]),
          ),
      )
      .filter(([name]) => name.startsWith(only));
    const failed = [];
    for (const [name, state, step, theme, viewport] of runs) {
      const { context, page } = await open(theme, `&state=${state}`, viewport);
      // A missing control fails its state in seconds, so one gap does not hold the run.
      page.setDefaultTimeout(8000);
      try {
        await page.waitForTimeout(400);
        await step(page);
        await page.mouse.move(viewport.width - 1, viewport.height - 1);
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(output, `${name}.png`), animations: 'disabled' });
      } catch (error) {
        failed.push(`${name}: ${error.message.split('\n')[0]}`);
      } finally {
        await context.close();
      }
    }
    console.log(`Wrote ${runs.length - failed.length} states to ${output}`);
    if (failed.length) {
      console.log(`Not written:\n${failed.join('\n')}`);
      process.exitCode = 1;
    }
  } else {
    const { context, page } = await open('dark', '', { width: 1440, height: 900 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(output, 'thread.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(output, 'settings.png'), animations: 'disabled' });
    await context.close();
    console.log(`Wrote thread.png and settings.png to ${output}`);
  }
} finally {
  await browser.close();
  server.close();
}
