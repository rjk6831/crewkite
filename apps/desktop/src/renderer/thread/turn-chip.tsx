import { FamilyMark } from './family-mark.tsx';
import { effortLabel } from './model-picker.tsx';
import {
  type SubagentBadge as Badge,
  subagentBadge,
  turnActivities,
  turnChip,
} from './subagent-view.ts';
import type { TurnView } from './turn-fold.ts';
import './subagents.css';

/** The subagent count. It pulses while any run and settles to the total. */
export function SubagentBadge({ badge }: { badge: Badge }) {
  return (
    <span className={`sa-badge is-${badge.tone}`} title={badge.label}>
      {badge.tone === 'running' && <i className="sa-pulse" aria-hidden="true" />}
      <span aria-hidden="true">{badge.text}</span>
      <span className="th-sr">{badge.label}</span>
    </span>
  );
}

/**
 * Who answered a turn: the role, the family mark, the model and the effort, in one capsule, with
 * the subagent badge beside it once the client starts any.
 */
export function TurnChip({ turn }: { turn: TurnView }) {
  if (!turn.identity) return null;
  const chip = turnChip(turn.identity);
  const badge = subagentBadge(turnActivities(turn.blocks), turn.ended);
  return (
    <header className="th-turn-head sa-head">
      <span
        className={`sa-chip family-${chip.family}`}
        title={`${chip.role}, ${chip.familyName} ${chip.model}${chip.effort ? `, ${effortLabel(chip.effort)} effort` : ''}`}
      >
        <span className="sa-seg sa-role">
          <FamilyMark family={chip.family} />
          <span>{chip.role}</span>
          <span className="th-sr">{chip.familyName}</span>
        </span>
        <span className="sa-seg sa-model">{chip.model}</span>
        {chip.effort && <span className="sa-seg sa-effort">{effortLabel(chip.effort)}</span>}
      </span>
      {badge && <SubagentBadge badge={badge} />}
    </header>
  );
}
