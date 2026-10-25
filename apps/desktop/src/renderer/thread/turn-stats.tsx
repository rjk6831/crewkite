import type { ChatOutputLimit, ChatTurnStats } from '@crewkite/contracts';
import { FoldVertical } from 'lucide-react';
import { outputSplit } from './output-limit.ts';
import type { CompactedBlock, TurnView } from './turn-fold.ts';
import './turn-stats.css';

const count = (value: number) => value.toLocaleString('en-US');

function duration(ms: number) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function statsLine(stats: ChatTurnStats, limit: ChatOutputLimit | null = null) {
  const parts: string[] = [];
  if (stats.contextUsed !== null && stats.contextCapacity !== null)
    parts.push(`Context ${count(stats.contextUsed)} of ${count(stats.contextCapacity)}`);
  if (limit) parts.push(outputSplit(limit));
  if (stats.summaries > 0)
    parts.push(`${count(stats.summaries)} ${stats.summaries === 1 ? 'summary' : 'summaries'}`);
  if (stats.tokensPerSecond !== null) parts.push(`${Math.round(stats.tokensPerSecond)} tok/s`);
  parts.push(duration(stats.turnMs));
  return parts.join(' · ');
}

// The hover carries the counts the line leaves out.
function statsDetail(stats: ChatTurnStats) {
  return [
    stats.tokensIn === null ? null : `${count(stats.tokensIn)} in`,
    stats.tokensOut === null ? null : `${count(stats.tokensOut)} out`,
    stats.firstTokenMs === null ? null : `${duration(stats.firstTokenMs)} to first token`,
  ]
    .filter(Boolean)
    .join(', ');
}

function CompactedCard({ block }: { block: CompactedBlock }) {
  const turns =
    block.coveredTurns === 1 ? 'Earlier turn 1' : `Earlier turns 1 to ${count(block.coveredTurns)}`;
  return (
    <section className="th-compacted" aria-label="Rolling summary">
      <FoldVertical size={14} aria-hidden="true" />
      <div>
        <p className="th-compacted-title">Rolling summary</p>
        <p>
          {turns} folded into a summary to fit {count(block.capacity)} tokens.
        </p>
      </div>
    </section>
  );
}

/**
 * The end of a turn: a card for each rolling summary written during it, then the measured stats
 * once the turn has finished. The thread keeps the raw turns either way.
 */
export function TurnStats({ turn }: { turn: TurnView }) {
  const compacted = turn.blocks.filter((block) => block.kind === 'compacted');
  return (
    <>
      {compacted.map((block) => (
        <CompactedCard key={block.id} block={block} />
      ))}
      {turn.ended && turn.stats && (
        <p className="th-turn-stats" title={statsDetail(turn.stats) || undefined}>
          {statsLine(turn.stats, turn.outputLimit)}
        </p>
      )}
    </>
  );
}
