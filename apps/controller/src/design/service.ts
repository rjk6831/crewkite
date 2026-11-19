import {
  type Command,
  type CommandResult,
  canonicalJson,
  type DesignPreview,
  type DesignSystem,
  type DesignSystemDraft,
  type DesignSystemRead,
  type DesignSystemRecord,
  type DesignSystemSaved,
  DesignSystemSchema,
  TokenGroupSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { ADDED_RULE, addedProblem, commandWords } from '../chat/checks.ts';
import {
  type ProjectFileRefusal,
  projectFile,
  readText,
  writeAtomically,
} from '../host/project-file.ts';
import type { Store } from '../store/index.ts';
import { type DraftTurn, describeDraft } from './describe.ts';
import { importDraft, readSystemFile } from './import.ts';

// A project's design system is a file in the project, so people and every tool read one source.
// The controller records each version it saved, with its hash. Turns receive the recorded version,
// so an edit on disk reaches no turn until someone saves it. Saving writes one file in the
// person's working tree after they confirmed the diff. It commits nothing.

export type DesignCommand = Extract<
  Command,
  {
    command:
      | 'ReadDesignSystem'
      | 'ImportDesignSystem'
      | 'DraftDesignSystem'
      | 'SaveDesignSystem'
      | 'SetDesignSystemDelivery'
      | 'SetDesignPreview';
  }
>;
type Payload<T extends DesignCommand['command']> = Extract<
  DesignCommand,
  { command: T }
>['payload'];

/** The design commands that change something. They belong to a project, not a task. */
export const designMutations = [
  'DraftDesignSystem',
  'SaveDesignSystem',
  'SetDesignSystemDelivery',
  'SetDesignPreview',
];

export class DesignRefused extends Error {
  reason: string;
  next: string;
  constructor(reason: string, next: string) {
    super(next);
    this.reason = reason;
    this.next = next;
  }
}

export type DesignDeps = {
  store: Store;
  now: () => string;
  projectPath: (projectId: string) => string | undefined;
  /** Called inside the save's transaction once the new version is recorded. */
  saved?: (projectId: string, system: DesignSystem, versionHash: string) => void;
  /** The read-only turn a draft from a description runs. Absent means no provider can run it. */
  draftTurn?: DraftTurn;
};

export class DesignSystems {
  private readonly deps: DesignDeps;
  /** What `drafting` got back, for the draft command it commits next. */
  private drafted?: {
    payload: Payload<'DraftDesignSystem'>;
    outcome: DesignSystemDraft | DesignRefused;
  };

  constructor(deps: DesignDeps) {
    this.deps = deps;
  }

  /**
   * The record and the file against it. The system is the file's while it parses. A missing or
   * invalid file shows the saved version, and `next` names the file's first problem.
   */
  read(projectId: string): { read: DesignSystemRead; next?: string } {
    const root = this.root(projectId);
    const record = this.deps.store.designSystem(projectId) ?? null;
    if (!record) return { read: { projectId, record, system: null, file: null, preview: null } };
    const saved = this.deps.store.designSystemVersion(projectId, record.version)?.system ?? null;
    const preview = this.deps.store.designPreview(projectId);
    let text: string | undefined;
    try {
      const refuse = refusal(record.path);
      text = readText(projectFile(root, record.path, refuse), refuse);
    } catch (failure) {
      if (!(failure instanceof DesignRefused)) throw failure;
      return {
        read: { projectId, record, system: saved, file: 'invalid', preview },
        next: failure.next,
      };
    }
    if (text === undefined)
      return { read: { projectId, record, system: saved, file: 'missing', preview } };
    const parsed = readSystemFile(text);
    if ('error' in parsed)
      return {
        read: { projectId, record, system: saved, file: 'invalid', preview },
        next: `${record.path}: ${parsed.error} Fix the file, then import it again.`,
      };
    const file = hashCanonical(parsed.system) === record.versionHash ? 'current' : 'changed';
    return { read: { projectId, record, system: parsed.system, file, preview } };
  }

  /** Writes the file and records the next version. A stale expected version returns the current. */
  save(payload: Payload<'SaveDesignSystem'>): DesignSystemSaved | { stale: number } {
    const { projectId, path } = payload;
    const root = this.root(projectId);
    const record = this.deps.store.designSystem(projectId);
    const current = record?.version ?? 0;
    if (payload.expectedVersion !== current) return { stale: current };
    const system = DesignSystemSchema.parse(payload.body);
    const versionHash = hashCanonical(system);
    const refuse = refusal(path);
    const file = projectFile(root, path, refuse);
    const text = readText(file, refuse);
    if (text !== undefined) {
      const onDisk = readSystemFile(text);
      const hash = 'system' in onDisk ? hashCanonical(onDisk.system) : null;
      // The file may hold what was saved last, or exactly what is being saved. Anything else is
      // someone's edit, and writing over it would lose that edit.
      const ours = record?.path === path && hash === record.versionHash;
      if (!ours && hash !== versionHash)
        throw new DesignRefused(
          'design-file-changed',
          record?.path === path
            ? `${path} changed on disk since version ${current}. Load the file's version, then save again.`
            : `${path} already exists. Import it, or pick another path.`,
        );
    }
    // The file goes first. If recording fails after it, the file reads as changed and saving its
    // content records it. A record ahead of its file would name a version nobody can read.
    writeAtomically(file, `${JSON.stringify(system, null, 2)}\n`, refuse);
    const at = this.deps.now();
    const saved: DesignSystemRecord = {
      projectId,
      path,
      version: current + 1,
      versionHash,
      delivery: record?.delivery ?? true,
      updatedAt: at,
    };
    const previous = record && this.deps.store.designSystemVersion(projectId, record.version);
    this.deps.store.putDesignSystemVersion(projectId, saved.version, versionHash, system, at);
    this.deps.store.putDesignSystem(saved);
    this.deps.saved?.(projectId, system, versionHash);
    return { record: saved, ...diffSystems(previous ? previous.system : null, system) };
  }

  import(payload: Payload<'ImportDesignSystem'>): DesignSystemDraft {
    const { path, source } = payload;
    const refuse = refusal(path);
    const text = readText(projectFile(this.root(payload.projectId), path, refuse), refuse);
    if (text === undefined)
      throw new DesignRefused('design-file-missing', `${path} is not in the project.`);
    const draft = importDraft(source, text, path);
    if ('refused' in draft) throw new DesignRefused(draft.refused, draft.next);
    return { source, path, system: draft.system, skipped: draft.skipped };
  }

  /** The switch is not a version, and the record keeps the time of its last save. */
  setDelivery(projectId: string, enabled: boolean) {
    this.root(projectId);
    const record = this.deps.store.designSystem(projectId);
    if (!record)
      throw new DesignRefused(
        'design-system-not-found',
        'Save a design system for this project first.',
      );
    this.deps.store.putDesignSystem({ ...record, delivery: enabled });
  }

  /**
   * Declare the preview the screenshot check shoots, or remove it with null. The reviewer judges
   * the images by the saved system, so a project needs one first. The command is held to the
   * rules for a check command a person adds, and the address is kept as its origin.
   */
  setPreview(projectId: string, preview: DesignPreview | null) {
    const root = this.root(projectId);
    if (!this.deps.store.designSystem(projectId))
      throw new DesignRefused(
        'design-system-not-found',
        'Save a design system for this project first.',
      );
    let kept = preview;
    if (preview) {
      const words = commandWords(preview.command);
      const problem = words ? addedProblem(words, root) : ADDED_RULE;
      if (!words || problem)
        throw new DesignRefused('preview-command-refused', problem ?? ADDED_RULE);
      kept = { ...preview, command: words.join(' '), url: new URL(preview.url).origin };
    }
    this.deps.store.putDesignPreview(projectId, kept);
  }

  /**
   * Ask for a draft from a description before `commit` opens the command's transaction, so a slow
   * model holds up no other command. `commit` runs synchronously, and the draft command inside it
   * answers with this outcome, which its receipt keeps.
   */
  async drafting(
    payload: Payload<'DraftDesignSystem'>,
    commit: () => CommandResult,
  ): Promise<CommandResult> {
    let outcome: DesignSystemDraft | DesignRefused;
    try {
      const root = this.root(payload.projectId);
      const draft = await describeDraft(this.deps.draftTurn, { ...payload, root });
      outcome = 'refused' in draft ? new DesignRefused(draft.refused, draft.next) : draft;
    } catch (failure) {
      if (!(failure instanceof DesignRefused)) throw failure;
      outcome = failure;
    }
    this.drafted = { payload, outcome };
    try {
      return commit();
    } finally {
      this.drafted = undefined;
    }
  }

  /** The outcome `drafting` got for this payload. A draft saves nothing. */
  draft(payload: Payload<'DraftDesignSystem'>): DesignSystemDraft {
    const outcome = this.drafted?.payload === payload ? this.drafted.outcome : undefined;
    if (!outcome) throw new DesignRefused('design-draft-failed', 'Draft again.');
    if (outcome instanceof DesignRefused) throw outcome;
    return outcome;
  }

  private root(projectId: string) {
    const root = this.deps.projectPath(projectId);
    if (!root) throw new DesignRefused('project-not-found', 'Choose a registered project.');
    return root;
  }
}

export function designCommand(design: DesignSystems, command: DesignCommand): CommandResult {
  try {
    switch (command.command) {
      case 'ReadDesignSystem': {
        const { read, next } = design.read(command.payload.projectId);
        return {
          outcome: 'applied',
          data: { kind: 'design-system', ...read },
          ...(next && { next }),
        };
      }
      case 'ImportDesignSystem':
        return {
          outcome: 'applied',
          data: { kind: 'design-system-draft', ...design.import(command.payload) },
        };
      case 'SaveDesignSystem': {
        const saved = design.save(command.payload);
        return 'stale' in saved
          ? {
              outcome: 'stale-revision',
              revision: saved.stale,
              next: `The saved version is ${saved.stale}. Load it and review your changes against it.`,
            }
          : { outcome: 'applied', data: { kind: 'design-system-saved', ...saved } };
      }
      case 'SetDesignSystemDelivery':
        design.setDelivery(command.payload.projectId, command.payload.enabled);
        return { outcome: 'applied' };
      case 'SetDesignPreview':
        design.setPreview(command.payload.projectId, command.payload.preview);
        return { outcome: 'applied' };
      case 'DraftDesignSystem':
        return {
          outcome: 'applied',
          data: { kind: 'design-system-draft', ...design.draft(command.payload) },
        };
    }
  } catch (failure) {
    if (failure instanceof DesignRefused)
      return { outcome: 'blocked', reason: failure.reason, next: failure.next };
    throw failure;
  }
}

/**
 * What changed between two versions, by token path, `component:<id>` and `rule:<id>`. A rename
 * reads as one path removed and one added.
 */
export function diffSystems(before: DesignSystem | null, after: DesignSystem) {
  const entries = (system: DesignSystem | null) =>
    new Map<string, string>(
      system
        ? [
            ...TokenGroupSchema.options.flatMap((group) =>
              Object.entries(system.tokens[group]).map(
                ([name, token]) => [`${group}.${name}`, canonicalJson(token)] as const,
              ),
            ),
            ...system.components.map(
              (item) => [`component:${item.id}`, canonicalJson(item)] as const,
            ),
            ...system.rules.map((item) => [`rule:${item.id}`, canonicalJson(item)] as const),
          ]
        : [],
    );
  const old = entries(before);
  const next = entries(after);
  return {
    added: [...next.keys()].filter((key) => !old.has(key)),
    changed: [...next]
      .filter(([key, value]) => old.has(key) && old.get(key) !== value)
      .map(([key]) => key),
    removed: [...old.keys()].filter((key) => !next.has(key)),
  };
}

/** The design system's own words for a project file it cannot read or write. */
const refusal =
  (path: string): ProjectFileRefusal =>
  (problem) => {
    switch (problem.kind) {
      case 'folder-unavailable':
        return new DesignRefused(
          'project-folder-unavailable',
          'The project folder cannot be read.',
        );
      case 'path-unsafe':
        return new DesignRefused(
          'design-path-unsafe',
          `${path} must be a plain file inside the project, with no link on the way.`,
        );
      case 'too-large':
        return new DesignRefused('design-file-too-large', `${path} is larger than 1 MiB.`);
      case 'write-failed':
        return new DesignRefused(
          'design-write-failed',
          `The file could not be written: ${problem.code}. Nothing was saved.`,
        );
    }
  };
