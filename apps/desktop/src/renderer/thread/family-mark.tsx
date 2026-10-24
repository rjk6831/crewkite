import type { ChatFamily } from '@crewkite/contracts';

// A family is shown by its colour token and one letter. No vendor logo appears anywhere.
const marks: Record<ChatFamily, string> = { openai: 'O', anthropic: 'A', google: 'G', local: 'L' };

export const familyMark = (family: ChatFamily) => marks[family];

/** The letter mark in the family colour. It sits next to the family name, so readers skip it. */
export function FamilyMark({ family }: { family: ChatFamily }) {
  return (
    <span className={`family-mark family-${family}`} aria-hidden="true">
      {familyMark(family)}
    </span>
  );
}
