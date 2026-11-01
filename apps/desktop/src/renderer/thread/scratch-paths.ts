// A reply can quote the absolute path of the scratch copy it ran in, such as
// /Users/me/.../chat/tsk_1/slices/2/copy/src/money.js:6. The person reads paths from the project
// root, so the copy's own prefix comes off in shown text and in link targets alike.
const SCRATCH_ROOT =
  /(?:file:\/\/)?(?:\/[^\s/()[\]<>"'`]+)*?\/chat\/[A-Za-z0-9_-]+\/(?:scratch|slices\/\d+\/copy)(\/|(?=[\s)\]>"'`:,;]|$))/g;

/** The text with every scratch copy prefix taken off. The copy root alone reads as `.`. */
export function projectRelative(text: string): string {
  return text.includes('/chat/')
    ? text.replace(SCRATCH_ROOT, (_match, slash: string) => (slash ? '' : '.'))
    : text;
}
