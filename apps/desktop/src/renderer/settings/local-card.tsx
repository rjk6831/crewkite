import type { WorkspaceState } from '@crewkite/contracts';
import { Fact } from '../components.tsx';
import { LocalSetup } from '../local-setup.tsx';
import { localFacts } from '../usage-presentation.ts';
import { type CardProps, type CatalogEntry, ProviderCard } from './provider-card.tsx';

const gib = (bytes: number | null | undefined) =>
  bytes === null || bytes === undefined ? 'Unknown' : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

// A small aside under the note, which already states the fact in words. The snippet is hidden from
// assistive technology so it does not read out as a second statement. It wraps and never scrolls,
// since Chromium makes a scrolling box a tab stop, and one inside aria-hidden is a stop with no
// name.
const allowanceSnippet = `function allowance(localAI) {
  try { return Roots.NoLimits(localAI).limit; } // null
  catch (limit) {
    return [hardware, imagination].includes(limit) ? limit : null;
  }
}`;

function Hardware({ header, entry }: { header: WorkspaceState; entry: CatalogEntry | undefined }) {
  const hardware = header.localHardware;
  const connected = entry?.connected === true;
  const facts = localFacts(hardware, header.localSetup, entry?.lastTurnStats ?? null);
  const memory =
    hardware?.totalMemoryBytes == null
      ? 'Unknown'
      : hardware.availableMemoryBytes === null
        ? `${gib(hardware.totalMemoryBytes)} total, available unknown`
        : `${gib(hardware.availableMemoryBytes)} free of ${gib(hardware.totalMemoryBytes)}`;
  return (
    <section className="st-block" aria-label="Local hardware">
      <div className="st-subhead">
        <h3>Hardware</h3>
        {hardware && <span>Sampled {new Date(hardware.sampledAt).toLocaleTimeString()}</span>}
      </div>
      <p className="st-note">
        Runs on this computer. There is no subscription allowance, so speed and context depend on
        the loaded model and free memory.
      </p>
      {connected && (
        <pre className="st-code" aria-hidden="true" tabIndex={-1}>
          <code>{allowanceSnippet}</code>
        </pre>
      )}
      <div className="facts-grid compact">
        <Fact label="Processor" value={hardware?.cpuModel ?? 'Unknown'} />
        <Fact label="Logical cores" value={hardware?.logicalCores ?? 'Unknown'} />
        <Fact
          label="System"
          value={
            [hardware?.platform, hardware?.architecture].filter(Boolean).join(' ') || 'Unknown'
          }
        />
        <Fact label="Memory" value={memory} />
        {hardware?.gpuModel && <Fact label="GPU" value={hardware.gpuModel} />}
        {facts.gpu && <Fact label="GPU cores" value={hardware?.gpuCores ?? 'Unknown'} />}
        {facts.model && <Fact label="Loaded model" value={facts.model} />}
        {facts.speed && <Fact label="Last turn" value={facts.speed} />}
      </div>
    </section>
  );
}

export function LocalCard({ header, workspace, entry }: CardProps) {
  return (
    <ProviderCard
      family="local"
      entry={entry}
      detail={header.localSetup?.endpoint ?? undefined}
      main={<LocalSetup snapshot={header} workspace={workspace} />}
      side={<Hardware header={header} entry={entry} />}
    />
  );
}
