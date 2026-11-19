import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Artifact,
  ArtifactSchema,
  canonicalJson,
  type DesignPreview,
  ProjectCommandPreviewSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import type { ArtifactFiles } from '../artifacts/index.ts';
import { addedProblem, commandWords } from '../chat/checks.ts';
import { liveOperations } from '../commands/live-operations.ts';
import { OperationStore } from '../commands/operation-store.ts';
import { createOwnedProjectCommandRunner } from '../commands/owned-runner.ts';
import { startProjectCommand } from '../commands/project-command.ts';
import { executablePin } from '../commands/task-operations.ts';
import { inspectSource } from '../host/source.ts';
import { createIds } from '../store/ids.ts';
import type { LaunchIdentity, Store } from '../store/index.ts';

// The screenshot check. After a writing turn the controller starts the project's preview command
// in the scratch copy, captures each named view and hands the images to the reviewer with the
// design brief. This file holds the parts that do not depend on the chat service: running one
// capture pass, the owned preview process and the browser capture. The contract holds the rules
// for a declaration. The chat service decides when to run it and what the reviewer sees.

const IMAGE_BYTES = 8 * 1024 * 1024;
// Every view is shot at one size, so two runs of the same page compare.
const VIEWPORT = { width: 1280, height: 800 };
const READY_MS = 60_000;
const CAPTURE_MS = 30_000;

export type PreviewStart = (input: {
  taskId: string;
  projectId: string;
  directory: string;
  declaration: DesignPreview;
  /** Stop and quit abort it. A started preview stops, and one still starting gives up. */
  signal: AbortSignal;
}) => Promise<{ stop: () => Promise<void> }>;
/** The bytes of a PNG of one page. Throws a plain Error when there is no browser or it times out. */
export type Capture = (url: string) => Promise<Uint8Array>;

export type PreviewHost = {
  /** The project's declared preview, or null. */
  declared: (projectId: string) => DesignPreview | null;
  /** Without these the owned preview process and the Playwright capture below run. */
  start?: PreviewStart;
  capture?: Capture;
};

export type Shots =
  | { status: 'captured'; images: { name: string; bytes: Uint8Array }[] }
  | { status: 'failed'; reason: string };

const plain = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message.slice(0, 300) : fallback;

/**
 * One pass: start the preview, shoot every view, stop the preview. A failure at any step ends the
 * pass with a plain reason and the preview is stopped whatever happened. Nothing here starts a
 * model turn.
 */
export async function captureViews(
  host: Required<Pick<PreviewHost, 'start' | 'capture'>>,
  input: {
    taskId: string;
    projectId: string;
    directory: string;
    declaration: DesignPreview;
    signal: AbortSignal;
  },
): Promise<Shots> {
  const { declaration } = input;
  let preview: { stop: () => Promise<void> };
  try {
    preview = await host.start(input);
  } catch (error) {
    return { status: 'failed', reason: plain(error, 'The preview command did not start.') };
  }
  try {
    const images: { name: string; bytes: Uint8Array }[] = [];
    for (const view of declaration.views) {
      if (input.signal.aborted) return { status: 'failed', reason: 'You stopped it.' };
      const bytes = await host.capture(new URL(view.path, declaration.url).href);
      if (bytes.length > IMAGE_BYTES)
        return { status: 'failed', reason: `The ${view.name} view is larger than 8 MiB.` };
      images.push({ name: view.name, bytes });
    }
    return { status: 'captured', images };
  } catch (error) {
    return { status: 'failed', reason: plain(error, 'A view could not be captured.') };
  } finally {
    await preview.stop().catch(() => {});
  }
}

/** The text the reviewer reads next to the images. */
export function screenshotBrief(names: readonly string[], brief: string): string {
  return [
    `The project preview was captured after the last write. One image is attached for each view: ${names.join(', ')}. Judge each image against the design system below and report what breaks it, in the same findings format as the code review.`,
    brief,
  ].join('\n\n');
}

/**
 * The line for a capture that failed. Only Playwright's own timeout reads as a page that did not
 * load. The message names the URL, so a word in a path never decides it.
 */
export function captureFailure(error: unknown, url: string): string {
  return error instanceof Error && error.name === 'TimeoutError'
    ? `The page at ${url} did not load in ${CAPTURE_MS / 1000} seconds.`
    : plain(error, 'The page could not be captured.');
}

/** Playwright from the repository's own dependency. A missing package or browser is a failed step. */
export const playwrightCapture: Capture = async (url) => {
  let chromium: typeof import('@playwright/test').chromium;
  try {
    chromium = (await import('@playwright/test')).chromium;
  } catch {
    throw Error('Playwright is not installed, so the preview could not be captured.');
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch();
  } catch {
    throw Error('No browser is installed for Playwright, so the preview could not be captured.');
  }
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'load', timeout: CAPTURE_MS });
    // A redirect can lead off the preview to any server. Its page is not the project's.
    const landed = new URL(page.url()).origin;
    if (landed !== new URL(url).origin)
      throw Error(`The page at ${url} moved to ${landed}, so it was not captured.`);
    return await page.screenshot({ type: 'png', timeout: CAPTURE_MS });
  } catch (error) {
    throw Error(captureFailure(error, url));
  } finally {
    await browser.close().catch(() => {});
  }
};

type OwnedHost = {
  store: Store;
  artifacts: ArtifactFiles;
  home: string;
  now: () => string;
  launchIdentity?: LaunchIdentity;
  deadlineMs?: number;
  /** The recorded base commit of the thread's copy. */
  base: (taskId: string) => string | null;
  taskRevision: (taskId: string) => number;
  projectPath: (projectId: string) => string | undefined;
  /** Block the thread's turns until the recorded process groups are found gone. */
  holdOwnership: (taskId: string) => void;
};

const DEADLINE_MS = 10 * 60_000;
// Origins a running preview holds in this controller, so two passes never shoot one server.
const claimed = new Set<string>();

/** Whether anything answers HTTP at the address. A redirect counts as an answer and is not followed. */
async function answers(url: string, signal?: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(2000);
  try {
    await fetch(url, {
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the declared command in the scratch copy as an owned process: no shell, the program pinned
 * by its bytes, a journal row with each phase, the ten minute bound and the checks' rules for what
 * a command may name. Resolves once the preview answers on its address. `stop` ends the process
 * and settles the journal. A process whose exit cannot be confirmed holds the thread.
 *
 * The address must be free before the command starts. Otherwise the readiness poll would take
 * whatever already listens there, such as another project's server, for this preview.
 */
export function ownedPreview(host: OwnedHost): PreviewStart {
  const launch = launcher(host);
  return async (input) => {
    const origin = new URL(input.declaration.url).origin;
    const busy = Error(`Something already answers at ${origin}. Stop it or declare a free port.`);
    if (claimed.has(origin)) throw busy;
    claimed.add(origin);
    try {
      if (await answers(origin, input.signal)) throw busy;
      if (input.signal.aborted) throw Error('You stopped it.');
      const preview = await launch(input);
      return {
        stop: async () => {
          try {
            await preview.stop();
          } finally {
            claimed.delete(origin);
          }
        },
      };
    } catch (error) {
      // Every failure after the launch has already waited for the process to settle.
      claimed.delete(origin);
      throw error;
    }
  };
}

function launcher(host: OwnedHost): PreviewStart {
  const ids = createIds(host.now);
  const journal = new OperationStore(host.store, host.now, undefined, host.launchIdentity);
  return async ({ taskId, projectId, directory, declaration, signal }) => {
    const words = commandWords(declaration.command);
    if (!words || addedProblem(words, directory))
      throw Error('The preview command is not one CrewKite may run.');
    const root = host.projectPath(projectId);
    const base = host.base(taskId);
    if (!root || !base) throw Error('The project or its base commit is missing.');
    let pin: { path: string; sha256: string };
    try {
      pin = executablePin(words[0]);
    } catch {
      throw Error(`Could not find ${words[0]} on this computer.`);
    }
    const operationId = ids('cmd');
    const where = realpathSync(directory);
    const home = join(host.home, 'operations', operationId);
    mkdirSync(join(home, 'environment'), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, 'temporary'), { recursive: true, mode: 0o700 });
    const repositoryRoot = realpathSync(root);
    const deadlineMs = host.deadlineMs ?? DEADLINE_MS;
    const preview = ProjectCommandPreviewSchema.parse({
      version: 1,
      id: operationId,
      taskId,
      taskRevision: host.taskRevision(taskId),
      source: inspectSource(projectId, repositoryRoot),
      sourceMode: 'committed-head',
      repositoryRoot,
      scratchRoot: where,
      cwd: where,
      recipe: 'build',
      executable: pin.path,
      executableSha256: pin.sha256,
      executableIdentity: 'verified-prelaunch-sha256',
      argv: words.slice(1),
      environment: {
        CI: '1',
        LANG: 'C',
        NO_COLOR: '1',
        HOME: join(home, 'environment'),
        TMPDIR: join(home, 'temporary'),
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      },
      deadlineMs,
      nativeTrust: 'required',
    });
    const published = host.artifacts.publish(Buffer.from(canonicalJson(preview)));
    const definition: Artifact = ArtifactSchema.parse({
      id: ids('art'),
      ...published,
      mediaType: 'application/json',
    });
    journal.createAndBegin(
      { id: operationId, taskId, kind: 'project-command', definition },
      ids('cmd'),
      hashCanonical(preview),
      () => {},
      () => host.store.put('artifact', definition.id, 0, definition),
    );
    liveOperations.add(operationId);
    let execution: ReturnType<typeof startProjectCommand>;
    try {
      execution = startProjectCommand(
        {
          version: 1,
          operationId,
          recipe: 'build',
          source: { projectId, repositoryRoot, baseRevision: base },
          scratchRoot: where,
          cwd: where,
          executable: pin.path,
          executableIdentity: 'verified-prelaunch-sha256',
          executableSha256: pin.sha256,
          argv: preview.argv,
          environment: Object.fromEntries(
            Object.entries(preview.environment).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          ),
          output: { stdout: 'artifact', stderr: 'artifact', chunkBytes: 65536 },
        },
        {
          runner: createOwnedProjectCommandRunner({ deadlineMs }),
          lifecycle: {
            intent: () => void journal.phase(operationId, 'command', 'intent', null),
            owned: (group) => void journal.phase(operationId, 'command', 'owned', group),
            quiescent: (group) => void journal.phase(operationId, 'command', 'closed', group),
            unlaunched: () => void journal.unlaunched(operationId, 'command'),
          },
          publishStream: async (source, options) => {
            const bytes = await host.artifacts.publishStream(source, { signal: options?.signal });
            const artifact = ArtifactSchema.parse({
              id: ids('art'),
              ...bytes,
              mediaType: 'text/plain; charset=utf-8',
            });
            host.store.transaction(() => host.store.put('artifact', artifact.id, 0, artifact));
            return bytes;
          },
        },
      );
    } catch (error) {
      liveOperations.delete(operationId);
      try {
        journal.finish(
          operationId,
          { state: 'failed', reason: 'operation-failed', next: null },
          { outcome: 'blocked', reason: 'operation-failed' },
        );
      } catch {
        // Recovery reads the rows that are left.
      }
      throw error;
    }
    let exited = false;
    const settled = execution.result.then(
      async (result) => {
        exited = true;
        try {
          if (result.status === 'unknown') {
            journal.finish(
              operationId,
              { state: 'unknown', reason: 'operation-ownership-unknown', next: null },
              { outcome: 'blocked', reason: 'operation-ownership-unknown' },
            );
            host.holdOwnership(taskId);
          } else {
            journal.finish(
              operationId,
              {
                state: result.status === 'succeeded' ? 'succeeded' : result.status,
                reason: result.status === 'succeeded' ? 'exit-zero' : result.reason,
                next: null,
              },
              result.status === 'succeeded'
                ? { outcome: 'applied' }
                : { outcome: 'blocked', reason: result.reason },
            );
          }
        } catch {
          // Recovery reads the rows that are left.
        } finally {
          liveOperations.delete(operationId);
        }
        return result;
      },
      () => {
        exited = true;
        liveOperations.delete(operationId);
        host.holdOwnership(taskId);
        return null;
      },
    );
    const stop = async () => {
      execution.stop();
      await settled;
    };
    signal.addEventListener('abort', () => execution.stop(), { once: true });
    // Poll until the address answers. Any HTTP answer counts, so a preview that serves a 404 at
    // the root still passes and the view paths decide what the capture finds.
    const until = Date.now() + READY_MS;
    for (;;) {
      if (signal.aborted) {
        await stop();
        throw Error('You stopped it.');
      }
      if (exited) {
        const result = await settled;
        throw Error(
          result && result.status === 'failed' && result.reason === 'nonzero-exit'
            ? `The preview command ended with exit code ${result.code} before it answered.`
            : 'The preview command ended before it answered.',
        );
      }
      if (await answers(declaration.url, signal)) return { stop };
      if (Date.now() > until) {
        await stop();
        throw Error(`The preview did not answer at ${declaration.url} in 60 seconds.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
}
