import type { Artifact } from '@crewkite/contracts';
import { useEffect, useRef, useState } from 'react';
import type { Workspace } from './source.ts';

export function OutputView({ artifact, workspace }: { artifact: Artifact; workspace: Workspace }) {
  const [page, setPage] = useState<{
    offset: number;
    end: number;
    text: string;
    eof: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verification, setVerification] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const decoder = useRef(new TextDecoder('utf-8', { fatal: true }));
  const generation = useRef(0);
  const verificationId = useRef<string | null>(null);
  const busy = useRef(false);
  const failedOffset = useRef<number | null>(null);
  const { readArtifactRange, verifyArtifact, cancelArtifactVerification } = workspace;
  useEffect(
    () => () => {
      generation.current++;
      if (verificationId.current)
        void cancelArtifactVerification(verificationId.current).catch(() => {});
    },
    [cancelArtifactVerification],
  );
  async function load(restart = false) {
    if (busy.current) return;
    busy.current = true;
    const token = generation.current;
    setLoading(true);
    setError(null);
    const offset = restart ? 0 : (failedOffset.current ?? page?.end ?? 0);
    let decoding = false;
    try {
      const result = await readArtifactRange(artifact, offset);
      if (token !== generation.current) return;
      const content = atob(result.content);
      const bytes = Uint8Array.from(content, (character) => character.charCodeAt(0));
      const nextDecoder =
        offset === 0 ? new TextDecoder('utf-8', { fatal: true }) : decoder.current;
      decoding = true;
      const text = nextDecoder.decode(bytes, { stream: !result.eof });
      decoder.current = nextDecoder;
      failedOffset.current = null;
      setPage({ offset, end: offset + bytes.length, text, eof: result.eof });
    } catch (failure) {
      failedOffset.current = decoding ? 0 : offset;
      if (token === generation.current)
        setError(failure instanceof Error ? failure.message : 'Output is unavailable.');
    } finally {
      if (token === generation.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  }
  async function verify() {
    if (verificationId.current) return;
    const requestId = crypto.randomUUID();
    verificationId.current = requestId;
    setVerifying(true);
    setVerification(null);
    try {
      await verifyArtifact(requestId, artifact);
      if (verificationId.current === requestId)
        setVerification('Complete output checksum verified.');
    } catch (failure) {
      if (verificationId.current === requestId)
        setVerification(failure instanceof Error ? failure.message : 'Output verification failed.');
    } finally {
      if (verificationId.current === requestId) {
        verificationId.current = null;
        setVerifying(false);
      }
    }
  }
  return (
    <section aria-label={`Output ${artifact.id}`} className="view-stack">
      <p className="muted small">
        Retained output: {artifact.bytes} bytes. Pages are displayed without a whole-file checksum
        proof.
      </p>
      <div className="dialog-footer">
        <button
          type="button"
          className="text-button"
          disabled={loading || (page?.eof && failedOffset.current === null)}
          onClick={() => void load()}
        >
          {error ? 'Retry output page' : page ? 'Next output page' : 'Read output'}
        </button>
        <button
          type="button"
          className="text-button"
          disabled={loading}
          onClick={() => void load(true)}
        >
          Restart output
        </button>
        <button
          type="button"
          className="text-button"
          disabled={verifying}
          onClick={() => void verify()}
        >
          Verify complete output
        </button>
        {verifying && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              if (verificationId.current)
                void cancelArtifactVerification(verificationId.current).catch((failure) =>
                  setVerification(String(failure)),
                );
            }}
          >
            Cancel verification
          </button>
        )}
      </div>
      {loading && <p role="status">Reading one output page...</p>}
      {error && <p role="alert">{error} Retry this page or restart output.</p>}
      {page && (
        <>
          <p role="status">
            Bytes {page.offset}-{page.end} of {artifact.bytes}.{' '}
            {page.eof ? 'End of retained output.' : 'More output remains.'}
          </p>
          <pre className="worker-output">{page.text}</pre>
        </>
      )}
      {verifying && <p role="status">Verifying the complete output...</p>}
      {verification && <p role="status">{verification}</p>}
    </section>
  );
}
