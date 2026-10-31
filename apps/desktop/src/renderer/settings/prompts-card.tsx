import { type DesktopSource, promptPlaceholders } from '@crewkite/client';
import type { SavedPrompt } from '@crewkite/contracts';
import { useEffect, useState } from 'react';
import { deletePrompt, readPrompts, savePrompt, type ThreadSource } from '../thread/commands.ts';

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Named prompts with {{placeholders}}. In a thread, /prompt name puts one in the box. The
 * controller keeps the list in its home, so the desktop and the command line share it.
 */
export function PromptsCard({
  source,
}: {
  source: ThreadSource & Pick<DesktopSource, 'savePrompts'>;
}) {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    readPrompts(source).then(
      (read) => live && setPrompts(read.prompts),
      (failure: unknown) =>
        live && setNote(failure instanceof Error ? failure.message : 'Prompts could not be read.'),
    );
    return () => {
      live = false;
    };
  }, [source]);

  async function change(run: () => Promise<{ prompts: SavedPrompt[] }>, done: string) {
    try {
      setPrompts((await run()).prompts);
      setNote(done);
      return true;
    } catch (failure) {
      setNote(failure instanceof Error ? failure.message : 'The change was not saved.');
      return false;
    }
  }
  // Main reads the prompts from the controller and saves them through its dialog.
  async function exportFile() {
    if (!source.savePrompts) {
      setNote('Export needs the desktop app.');
      return;
    }
    try {
      setNote((await source.savePrompts()) === 'saved' ? 'Saved.' : null);
    } catch (failure) {
      setNote(failure instanceof Error ? failure.message : 'The file was not saved.');
    }
  }
  const valid = NAME.test(name) && body.trim() !== '';
  return (
    <section className="st-card" aria-labelledby="settings-prompts">
      <header className="st-card-head">
        <h2 id="settings-prompts">Prompts</h2>
        <span className="st-detail">Type /prompt name in a thread</span>
      </header>
      <div className="st-rows">
        {prompts.map((prompt) => {
          const holes = promptPlaceholders(prompt.body);
          return (
            <div className="st-row" key={prompt.name}>
              <div className="st-field">
                <span className="st-name">{prompt.name}</span>
                <small className="st-hint">
                  {holes.length > 0 ? `Fills ${holes.join(', ')}. ` : ''}
                  {prompt.body.length > 120 ? `${prompt.body.slice(0, 120)}...` : prompt.body}
                </small>
              </div>
              <div className="st-controls">
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => {
                    setName(prompt.name);
                    setBody(prompt.body);
                  }}
                >
                  Edit
                </button>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => void change(() => deletePrompt(source, prompt.name), 'Deleted.')}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
        <form
          className="st-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            void change(() => savePrompt(source, { name, body }), 'Saved.').then((saved) => {
              if (saved) {
                setName('');
                setBody('');
              }
            });
          }}
        >
          <div className="st-field">
            <label className="st-name" htmlFor="prompt-name">
              Name
            </label>
            <input
              id="prompt-name"
              value={name}
              maxLength={40}
              placeholder="review-notes"
              onChange={(event) => setName(event.target.value.toLowerCase())}
            />
            <small className="st-hint">
              Lower case letters, digits and hyphens. Write placeholders as {'{{topic}}'}.
            </small>
            <label className="st-name" htmlFor="prompt-body">
              Prompt
            </label>
            <textarea
              id="prompt-body"
              value={body}
              rows={4}
              maxLength={8000}
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
          <div className="st-controls">
            <button className="button primary" type="submit" disabled={!valid}>
              Save prompt
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={prompts.length === 0}
              onClick={() => void exportFile()}
            >
              Export JSON
            </button>
          </div>
        </form>
      </div>
      {note && (
        <p className="st-note" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
