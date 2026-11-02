// A reply can quote the absolute path of the scratch copy it ran in, such as
// /Users/me/.../chat/tsk_1/slices/2/copy/src/money.js:6. The person reads paths from the project
// root, so the copy's own prefix comes off in shown text and in link targets alike. An older
// thread's copy is chat/<task>/scratch. A newer one is named after the project, as in
// chat/tsk_1/demo-shop, and the other folders beside it (files, turns, sessions) stay.
const SCRATCH_ROOT =
  /(?:file:\/\/)?(?:\/[^\s/()[\]<>"'`]+)*?\/chat\/(?:[A-Za-z0-9_-]+\/(?:scratch|slices\/\d+\/copy)|tsk_[A-Za-z0-9]+\/(?!(?:files|turns|sessions|slices)(?![a-z0-9-])|accept-)[a-z0-9]+(?:-[a-z0-9]+)*)(\/|(?=[\s)\]>"'`:,;]|$))/g;

/** The text with every scratch copy prefix taken off. The copy root alone reads as `.`. */
export function projectRelative(text: string): string {
  return text.includes('/chat/')
    ? text.replace(SCRATCH_ROOT, (_match, slash: string) => (slash ? '' : '.'))
    : text;
}
