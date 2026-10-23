import { Paperclip, X } from 'lucide-react';

export const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** Attached paths as chips. Without `onRemove` they are read-only, as on a sent message. */
export function AttachmentChips({
  paths,
  onRemove,
}: {
  paths: readonly string[];
  onRemove?: (path: string) => void;
}) {
  return (
    <ul className="th-chips" aria-label="Attachments">
      {paths.map((path) => (
        <li key={path} title={path}>
          <Paperclip size={12} aria-hidden="true" />
          {basename(path)}
          {onRemove && (
            <button type="button" aria-label={`Remove ${path}`} onClick={() => onRemove(path)}>
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The one-line field that adds a path. Enter adds it and Escape closes the field. */
export function AttachRow({
  value,
  onChange,
  onAdd,
  onClose,
}: {
  value: string;
  onChange: (value: string) => void;
  onAdd: () => void;
  onClose: () => void;
}) {
  return (
    <div className="th-attach-row">
      <input
        // biome-ignore lint/a11y/noAutofocus: the field opens on the person's own click
        autoFocus
        value={value}
        placeholder="Path to a file or folder"
        aria-label="Path to attach"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onAdd();
          } else if (event.key === 'Escape') {
            // Claimed here so the inspector stays open for this press.
            event.preventDefault();
            onClose();
          }
        }}
      />
      <button type="button" onClick={onAdd}>
        Add
      </button>
    </div>
  );
}
