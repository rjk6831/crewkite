// Operations that a running service in this process owns outside the task operations class,
// such as project checks in a chat thread. Task operations recovery leaves them alone.
export const liveOperations = new Set<string>();
