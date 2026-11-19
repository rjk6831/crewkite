import { type DesignSystem, DesignSystemRecordSchema } from '@crewkite/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { Select } from '../select.tsx';
import { draftDesignSystem, importDesignSystem, type ThreadSource } from '../thread/commands.ts';
import tokensCss from '../tokens.css?raw';
import type { SheetRequest } from './context.ts';
import type { ColorCheck } from './model.ts';
import {
  crewkiteTemplate,
  IMPORT_SOURCES,
  type ImportSource,
  NEUTRAL_TEMPLATE,
  type Probe,
  plainProblem,
  probeImports,
  sourceLabel,
} from './start.ts';
import { START_WAYS } from './system-card.tsx';

export type Started = {
  system: DesignSystem;
  banner: string;
  skipped: number;
  /** A design system file is adopted where it stands, so it saves back to its own path. */
  path?: string;
};

export const notMapped = (count: number) =>
  count === 0
    ? 'Every value mapped.'
    : `${count} ${count === 1 ? 'value was' : 'values were'} not mapped.`;

/**
 * The empty editor. Every way in ends in a draft the person reviews; nothing here writes a file.
 * The import list comes from asking for the paths projects usually use, since no command lists a
 * project's files.
 */
export function StartPanel({
  source,
  projectId,
  focus,
  isColor,
  onStart,
}: {
  source: ThreadSource;
  projectId: string;
  focus: SheetRequest['start'];
  isColor: ColorCheck;
  onStart: (started: Started) => void;
}) {
  const ids = useId();
  const [probes, setProbes] = useState<Probe[] | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<ImportSource>('css-variables');
  const [path, setPath] = useState('');
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [describing, setDescribing] = useState(false);
  const [describeNote, setDescribeNote] = useState<string | null>(null);
  // An import or a draft can answer after the sheet closed, and then starts nothing.
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const first = {
    import: useRef<HTMLHeadingElement>(null),
    template: useRef<HTMLHeadingElement>(null),
    describe: useRef<HTMLHeadingElement>(null),
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the way in is read once, when the sheet opens
  useEffect(() => {
    if (focus) first[focus].current?.focus();
  }, []);
  useEffect(() => {
    let live = true;
    probeImports((probe) => importDesignSystem(source, { projectId, ...probe })).then(
      (found) => {
        if (!live) return;
        setProbes(found);
        // The first file that reads fills the form, so Import is one press away.
        const pick = found.find((probe) => 'draft' in probe) ?? found[0];
        if (pick) {
          setSourceId(pick.source);
          setPath(pick.path);
        }
      },
      (failure: unknown) =>
        live &&
        setProbeError(
          failure instanceof Error ? failure.message : 'The project files could not be read.',
        ),
    );
    return () => {
      live = false;
    };
  }, [source, projectId]);

  const started = (system: DesignSystem, from: string, skipped: number, adopt?: string) =>
    onStart({
      system,
      banner: `Draft from ${from}. Nothing is saved yet.`,
      skipped,
      ...(adopt ? { path: adopt } : {}),
    });

  async function runImport() {
    const target = path.trim();
    if (!DesignSystemRecordSchema.shape.path.safeParse(target).success) {
      setImportNote('Use a path inside the project, such as src/styles/tokens.css.');
      return;
    }
    setImporting(true);
    setImportNote(null);
    try {
      const answer = await importDesignSystem(source, {
        projectId,
        source: sourceId,
        path: target,
      });
      if (!live.current) return;
      if ('draft' in answer)
        started(
          answer.draft.system,
          target,
          answer.draft.skipped,
          sourceId === 'design-system' ? target : undefined,
        );
      else setImportNote(plainProblem(answer.next, target));
    } catch (failure) {
      if (live.current)
        setImportNote(failure instanceof Error ? failure.message : 'The file could not be read.');
    } finally {
      if (live.current) setImporting(false);
    }
  }

  async function describe() {
    setDescribing(true);
    setDescribeNote(null);
    try {
      const answer = await draftDesignSystem(source, projectId, description.trim());
      if (!live.current) return;
      if ('draft' in answer)
        onStart({
          system: answer.draft.system,
          banner: 'Draft from your description. Review every value before you save.',
          skipped: answer.draft.skipped,
        });
      else setDescribeNote(answer.next);
    } catch (failure) {
      if (live.current)
        setDescribeNote(
          failure instanceof Error ? failure.message : 'The draft could not be made.',
        );
    } finally {
      if (live.current) setDescribing(false);
    }
  }

  const way = (id: (typeof START_WAYS)[number]['id']) =>
    START_WAYS.find((value) => value.id === id) as (typeof START_WAYS)[number];
  return (
    <div className="ds-start">
      <p className="ds-start-lead">
        This project has no design system yet. Start from one of these, review every value, then
        save version 1.
      </p>
      <section className="ds-way" aria-labelledby={`${ids}-import`}>
        <h3 id={`${ids}-import`} ref={first.import} tabIndex={-1}>
          {way('import').label}
        </h3>
        <p className="ds-hint">{way('import').text}</p>
        {probeError ? (
          <p className="ds-field-error">{probeError}</p>
        ) : !probes ? (
          <p className="ds-hint" role="status">
            Looking for style files in this project.
          </p>
        ) : probes.length === 0 ? (
          <p className="ds-hint">No style files at the usual paths. Enter a path below.</p>
        ) : (
          <ul className="ds-found" aria-label="Files found in this project">
            {[
              ...probes.filter((probe) => 'draft' in probe),
              ...probes.filter((probe) => !('draft' in probe)),
            ].map((probe) =>
              'draft' in probe ? (
                <li key={probe.path}>
                  <button
                    type="button"
                    className="ds-found-file"
                    onClick={() =>
                      started(
                        probe.draft.system,
                        probe.path,
                        probe.draft.skipped,
                        probe.source === 'design-system' ? probe.path : undefined,
                      )
                    }
                  >
                    <code>{probe.path}</code>
                    <span className="ds-found-kind">
                      {sourceLabel(probe.source)}. {notMapped(probe.draft.skipped)}
                    </span>
                  </button>
                </li>
              ) : (
                <li key={probe.path} className="is-problem">
                  <code>{probe.path}</code>
                  <span className="ds-field-error">{probe.problem}</span>
                </li>
              ),
            )}
          </ul>
        )}
        <form
          className="ds-import-form"
          onSubmit={(event) => {
            event.preventDefault();
            void runImport();
          }}
        >
          <div className="ds-field">
            <span className="ds-label" id={`${ids}-source`}>
              Source
            </span>
            <Select
              aria-labelledby={`${ids}-source`}
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value as ImportSource)}
            >
              {IMPORT_SOURCES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="ds-field">
            <label htmlFor={`${ids}-path`}>Path</label>
            <input
              id={`${ids}-path`}
              value={path}
              spellCheck={false}
              autoComplete="off"
              placeholder={IMPORT_SOURCES.find((item) => item.id === sourceId)?.example}
              aria-invalid={importNote ? true : undefined}
              aria-describedby={importNote ? `${ids}-import-note` : undefined}
              onChange={(event) => {
                setPath(event.target.value);
                setImportNote(null);
              }}
            />
          </div>
          <button type="submit" className="button secondary" disabled={importing || !path.trim()}>
            {importing ? 'Importing' : 'Import'}
          </button>
        </form>
        {importNote && (
          <p className="ds-field-error" id={`${ids}-import-note`} role="alert">
            {importNote}
          </p>
        )}
      </section>
      <section className="ds-way" aria-labelledby={`${ids}-template`}>
        <h3 id={`${ids}-template`} ref={first.template} tabIndex={-1}>
          {way('template').label}
        </h3>
        <p className="ds-hint">{way('template').text}</p>
        <div className="ds-templates">
          <button
            type="button"
            className="ds-template"
            onClick={() => started(NEUTRAL_TEMPLATE, 'the Neutral template', 0)}
          >
            <strong>Neutral</strong>
            <span className="ds-template-text">
              A grey scale, one accent, a 4 px spacing scale and two shadows.
            </span>
          </button>
          <button
            type="button"
            className="ds-template"
            onClick={() => started(crewkiteTemplate(tokensCss, isColor), 'the CrewKite tokens', 0)}
          >
            <strong>CrewKite tokens</strong>
            <span className="ds-template-text">
              The dark theme colors, 2 px spacing and radius steps, and both font stacks.
            </span>
          </button>
        </div>
      </section>
      <section className="ds-way" aria-labelledby={`${ids}-describe`}>
        <h3 id={`${ids}-describe`} ref={first.describe} tabIndex={-1}>
          {way('describe').label}
        </h3>
        <form
          className="ds-describe"
          onSubmit={(event) => {
            event.preventDefault();
            if (description.trim()) void describe();
          }}
        >
          <div className="ds-field">
            <label htmlFor={`${ids}-description`}>Describe colors, type and density.</label>
            <textarea
              id={`${ids}-description`}
              value={description}
              rows={3}
              maxLength={4000}
              aria-describedby={describeNote ? `${ids}-describe-note` : undefined}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <button
            type="submit"
            className="button secondary"
            disabled={describing || !description.trim()}
          >
            {describing ? 'Drafting' : 'Draft'}
          </button>
        </form>
        {describeNote && (
          <p className="ds-field-error" id={`${ids}-describe-note`} role="status">
            {describeNote}
          </p>
        )}
      </section>
    </div>
  );
}
