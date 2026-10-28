import type { ChatAttachment } from '@crewkite/contracts';
import { Ellipsis, FileText, LoaderCircle, Paperclip, X } from 'lucide-react';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { ATTACHMENT_ID_PATTERN, type AttachmentAction } from '../../shared/open-file.ts';
import { formatSize } from '../format-size.ts';

export const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** One file as a chip shows it. The type is null until the controller has read the bytes. */
export type ChipFile = {
  key: string;
  name: string;
  bytes: number;
  mimeType: string | null;
  thumbnail: string | null;
  busy?: boolean;
};

// The renderer cannot read a stored file, so a thumbnail lives only as long as the window. A file
// sent in this window keeps its picture on the sent message; one from an earlier launch shows its
// name.
const thumbnails = new Map<string, string>();
export const keepThumbnail = (id: string, url: string | null) => {
  if (url) thumbnails.set(id, url);
};

export const chipOf = (file: ChatAttachment): ChipFile => ({
  key: file.id,
  name: file.name,
  bytes: file.bytes,
  mimeType: file.mimeType,
  thumbnail: thumbnails.get(file.id) ?? null,
});

const previewable = (mimeType: string | null) =>
  mimeType !== null && (mimeType.startsWith('image/') || mimeType === 'application/pdf');

// The bridge is the desktop's. A browser preview has none, and its chips only show.
const desktop = () => window.crewkite;
const canOpen = () => typeof desktop()?.openAttachment === 'function';

function ChipMenu({
  taskId,
  file,
  trigger,
  onClose,
  onError,
}: {
  taskId: string;
  file: ChipFile;
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onError: (message: string | null) => void;
}) {
  const items = useRef<HTMLDivElement>(null);
  useEffect(() => {
    items.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const away = (event: MouseEvent) => {
      if (!items.current?.contains(event.target as Node) && event.target !== trigger.current)
        onClose();
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [trigger, onClose]);
  const run = (action: AttachmentAction) => {
    onClose();
    onError(null);
    desktop()
      ?.openAttachment?.({ action, taskId, id: file.key, name: file.name })
      .catch((failure: unknown) =>
        onError(failure instanceof Error ? failure.message : 'The file did not open.'),
      );
  };
  const leave = () => {
    onClose();
    trigger.current?.focus();
  };
  return (
    <div
      ref={items}
      id={`${file.key}-menu`}
      className="th-chip-menu"
      role="menu"
      aria-label={`Actions for ${file.name}`}
      onKeyDown={(event) => {
        const options = [
          ...(items.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
        ];
        const at = options.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'Escape' || event.key === 'Tab') {
          if (event.key === 'Escape') event.preventDefault();
          leave();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          options[(at + step + options.length) % options.length]?.focus();
        }
      }}
    >
      <button
        type="button"
        role="menuitem"
        className="th-chip-item"
        tabIndex={-1}
        onClick={() => run('reveal')}
      >
        Reveal in Finder
      </button>
      <button
        type="button"
        role="menuitem"
        className="th-chip-item"
        tabIndex={-1}
        onClick={() => run('save')}
      >
        Save as
      </button>
    </div>
  );
}

function Chip({
  file,
  taskId,
  onRemove,
  note,
  hover,
}: {
  file: ChipFile;
  taskId?: string;
  onRemove?: (key: string) => void;
  note?: (file: ChipFile) => string | null;
  hover?: (file: ChipFile) => string | null;
}) {
  const [menu, setMenu] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  const [problem, setProblem] = useState<string | null>(null);
  const line = note?.(file) ?? null;
  const facts = [file.mimeType, formatSize(file.bytes)].filter(Boolean).join(' · ');
  const title = [file.name, facts, hover?.(file)].filter(Boolean).join('\n');
  // A file the controller stored is named by its hash. One still waiting as a path has no id yet.
  const stored = !!taskId && ATTACHMENT_ID_PATTERN.test(file.key) && canOpen();
  const preview = stored && previewable(file.mimeType);
  const body = file.thumbnail ? (
    <img src={file.thumbnail} alt={file.name} />
  ) : (
    <>
      {file.busy ? (
        <LoaderCircle size={13} className="th-spin" aria-label="Adding" />
      ) : (
        <FileText size={13} aria-hidden="true" />
      )}
      <span className="th-attachment-name">{file.name}</span>
      <span className="th-attachment-facts">{facts}</span>
    </>
  );
  return (
    <li
      className={file.thumbnail ? 'th-attachment is-image' : 'th-attachment'}
      onContextMenu={(event) => {
        if (!stored) return;
        event.preventDefault();
        setMenu(true);
      }}
    >
      <span className="th-attachment-body" title={title}>
        {preview && taskId ? (
          <button
            type="button"
            className="th-attachment-open"
            aria-label={`Preview ${file.name}`}
            onClick={() => {
              setProblem(null);
              desktop()
                ?.openAttachment?.({ action: 'preview', taskId, id: file.key, name: file.name })
                .catch((failure: unknown) =>
                  setProblem(failure instanceof Error ? failure.message : 'The file did not open.'),
                );
            }}
          >
            {body}
          </button>
        ) : (
          body
        )}
        {stored && (
          <button
            ref={trigger}
            type="button"
            className="th-attachment-more"
            aria-label={`Actions for ${file.name}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            aria-controls={menu ? `${file.key}-menu` : undefined}
            onClick={() => setMenu(!menu)}
          >
            <Ellipsis size={12} aria-hidden="true" />
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            className="th-attachment-remove"
            aria-label={`Remove ${file.name}`}
            onClick={() => onRemove(file.key)}
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </span>
      {menu && stored && taskId && (
        <ChipMenu
          taskId={taskId}
          file={file}
          trigger={trigger}
          onClose={closeMenu}
          onError={setProblem}
        />
      )}
      {(problem ?? line) && <span className="th-attachment-note">{problem ?? line}</span>}
    </li>
  );
}

/**
 * Files as chips: a thumbnail for a picture, otherwise the name, type and size. Without `onRemove`
 * they are read-only, as on a sent or queued message. `note` adds one quiet line under a chip and
 * `hover` adds a line to its title. With `taskId`, a stored picture or PDF previews on click, and
 * every stored file has a menu to reveal or save it.
 */
export function FileChips({
  files,
  taskId,
  onRemove,
  note,
  hover,
}: {
  files: readonly ChipFile[];
  taskId?: string;
  onRemove?: (key: string) => void;
  note?: (file: ChipFile) => string | null;
  hover?: (file: ChipFile) => string | null;
}) {
  if (files.length === 0) return null;
  return (
    <ul className="th-chips th-attachments" aria-label="Files">
      {files.map((file) => (
        <Chip
          key={file.key}
          file={file}
          taskId={taskId}
          onRemove={onRemove}
          note={note}
          hover={hover}
        />
      ))}
    </ul>
  );
}

/** Paths an older version of the thread saved on a message. They are shown as they were. */
export function AttachmentChips({ paths }: { paths: readonly string[] }) {
  return (
    <ul className="th-chips" aria-label="Attachments">
      {paths.map((path) => (
        <li key={path} title={path}>
          <Paperclip size={12} aria-hidden="true" />
          {basename(path)}
        </li>
      ))}
    </ul>
  );
}
