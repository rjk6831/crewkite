import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  type Command,
  type CommandResult,
  ExportWritingRulesPayloadSchema,
  PreviewWritingRulesExportPayloadSchema,
  WRITING_RULES,
  WRITING_RULES_CATALOGUE_VERSION,
  WRITING_RULES_EXPORT_BYTES,
  type WritingRulesExport,
} from '@crewkite/contracts';
import { hashCanonical, writingRuleDigest } from '@crewkite/contracts/hash';
import type { Store } from '../store/index.ts';

// Export of the selected writing rules to a file in the project, for tools that read one. The
// person sees the exact text and the destination first. The write refuses when the rules or the
// file changed after that preview, and it commits nothing.

export type WritingRulesExportCommand = Extract<
  Command,
  { command: 'PreviewWritingRulesExport' | 'ExportWritingRules' }
>;

export type WritingRulesExportDeps = {
  store: Pick<Store, 'writingRules'>;
  projectPath: (projectId: string) => string | undefined;
};

export const START_MARKER = '<!-- writing-rules:start -->';
export const END_MARKER = '<!-- writing-rules:end -->';

class Refused extends Error {
  reason: string;
  constructor(reason: string, next: string) {
    super(next);
    this.reason = reason;
  }
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Settings rules that are on, plus an export-only rule only when its own row says on. */
function selectedRules(rows: readonly { ruleId: string; enabled: boolean }[]) {
  const chosen = new Map(rows.map((row) => [row.ruleId, row.enabled]));
  return WRITING_RULES.filter((rule) =>
    rule.surface === 'export-only'
      ? chosen.get(rule.id) === true
      : (chosen.get(rule.id) ?? rule.defaultEnabled),
  );
}

function ruleBlock(rules: typeof WRITING_RULES) {
  return [
    START_MARKER,
    '## Writing rules',
    '',
    'The first rule restates the contribution ladder from Ponytail, which is MIT licensed. The pinned source and the notice are in docs/credits.md of the CrewKite repository.',
    '',
    ...rules.map((rule) => `- ${rule.text}`),
    END_MARKER,
  ].join('\n');
}

/** The file for a project-relative path. A link anywhere on the way refuses. */
function projectFile(root: string, path: string) {
  let base: string;
  try {
    base = realpathSync.native(root);
  } catch {
    throw new Refused('project-folder-unavailable', 'The project folder cannot be read.');
  }
  const parts = path.split('/');
  for (let end = 1; end <= parts.length; end++) {
    const state = lstatSync(join(base, ...parts.slice(0, end)), { throwIfNoEntry: false });
    if (!state) break;
    const last = end === parts.length;
    if (state.isSymbolicLink() || (last ? !state.isFile() : !state.isDirectory()))
      throw new Refused(
        'export-path-unsafe',
        `${path} must be a plain file inside the project, with no link on the way.`,
      );
  }
  return join(base, ...parts);
}

function build(
  deps: WritingRulesExportDeps,
  payload: { projectId: string; destination: string },
): { file: string; preview: WritingRulesExport } {
  const root = deps.projectPath(payload.projectId);
  if (!root) throw new Refused('project-not-found', 'Choose a registered project.');
  const file = projectFile(root, payload.destination);
  const picked = selectedRules(deps.store.writingRules());
  const block = ruleBlock(picked);
  const digest = writingRuleDigest(
    picked.map((rule) => rule.id),
    WRITING_RULES,
    WRITING_RULES_CATALOGUE_VERSION,
  );

  const current = lstatSync(file, { throwIfNoEntry: false });
  let existing: Buffer | undefined;
  if (current) {
    if (current.size > WRITING_RULES_EXPORT_BYTES)
      throw new Refused(
        'export-too-large',
        `${payload.destination} is larger than the 64 KiB an export can carry.`,
      );
    existing = readFileSync(file);
  }

  let text = `${block}\n`;
  if (existing) {
    const old = existing.toString('utf8');
    const start = old.indexOf(START_MARKER);
    const end = old.indexOf(END_MARKER);
    if (start === -1 && end === -1) {
      text = old === '' ? `${block}\n` : `${old}${old.endsWith('\n') ? '' : '\n'}\n${block}\n`;
    } else if (
      start === -1 ||
      end < start ||
      old.indexOf(START_MARKER, start + 1) !== -1 ||
      old.indexOf(END_MARKER, end + 1) !== -1
    ) {
      throw new Refused(
        'export-markers-unclear',
        `${payload.destination} has a writing-rules marker without a matching pair. Fix or remove it and preview again.`,
      );
    } else text = `${old.slice(0, start)}${block}${old.slice(end + END_MARKER.length)}`;
  }
  if (Buffer.byteLength(text) > WRITING_RULES_EXPORT_BYTES)
    throw new Refused('export-too-large', 'The result is larger than 64 KiB. Nothing was written.');

  const mode = existing ? 'patch' : 'new-file';
  return {
    file,
    preview: {
      destination: payload.destination,
      mode,
      preview: text,
      previewHash: hashCanonical({ destination: payload.destination, mode, preview: text, digest }),
      destinationIdentity: { exists: !!existing, sha256: existing ? sha256(existing) : null },
    },
  };
}

/** A new file is linked into place so a file that appeared since the preview is never replaced. */
function writeAtomically(file: string, text: string, mode: 'new-file' | 'patch') {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o644 });
    // shortcut: a patch can still lose a race between the digest check and the rename. Upgrade: hold a lock on the file.
    if (mode === 'patch') {
      // The rename puts a new file in place, so it takes the mode the file had: a private file
      // stays private and a script stays executable.
      chmodSync(temporary, lstatSync(file).mode & 0o777);
      renameSync(temporary, file);
    } else linkSync(temporary, file);
  } catch (failure) {
    throw new Refused(
      'export-write-failed',
      `The file could not be written: ${(failure as NodeJS.ErrnoException).code ?? 'unknown error'}. Nothing was changed.`,
    );
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writingRulesExportCommand(
  deps: WritingRulesExportDeps,
  command: WritingRulesExportCommand,
): CommandResult {
  try {
    if (command.command === 'PreviewWritingRulesExport') {
      const payload = PreviewWritingRulesExportPayloadSchema.safeParse(command.payload);
      if (!payload.success)
        throw new Refused(
          'export-path-unsafe',
          'The destination must be a path inside the project.',
        );
      return {
        outcome: 'applied',
        data: { kind: 'writing-rules-export', ...build(deps, payload.data).preview },
      };
    }
    const payload = ExportWritingRulesPayloadSchema.safeParse(command.payload);
    if (!payload.success)
      throw new Refused('export-path-unsafe', 'The destination must be a path inside the project.');
    const { file, preview } = build(deps, payload.data);
    // A retry after the write landed but before its receipt was saved finds the file already
    // holding exactly this text. Nothing is left to write, so it answers applied.
    if (
      preview.destinationIdentity.sha256 !== null &&
      preview.destinationIdentity.sha256 === sha256(Buffer.from(preview.preview))
    )
      return { outcome: 'applied' };
    if (preview.destinationIdentity.sha256 !== payload.data.expectedDestination)
      throw new Refused(
        'export-destination-changed',
        `${payload.data.destination} changed after the preview. Preview again.`,
      );
    if (preview.previewHash !== payload.data.previewHash)
      throw new Refused(
        'export-preview-stale',
        'The rules or the file changed since the preview. Preview again.',
      );
    writeAtomically(file, preview.preview, preview.mode);
    return { outcome: 'applied' };
  } catch (failure) {
    if (failure instanceof Refused)
      return { outcome: 'blocked', reason: failure.reason, next: failure.message };
    throw failure;
  }
}
