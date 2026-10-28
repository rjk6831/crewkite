// The reference extension for extension contract 1. It adds one thread action that counts the
// recent messages of the thread it runs on. It asks for thread.read only, so the controller hands
// it a reader bound to that one thread and nothing else.

// The context has the shape of ExtensionContext in @crewkite/contracts.
function countMessages(context) {
  if (!context.thread?.read) return { text: 'Run this from a thread.' };
  const thread = context.thread.read();
  const counts = { person: 0, assistant: 0, system: 0 };
  for (const message of thread.messages) counts[message.author] += 1;
  return {
    text: `This thread has ${thread.messages.length} recent messages.`,
    rows: [
      { label: 'From you', value: String(counts.person) },
      { label: 'Replies', value: String(counts.assistant) },
      { label: 'System lines', value: String(counts.system) },
    ],
  };
}

export const commands = { 'count-messages': countMessages };
