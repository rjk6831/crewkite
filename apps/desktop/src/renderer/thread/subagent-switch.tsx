import type { ChatFamily } from '@crewkite/contracts';
import { subagentSwitchNote } from './subagent-view.ts';
import './subagents.css';

/** A crew role's switch for the subagents its client may start. On unless the person turns it off. */
export function SubagentSwitch({
  id,
  role,
  family,
  checked,
  onChange,
}: {
  id: string;
  /** The role's name, so each switch on the list has its own accessible name. */
  role: string;
  family: ChatFamily | null;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const note = subagentSwitchNote(family);
  return (
    <span className="sa-switch-row">
      <label className="sa-switch" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          aria-checked={checked}
          disabled={note !== null}
          aria-describedby={note ? `${id}-note` : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          Allow subagents<span className="th-sr"> for the {role}</span>
        </span>
      </label>
      {note && (
        <small id={`${id}-note`} className="sa-switch-note">
          {note}
        </small>
      )}
    </span>
  );
}
