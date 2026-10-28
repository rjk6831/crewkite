import { FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { readInstructions, type ThreadSource } from './commands.ts';
import './composer-menu.css';

/**
 * One chip above the composer when the scratch copy holds project instruction files. Clicking it
 * shows the file's text. This is visibility only: the controller decides what each provider reads.
 */
export function InstructionChip({
  source,
  taskId,
  refreshKey,
}: {
  source: ThreadSource;
  taskId: string | null;
  /** Changes when a turn ends, since a turn can add or edit an instruction file. */
  refreshKey: unknown;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [open, setOpen] = useState<{ name: string; text: string; truncated: boolean } | null>(null);
  const [shown, setShown] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey asks for a new read
  useEffect(() => {
    if (!taskId) return;
    let live = true;
    readInstructions(source, taskId).then(
      (read) => live && setFiles(read.files),
      () => live && setFiles([]),
    );
    return () => {
      live = false;
    };
  }, [source, taskId, refreshKey]);

  if (!taskId || files.length === 0) return null;
  async function show(name: string) {
    try {
      const read = await readInstructions(source, taskId as string, name);
      if (read.text === null) throw new Error('The file could not be read.');
      setOpen({ name, text: read.text, truncated: read.truncated });
      setProblem(null);
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : 'The file could not be read.');
    }
  }
  return (
    <div className="th-instructions">
      <button
        type="button"
        className="th-instructions-chip"
        aria-expanded={shown}
        aria-controls="th-instructions-view"
        title="Project instruction files at the root of this thread's copy"
        onClick={() => {
          const next = !shown;
          setShown(next);
          if (next && !open) void show(files[0]);
        }}
      >
        <FileText size={13} aria-hidden="true" />
        {files.length === 1 ? files[0] : `${files[0]} and ${files.length - 1} more`}
      </button>
      {shown && (
        <div className="th-instructions-view" id="th-instructions-view">
          {files.length > 1 && (
            <nav aria-label="Instruction files">
              {files.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="th-pill"
                  aria-pressed={open?.name === name}
                  onClick={() => void show(name)}
                >
                  {name}
                </button>
              ))}
            </nav>
          )}
          {problem ? (
            <p role="status">{problem}</p>
          ) : (
            open && (
              <>
                <pre>{open.text}</pre>
                {open.truncated && <p className="th-note-lines">The file is longer than shown.</p>}
              </>
            )
          )}
        </div>
      )}
    </div>
  );
}
