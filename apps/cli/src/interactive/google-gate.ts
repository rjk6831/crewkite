// shortcut: the hook point for the Google terms gate, which the Google lane adds after this one
// merges. The interactive CLI calls it before any Google connection or usage read it starts, and
// stops when it answers false. Until the gate lands it answers true, as the CLI did before. Upgrade
// path: read the setup's googleTerms record, show the terms text, and send AcknowledgeGoogleTerms
// with its textVersion when the person agrees.
export async function beforeGoogleConnection(): Promise<boolean> {
  return true;
}
