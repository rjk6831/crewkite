// Three questions that fit most repositories. Choosing one fills the composer and sends nothing.
const prompts = [
  'What does this project do, and what would you change first?',
  'Find code that has no tests and suggest where to start.',
  'List the TODO comments and rank them by effort.',
];

/** What a thread shows before its first message. */
export function EmptyThread({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="th-empty">
      <p>Ask about this project or describe a change</p>
      <ul className="th-examples" aria-label="Example prompts">
        {prompts.map((prompt) => (
          <li key={prompt}>
            <button type="button" onClick={() => onPick(prompt)}>
              {prompt}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
