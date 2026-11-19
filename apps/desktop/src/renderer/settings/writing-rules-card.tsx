import type { WritingRulesExport, WritingRulesRead } from '@crewkite/contracts';
import { useEffect, useId, useRef, useState } from 'react';

// A preview belongs to the project and file it was made for. Write sends that project, never the
// one on screen now.
type Preview = WritingRulesExport & { projectId: string; projectName: string };

import { Select } from '../select.tsx';
import {
  exportWritingRules,
  previewWritingRulesExport,
  readWritingRules,
  setWritingRule,
  type ThreadSource,
} from '../thread/commands.ts';

// Names for the rule ids. The rule text itself comes from the controller's catalogue.
const ruleName: Record<string, string> = {
  ladder: 'Simplicity ladder',
  'search-first': 'Search first',
  'survey-delegation': 'Delegate broad surveys',
  'response-contents': 'What a reply contains',
  'settled-decisions': 'Settled decisions',
  'session-switch': 'Task and session switch',
  'concise-replies': 'Concise replies',
  testing: 'Testing',
  rereads: 'Rereads',
  'bounded-output': 'Bounded command output',
  'stop-at-scope': 'Stop at scope',
  'independent-calls': 'Independent calls',
};

/**
 * The writing rules every writing turn receives, one switch each, and a previewed export of the
 * same text to a file in a project. Safety, validation, accessibility and permission rules are not
 * listed: they always apply. A change reaches the next writing turn.
 */
export function WritingRulesCard({
  source,
  projects,
  onChanged,
}: {
  source: ThreadSource;
  projects: { id: string; name: string }[];
  /** Called after a rule is switched. */
  onChanged?: () => void;
}) {
  const [read, setRead] = useState<WritingRulesRead | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [chosen, setChosen] = useState('');
  const projectId = projects.some(({ id }) => id === chosen) ? chosen : (projects[0]?.id ?? '');
  const [destination, setDestination] = useState('AGENTS.md');
  const [preview, setPreview] = useState<Preview | null>(null);
  // A refused preview or write reads as an error. Wrote reads as plain status.
  const [exportNote, setExportNote] = useState<{ text: string; failed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = useId();
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  // Preview is disabled while a command runs, so focus returns to it once busy clears.
  const returnFocus = useRef(false);
  useEffect(() => {
    if (busy || !returnFocus.current) return;
    returnFocus.current = false;
    previewButton.current?.focus();
  }, [busy]);
  // Every change that makes a pending preview stale bumps this, and a late answer is dropped.
  const request = useRef(0);
  const stale = () => {
    request.current += 1;
    setPreview(null);
  };
  // The heading mounts with the preview, so focus moves once it is on screen.
  useEffect(() => {
    if (preview) previewHeading.current?.focus();
  }, [preview]);
  // A preview for a project that is gone is no longer valid.
  useEffect(() => {
    if (preview && !projects.some(({ id }) => id === preview.projectId)) stale();
  });

  useEffect(() => {
    let live = true;
    readWritingRules(source).then(
      (next) => live && setRead(next),
      (failure: unknown) =>
        live &&
        setNote(failure instanceof Error ? failure.message : 'The rules could not be read.'),
    );
    return () => {
      live = false;
    };
  }, [source]);

  async function toggle(ruleId: string, enabled: boolean) {
    setSaving(ruleId);
    setNote(null);
    try {
      const next = await setWritingRule(source, ruleId, enabled);
      onChanged?.();
      setRead(next);
      // A preview shows the text as it was. A changed rule needs a new one.
      stale();
      const exportOnly = next.rules.find((rule) => rule.id === ruleId)?.surface === 'export-only';
      setNote(
        exportOnly
          ? 'Saved. Applies to the next export.'
          : 'Saved. Applies from the next writing turn.',
      );
    } catch (failure) {
      setNote(failure instanceof Error ? failure.message : 'The change was not saved.');
    } finally {
      setSaving(null);
    }
  }

  async function showPreview() {
    if (!projectId || busy || saving) return;
    const ticket = ++request.current;
    const target = projects.find(({ id }) => id === projectId);
    setBusy(true);
    setExportNote(null);
    try {
      const made = await previewWritingRulesExport(source, projectId, destination.trim());
      if (ticket === request.current && target)
        setPreview({ ...made, projectId: target.id, projectName: target.name });
    } catch (failure) {
      if (ticket === request.current) {
        setPreview(null);
        setExportNote({
          text: failure instanceof Error ? failure.message : 'The preview could not be made.',
          failed: true,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  async function write() {
    if (!preview || busy) return;
    setBusy(true);
    try {
      await exportWritingRules(source, preview.projectId, preview);
      setExportNote({
        text: `Wrote ${preview.destination} in ${preview.projectName}.`,
        failed: false,
      });
    } catch (failure) {
      // A stale preview or a changed file refuses the write. The person previews again.
      setExportNote({
        text: failure instanceof Error ? failure.message : 'The file was not written.',
        failed: true,
      });
    } finally {
      stale();
      returnFocus.current = true;
      setBusy(false);
    }
  }

  const settingsRules = read?.rules.filter((rule) => rule.surface === 'settings') ?? [];
  const exportOnly = read?.rules.filter((rule) => rule.surface === 'export-only') ?? [];
  const enabledCount = settingsRules.filter((rule) => rule.enabled).length;

  return (
    <section className="st-card" aria-labelledby="settings-writing-rules">
      <header className="st-card-head">
        <h2 id="settings-writing-rules">Writing rules</h2>
        <span className="st-detail">
          {read ? `${enabledCount} of ${settingsRules.length} on` : 'Sent with every writing turn'}
        </span>
      </header>
      <p className="st-note">
        Every writing turn on every provider receives the rules that are on. Validation, error
        handling that prevents data loss, security, accessibility, permissions and recorded
        decisions always apply and are not listed.
      </p>
      <div className="st-rows">
        {settingsRules.map((rule) => (
          <RuleRow
            key={rule.id}
            id={`${ids}-${rule.id}`}
            name={ruleName[rule.id] ?? rule.id}
            text={rule.text}
            checked={rule.enabled}
            disabled={saving !== null || busy}
            onChange={(enabled) => void toggle(rule.id, enabled)}
          />
        ))}
      </div>
      {note && <p role="status">{note}</p>}

      <div className="st-subhead">
        <h3>Export</h3>
      </div>
      <p className="st-note">
        Write the same rules into a file in a project, such as AGENTS.md, for tools that read one.
        CrewKite shows the exact text first and changes only its own marked block.
      </p>
      <div className="st-rows">
        {exportOnly.map((rule) => (
          <RuleRow
            key={rule.id}
            id={`${ids}-${rule.id}`}
            name={`${ruleName[rule.id] ?? rule.id} (export only)`}
            text={rule.text}
            checked={rule.enabled}
            disabled={saving !== null || busy}
            onChange={(enabled) => void toggle(rule.id, enabled)}
          />
        ))}
        {projects.length === 0 ? (
          <p className="st-note">Add a project to export the rules into it.</p>
        ) : (
          <>
            <div className="st-row">
              <div className="st-field">
                <label className="st-name" htmlFor={`${ids}-project`}>
                  Project
                </label>
              </div>
              <div className="st-controls">
                <Select
                  id={`${ids}-project`}
                  value={projectId}
                  onChange={(event) => {
                    setChosen(event.target.value);
                    stale();
                    setExportNote(null);
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
            <div className="st-row">
              <div className="st-field">
                <label className="st-name" htmlFor={`${ids}-destination`}>
                  File
                </label>
                <small className="st-hint" id={`${ids}-destination-hint`}>
                  A path inside the project.
                </small>
              </div>
              <div className="st-controls">
                <input
                  id={`${ids}-destination`}
                  aria-describedby={`${ids}-destination-hint`}
                  value={destination}
                  onChange={(event) => {
                    setDestination(event.target.value);
                    stale();
                  }}
                />
                <button
                  ref={previewButton}
                  type="button"
                  className="button secondary"
                  disabled={busy || saving !== null || destination.trim() === ''}
                  onClick={() => void showPreview()}
                >
                  Preview
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      {preview && (
        <section className="st-block" aria-labelledby={`${ids}-preview`}>
          {/* A file name keeps its own case, so this heading is not set in capitals. */}
          <h3 id={`${ids}-preview`} className="st-preview-title" ref={previewHeading} tabIndex={-1}>
            {preview.mode === 'new-file'
              ? `New file ${preview.destination} in ${preview.projectName}`
              : `Adds or updates the rules block in ${preview.destination} in ${preview.projectName}`}
          </h3>
          <pre className="st-preview">{preview.preview}</pre>
          <div className="st-actions">
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => void write()}
            >
              Write file
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => {
                stale();
                previewButton.current?.focus();
              }}
            >
              Cancel
            </button>
          </div>
        </section>
      )}
      {exportNote && (
        <p role="status" className={exportNote.failed ? 'st-error' : undefined}>
          {exportNote.text}
        </p>
      )}
    </section>
  );
}

function RuleRow({
  id,
  name,
  text,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  name: string;
  text: string;
  checked: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <div className="st-row">
      <div className="st-field">
        <label className="sa-switch" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            role="switch"
            checked={checked}
            aria-checked={checked}
            aria-describedby={`${id}-text`}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>{name}</span>
        </label>
        <small className="st-hint" id={`${id}-text`}>
          {text}
        </small>
      </div>
    </div>
  );
}
