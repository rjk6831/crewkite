import type { WorkspaceState } from '@crewkite/contracts';
import { Fact } from '../components.tsx';
import { LocalSetup } from '../local-setup.tsx';
import { type CardProps, ProviderCard } from './provider-card.tsx';

const gib = (bytes: number | null | undefined) =>
  bytes === null || bytes === undefined ? 'Unknown' : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

function Hardware({ header }: { header: WorkspaceState }) {
  const hardware = header.localHardware;
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
      side={<Hardware header={header} />}
    />
  );
}
