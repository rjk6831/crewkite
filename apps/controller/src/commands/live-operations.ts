// Operations that a running service in this process owns: project checks in a chat thread,
// design preview passes and task operations. Recovery leaves them alone, and a check release
// refuses one of them, since its owner still ends it.
export const liveOperations = new Set<string>();
