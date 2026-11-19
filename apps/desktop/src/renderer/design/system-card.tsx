import { useEffect, useId, useRef, useState } from 'react';
import { formatLocalTime } from '../format-time.ts';
import { Select } from '../select.tsx';
import {
  type DesignRead,
  readDesignSystem,
  setDesignDelivery,
  type ThreadSource,
} from '../thread/commands.ts';
import { type SheetRequest, useDesignSystems } from './context.ts';
import { plainProblem } from './start.ts';
import '../thread/subagents.css';
import './design.css';

/** The three ways to start, each in one sentence. The card and the empty editor share them. */
export const START_WAYS: readonly {
  id: NonNullable<SheetRequest['start']>;
  label: string;
  text: string;
}[] = [
  {
    id: 'import',
    label: 'Import from this project',
    text: 'Read a stylesheet, Tailwind config, tokens file or DESIGN.md into a draft.',
  },
  {
    id: 'template',
    label: 'Start from a template',
    text: 'Neutral greys with one accent, or the tokens CrewKite itself uses.',
  },
  {
    id: 'describe',
    label: 'Describe it',
    text: 'Write the look in your own words and review a draft.',
  },
];

/** "Version 4, saved Nov 18, 2026, 2:02 PM", the line the card and the editor share. */
export const versionLine = (record: { version: number; updatedAt: string }) =>
  `Version ${record.version}, saved ${formatLocalTime(record.updatedAt) ?? 'at an unknown time'}`;

/** What the file on disk says against the recorded version, or null while they match. */
export function fileLine(read: DesignRead): string | null {
  if (!read.record) return null;
  if (read.file === 'changed')
    return `The file changed on disk since version ${read.record.version}. Open the editor to record or replace it.`;
  if (read.file === 'missing')
    return `The file is not on disk. Version ${read.record.version} is still recorded, and saving writes it again.`;
  if (read.file === 'invalid')
    return `The file on disk does not read as a design system.${read.problem ? ` ${plainProblem(read.problem, read.record.path)}` : ''}`;
  return null;
}

/**
 * A project's design system in Settings: where the file lives, the saved version, and whether
 * writing roles receive it. The editor opens as a sheet over the page. The switch applies at once
 * and makes no version.
 */
export function DesignSystemCard({
  source,
  projects,
  onChanged,
}: {
  source: ThreadSource;
  projects: { id: string; name: string }[];
  /** Called after "Send to writing roles" is switched. */
  onChanged?: () => void;
}) {
  const ids = useId();
  const { open, saved } = useDesignSystems();
  const [chosen, setChosen] = useState('');
  const projectId = projects.some(({ id }) => id === chosen) ? chosen : (projects[0]?.id ?? '');
  const [read, setRead] = useState<DesignRead | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const shown = useRef(projectId);
  shown.current = projectId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a save in the editor asks for a new read
  useEffect(() => {
    // The read stays on screen while the same project reads again, so the button that gets focus
    // back after the editor closes is still there.
    setRead((now) => (now?.projectId === projectId ? now : null));
    if (!projectId) return;
    let live = true;
    readDesignSystem(source, projectId).then(
      (next) => live && setRead(next),
      (failure: unknown) =>
        live &&
        setNote(
          failure instanceof Error ? failure.message : 'The design system could not be read.',
        ),
    );
    return () => {
      live = false;
    };
  }, [source, projectId, saved]);

  async function deliver(enabled: boolean) {
    const target = projectId;
    setSwitching(true);
    setNote(null);
    try {
      await setDesignDelivery(source, target, enabled);
      onChanged?.();
      const next = await readDesignSystem(source, target);
      if (shown.current !== target) return;
      setRead(next);
      setNote(
        enabled
          ? 'Writing roles receive it from their next turn.'
          : 'Writing roles no longer receive it.',
      );
    } catch (failure) {
      if (shown.current === target)
        setNote(failure instanceof Error ? failure.message : 'The switch did not change.');
    } finally {
      setSwitching(false);
    }
  }

  const record = read?.record ?? null;
  const problem = read && fileLine(read);
  return (
    <section className="st-card" aria-labelledby={`${ids}-title`} id="settings-design-system">
      <header className="st-card-head">
        <h2 id={`${ids}-title`}>Design system</h2>
        <span className="st-detail">
          {record ? versionLine(record) : 'Tokens and rules for every writing role'}
        </span>
      </header>
      {projects.length === 0 ? (
        <p className="st-note">Add a project to keep a design system for it.</p>
      ) : (
        <div className="st-rows">
          <div className="st-row">
            <div className="st-field">
              <label className="st-name" htmlFor={`${ids}-project`}>
                Project
              </label>
              <small className="st-hint">Each project keeps one design system file.</small>
            </div>
            <div className="st-controls">
              <Select
                id={`${ids}-project`}
                value={projectId}
                onChange={(event) => {
                  setChosen(event.target.value);
                  setNote(null);
                }}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {!read ? (
            <div className="st-row">
              <p className="st-note">Reading the design system.</p>
            </div>
          ) : record ? (
            <>
              <div className="st-row">
                <div className="st-field">
                  <span className="st-name">File</span>
                  <small className="st-hint">The editor writes here when you save a version.</small>
                </div>
                <div className="ds-card-file">
                  <code>{record.path}</code>
                  {problem && <small className="ds-card-problem">{problem}</small>}
                </div>
              </div>
              <div className="st-row">
                <div className="st-field">
                  <label className="st-name" htmlFor={`${ids}-delivery`}>
                    Send to writing roles
                  </label>
                  <small className="st-hint" id={`${ids}-delivery-hint`}>
                    Every writing turn receives the saved version. An edit on disk waits for a save.
                  </small>
                </div>
                <div className="st-controls">
                  <label className="sa-switch">
                    <input
                      id={`${ids}-delivery`}
                      type="checkbox"
                      role="switch"
                      checked={record.delivery}
                      aria-checked={record.delivery}
                      aria-describedby={`${ids}-delivery-hint`}
                      disabled={switching}
                      onChange={(event) => void deliver(event.target.checked)}
                    />
                    <span aria-hidden="true">{record.delivery ? 'On' : 'Off'}</span>
                  </label>
                </div>
              </div>
              <div className="st-row">
                <div className="st-field">
                  <span className="st-name">Editor</span>
                  <small className="st-hint">
                    Tokens, components and rules with live specimens. Nothing is written until you
                    review and save a version.
                  </small>
                </div>
                <div className="st-controls">
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => open({ projectId })}
                  >
                    Open editor
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="st-row ds-card-start">
              <p className="st-note">
                No design system for this project yet. Nothing is written until you review and save
                a version.
              </p>
              <ul className="ds-ways">
                {START_WAYS.map((way) => (
                  <li key={way.id}>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => open({ projectId, start: way.id })}
                    >
                      {way.label}
                    </button>
                    <small className="st-hint">{way.text}</small>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {note && (
        <p className="st-note" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
