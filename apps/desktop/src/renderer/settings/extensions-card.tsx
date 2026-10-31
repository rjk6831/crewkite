import type { ExtensionListing, ExtensionSlot } from '@crewkite/contracts';
import { useState } from 'react';
import {
  type ExtensionSource,
  extensionCommand,
  runSlot,
  type SlotOutcome,
  SlotOutput,
  slotsOf,
  useExtensions,
} from '../extension-slots.tsx';

const stateText: Record<ExtensionListing['state'], string> = {
  off: 'Off',
  on: 'On',
  changed: 'Off, changed since you turned it on',
  refused: 'Cannot load',
};
const authorityText: Record<string, string> = {
  'thread.read': 'Read the thread it runs on',
  'thread.event': 'Add its own events to the thread it runs on',
};

function Manifest({ listing }: { listing: ExtensionListing }) {
  const manifest = listing.manifest;
  if (!manifest) return null;
  const slots = [
    ...manifest.threadActions.map((item) => `Thread action: ${item.title}`),
    ...manifest.inspectorTabs.map((item) => `Inspector tab: ${item.title}`),
    ...manifest.settingsCards.map((item) => `Settings card: ${item.title}`),
  ];
  return (
    <details className="st-extension-manifest">
      <summary>Manifest</summary>
      <dl>
        <dt>ID</dt>
        <dd>{manifest.id}</dd>
        <dt>Version</dt>
        <dd>{manifest.version}</dd>
        <dt>Contract</dt>
        <dd>{manifest.contract}</dd>
        <dt>Asks for</dt>
        <dd>
          {manifest.authority.length
            ? manifest.authority.map((item) => authorityText[item] ?? item).join('. ')
            : 'Nothing'}
        </dd>
        <dt>Commands</dt>
        <dd>{manifest.commands.map((item) => item.title).join(', ')}</dd>
        {slots.length > 0 && (
          <>
            <dt>Adds</dt>
            <dd>{slots.join('. ')}</dd>
          </>
        )}
        {manifest.eventKinds.length > 0 && (
          <>
            <dt>Event kinds</dt>
            <dd>{manifest.eventKinds.join(', ')}</dd>
          </>
        )}
        {manifest.crewRoles.length > 0 && (
          <>
            <dt>Crew roles</dt>
            <dd>{manifest.crewRoles.map((item) => item.title).join(', ')}</dd>
          </>
        )}
      </dl>
    </details>
  );
}

function SettingsSlot({ source, slot }: { source: ExtensionSource; slot: ExtensionSlot }) {
  const [outcome, setOutcome] = useState<SlotOutcome | null>(null);
  return (
    <div className="st-row">
      <div className="st-field">
        <span className="st-name">{slot.title}</span>
        <small className="st-hint">From the {slot.extensionId} extension</small>
        <SlotOutput outcome={outcome} />
      </div>
      <div className="st-controls">
        <button
          className="button secondary"
          type="button"
          onClick={async () => setOutcome(await runSlot(source, slot))}
        >
          Run
        </button>
      </div>
    </div>
  );
}

/**
 * Settings > Extensions. Every folder in the extensions directory of the CrewKite home, off until
 * the person turns it on for the manifest shown here.
 */
export function ExtensionsCard({ source }: { source: ExtensionSource | undefined }) {
  const { read, reload } = useExtensions(source);
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!source || !read) return null;
  const toggle = async (listing: ExtensionListing, enabled: boolean) => {
    const extensionId = listing.manifest?.id;
    if (!extensionId || !listing.manifestHash) return;
    setAsking(null);
    try {
      const result = await extensionCommand(source, 'ConfigureExtension', {
        extensionId,
        enabled,
        manifestHash: listing.manifestHash,
      });
      await reload();
      setError(result.outcome === 'applied' ? null : (result.next ?? 'Nothing changed.'));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The controller is offline.');
    }
  };
  return (
    <section className="st-card" aria-labelledby="settings-extensions">
      <header className="st-card-head">
        <h2 id="settings-extensions">Extensions</h2>
        <span className="st-detail">Contract {read.contract}</span>
      </header>
      <p className="st-note">
        An extension is code that runs inside CrewKite with your user permissions. Each one is off
        until you turn it on. CrewKite then gives it what its manifest asks for on the thread it
        runs on, and nothing else. Turn one on only when you trust where it came from.
      </p>
      {error && (
        <p className="st-error" role="status">
          {error}
        </p>
      )}
      <div className="st-rows">
        {read.extensions.length === 0 && (
          <p className="st-hint">
            No extensions. Put an extension folder in the extensions folder of the CrewKite home.
          </p>
        )}
        {read.extensions.map((listing) => {
          const name = listing.manifest?.name ?? listing.folder;
          const on = listing.state === 'on';
          return (
            <div className="st-row" key={listing.folder}>
              <div className="st-field">
                <span className="st-name">
                  {name}
                  {listing.manifest && ` ${listing.manifest.version}`}
                </span>
                <small className="st-hint">
                  {/* A changed listing's line already says it is off. */}
                  {listing.state === 'changed' && listing.line
                    ? listing.line
                    : `${stateText[listing.state]}${listing.line ? `. ${listing.line}` : ''}`}
                </small>
                {listing.manifest?.description && (
                  <small className="st-hint">{listing.manifest.description}</small>
                )}
                <Manifest listing={listing} />
              </div>
              <div className="st-controls">
                {listing.state === 'refused' ? null : on ? (
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => void toggle(listing, false)}
                  >
                    Turn off
                  </button>
                ) : asking === listing.folder ? (
                  <span className="st-actions">
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => void toggle(listing, true)}
                    >
                      Run its code and turn on
                    </button>
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => setAsking(null)}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => setAsking(listing.folder)}
                  >
                    Turn on
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {slotsOf(read, 'settings-card').map((slot) => (
          <SettingsSlot key={`${slot.extensionId}:${slot.id}`} source={source} slot={slot} />
        ))}
      </div>
    </section>
  );
}
