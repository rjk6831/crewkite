import {
  type CommandResult,
  type ExtensionCommandOutput,
  ExtensionCommandResultSchema,
  type ExtensionSlot,
  type ExtensionsRead,
  ExtensionsReadSchema,
} from '@crewkite/contracts';
import { useCallback, useEffect, useState } from 'react';
import type { DesktopCommand, DesktopSource } from './source.ts';
import './extension-slots.css';

// The renderer side of the extension seam (ADR 0047). Slots are data from the controller. The
// renderer shows their titles and the plain text their commands return, and runs no extension
// code of its own.

export type ExtensionSource = Pick<DesktopSource, 'command'>;

/** The extension commands are listed in CommandSchema. The cast stays in this one file. */
export const extensionCommand = (
  source: ExtensionSource,
  command: 'ReadExtensions' | 'ConfigureExtension' | 'RunExtensionCommand',
  payload: object,
): Promise<CommandResult> =>
  source.command({
    command,
    payload,
    ...(command === 'ReadExtensions' ? {} : { expectedRevision: 0 }),
  } as unknown as DesktopCommand);

/** The listing and the slots of extensions that are on. A build without the seam reads none. */
export function useExtensions(source: ExtensionSource | undefined) {
  const [read, setRead] = useState<ExtensionsRead | null>(null);
  const reload = useCallback(async () => {
    if (!source) return;
    try {
      const result = await extensionCommand(source, 'ReadExtensions', {});
      const { kind: _kind, ...data } = (result.data ?? {}) as { kind?: string };
      const parsed = ExtensionsReadSchema.safeParse(data);
      setRead(result.outcome === 'applied' && parsed.success ? parsed.data : null);
    } catch {
      setRead(null);
    }
  }, [source]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { read, reload };
}

export const slotsOf = (read: ExtensionsRead | null, kind: ExtensionSlot['slot']) =>
  (read?.slots ?? []).filter((slot) => slot.slot === kind);

export type SlotOutcome = { output: ExtensionCommandOutput } | { error: string };

/** Run a slot's command. A refusal comes back as the controller's next step. */
export async function runSlot(
  source: ExtensionSource,
  slot: ExtensionSlot,
  taskId?: string,
): Promise<SlotOutcome> {
  try {
    const result = await extensionCommand(source, 'RunExtensionCommand', {
      extensionId: slot.extensionId,
      commandId: slot.command,
      ...(taskId ? { taskId } : {}),
    });
    const { kind: _kind, ...data } = (result.data ?? {}) as { kind?: string };
    const parsed = ExtensionCommandResultSchema.safeParse(data);
    if ((result.outcome === 'applied' || result.outcome === 'already-applied') && parsed.success)
      return { output: parsed.data.output };
    return { error: result.next ?? 'The extension command did not run.' };
  } catch (failure) {
    return { error: failure instanceof Error ? failure.message : 'The controller is offline.' };
  }
}

/** Extension output as plain text and label rows. Never markup. */
export function SlotOutput({ outcome }: { outcome: SlotOutcome | null }) {
  if (!outcome) return null;
  if ('error' in outcome)
    return (
      <p className="th-muted" role="status">
        {outcome.error}
      </p>
    );
  return (
    <div role="status">
      <p>{outcome.output.text}</p>
      {outcome.output.rows && (
        <dl className="th-facts">
          {outcome.output.rows.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** The thread action slot: one button per action of an extension that is on. */
export function ExtensionThreadActions({
  source,
  taskId,
}: {
  source: ExtensionSource;
  taskId: string;
}) {
  const { read } = useExtensions(source);
  const [shown, setShown] = useState<{ title: string; outcome: SlotOutcome } | null>(null);
  const actions = slotsOf(read, 'thread-action');
  if (actions.length === 0) return null;
  return (
    <span className="th-extension-actions">
      {actions.map((slot) => (
        <button
          key={`${slot.extensionId}:${slot.id}`}
          type="button"
          className="th-button"
          title={`From the ${slot.extensionId} extension`}
          onClick={async () =>
            setShown({ title: slot.title, outcome: await runSlot(source, slot, taskId) })
          }
        >
          {slot.title}
        </button>
      ))}
      {shown && (
        <span className="th-extension-output">
          <SlotOutput outcome={shown.outcome} />
          <button type="button" className="th-button" onClick={() => setShown(null)}>
            Dismiss
          </button>
        </span>
      )}
    </span>
  );
}

/** Inspector tab IDs for extension tabs carry the extension and slot. */
export const extensionTabId = (slot: ExtensionSlot) =>
  `ext:${slot.extensionId}:${slot.id}` as const;

/** The inspector tab slot: the tab runs its command when it opens and on Refresh. */
export function ExtensionInspectorTab({
  source,
  taskId,
  slot,
}: {
  source: ExtensionSource;
  taskId: string;
  slot: ExtensionSlot;
}) {
  const [outcome, setOutcome] = useState<SlotOutcome | null>(null);
  const refresh = useCallback(
    async () => setOutcome(await runSlot(source, slot, taskId)),
    [source, slot, taskId],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <div className="th-note">
      <SlotOutput outcome={outcome} />
      <button type="button" className="th-button" onClick={() => void refresh()}>
        Refresh
      </button>
    </div>
  );
}
