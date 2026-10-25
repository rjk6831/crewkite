import type { ChatAttachment } from '@crewkite/contracts';
import { FileText, LoaderCircle, Paperclip, X } from 'lucide-react';

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

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Files as chips: a thumbnail for a picture, otherwise the name, type and size. Without `onRemove`
 * they are read-only, as on a sent or queued message. `note` adds one quiet line under a chip.
 */
export function FileChips({
  files,
  onRemove,
  note,
}: {
  files: readonly ChipFile[];
  onRemove?: (key: string) => void;
  note?: (file: ChipFile) => string | null;
}) {
  if (files.length === 0) return null;
  return (
    <ul className="th-chips th-files" aria-label="Files">
      {files.map((file) => {
        const line = note?.(file) ?? null;
        const facts = [file.mimeType, formatBytes(file.bytes)].filter(Boolean).join(' · ');
        return (
          <li key={file.key} className={file.thumbnail ? 'th-file is-image' : 'th-file'}>
            <span className="th-file-body" title={`${file.name}\n${facts}`}>
              {file.thumbnail ? (
                <img src={file.thumbnail} alt={file.name} />
              ) : (
                <>
                  {file.busy ? (
                    <LoaderCircle size={13} className="th-spin" aria-label="Adding" />
                  ) : (
                    <FileText size={13} aria-hidden="true" />
                  )}
                  <span className="th-file-name">{file.name}</span>
                  <span className="th-file-facts">{facts}</span>
                </>
              )}
              {onRemove && (
                <button
                  type="button"
                  className="th-file-remove"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => onRemove(file.key)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </span>
            {line && <span className="th-file-note">{line}</span>}
          </li>
        );
      })}
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
