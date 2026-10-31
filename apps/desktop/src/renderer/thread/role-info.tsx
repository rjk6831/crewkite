import { Info } from 'lucide-react';
import { useId } from 'react';
import './role-info.css';

/** What each role does, for the info mark beside its name in the Crew tab and in Settings. */
export const roleInfo = {
  builder: {
    name: 'Builder',
    text: "Writes the code. Each message runs a builder turn in the thread's scratch copy on the thread's model.",
  },
  reviewer: {
    name: 'Reviewer',
    text: "Reads the builder's changes and lists what is wrong or missing. It never edits files.",
  },
  advisor: {
    name: 'Advisor',
    text: 'Gives a second opinion on the last answer: what holds up, what is wrong and what to do next. It reads files and never edits them.',
  },
  challenger: {
    name: 'Challenger',
    text: 'Names the assumptions the last answer rests on and which of them may not hold. In a crew it runs once at the end. It never edits files.',
  },
  fixer: {
    name: 'Fixer',
    text: "Works through the reviewer's findings in the scratch copy. The builder takes this role unless the crew gives it a model of its own.",
  },
  orchestrator: {
    name: 'Orchestrator',
    text: 'Reads the request and proposes a plan of up to 8 slices. The controller assigns each slice to a connected provider and shows the plan before it runs.',
  },
  ask: {
    name: 'Ask',
    text: "Answers a side question from the project files. It never edits files and leaves the thread's model as it is.",
  },
} as const;
export type RoleInfoKey = keyof typeof roleInfo;

/** A small info mark. Hover or keyboard focus shows what the role does. */
export function RoleInfo({ of: role }: { of: RoleInfoKey }) {
  const id = useId();
  const info = roleInfo[role];
  return (
    <span className="role-info">
      <button
        type="button"
        className="role-info-button"
        aria-label={`What the ${info.name} does`}
        aria-describedby={id}
      >
        <Info size={12} aria-hidden="true" />
      </button>
      <span id={id} role="tooltip" className="role-info-tip">
        {info.text}
      </span>
    </span>
  );
}
