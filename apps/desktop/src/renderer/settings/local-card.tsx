import type { WorkspaceState } from '@crewkite/contracts';
import { Fact } from '../components.tsx';
import { formatSize } from '../format-size.ts';
import { LocalSetup } from '../local-setup.tsx';
import { localFacts } from '../usage-presentation.ts';
import { type CardProps, type CatalogEntry, ProviderCard } from './provider-card.tsx';

const sizeText = (bytes: number | null | undefined) =>
  bytes === null || bytes === undefined ? 'Unknown' : formatSize(bytes);

function Hardware({ header, entry }: { header: WorkspaceState; entry: CatalogEntry | undefined }) {
  const hardware = header.localHardware;
  const facts = localFacts(hardware, header.localSetup, entry?.lastTurnStats ?? null);
  const memory =
    hardware?.totalMemoryBytes == null
      ? 'Unknown'
      : hardware.availableMemoryBytes === null
        ? `${sizeText(hardware.totalMemoryBytes)} total, available unknown`
        : `${sizeText(hardware.availableMemoryBytes)} available of ${sizeText(hardware.totalMemoryBytes)}`;
  return (
    <section className="st-block" aria-label="Local hardware">
      <div className="st-subhead">
        <h3>Hardware</h3>
        {hardware && <span>Sampled {new Date(hardware.sampledAt).toLocaleTimeString()}</span>}
      </div>
      <p className="st-note">
        Runs on this computer. There is no subscription allowance, so speed and context depend on
        the loaded model and available memory.
      </p>
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
