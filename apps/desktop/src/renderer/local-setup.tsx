import { LocalEndpointSchema, type WorkspaceState } from '@crewkite/contracts';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Fact } from './components.tsx';
import { ExternalLink } from './external-link.tsx';
import {
  connectLocalFlow,
  lastSeen,
  lowMemory,
  REOBSERVE_MS,
  selectionConfirmed,
  selectionLost,
  setupReasons,
  WITHOUT_TOKEN,
  waitForLocalReadiness,
} from './local-setup-flow.ts';
import { useClock } from './settings/use-catalog.ts';
import type { DesktopCommand, Workspace } from './source.ts';

export const localModelStates = {
  'installed-unloaded': 'Installed and unloaded',
  'loaded-eligible': 'Loaded and eligible',
  incompatible: 'Incompatible',
};
const modelReasons = {
  'unsupported-format': 'Unsupported model format',
  'remote-model': 'Remote model',
  'identity-ambiguous': 'Model identity is ambiguous',
  'multiple-resident-models': 'More than one language model is loaded',
  'resident-embedding': 'Embedding model is resident',
  busy: 'Model is busy',
  context: 'Loaded context length is not usable',
  draft: 'Draft model is configured',
  'not-downloaded': 'Model is not downloaded',
};
const applied = (outcome: string) => outcome === 'applied' || outcome === 'already-applied';

export function LocalSetup({
  snapshot,
  workspace,
}: {
  snapshot: Pick<WorkspaceState, 'localSetup' | 'localHardware'>;
  workspace: Workspace;
}) {
  const setup = snapshot.localSetup;
  const authMode = setup?.authMode ?? 'token';
  const connectionReady = setup?.connected ?? setup?.secretConfigured ?? false;
  const [endpoint, setEndpoint] = useState(setup?.endpoint ?? '');
  const [endpointEdited, setEndpointEdited] = useState(false);
  const [choiceId, setChoiceId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [requested, setRequested] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const pollAbort = useRef<AbortController | null>(null);
  const actionGeneration = useRef(0);
  const mounted = useRef(true);
  const titleId = useId();
  const endpointErrorId = useId();
  const parsedEndpoint = LocalEndpointSchema.safeParse(endpoint);
  const endpointError = endpoint.length > 0 && !parsedEndpoint.success;
  const connected = workspace.connection === 'connected' && !workspace.preview;
  const busy = Boolean(workspace.pending || requested);
  const owned = Boolean(setup?.operation || (setup && setup.generation !== 'idle'));
  const blocked = !connected || busy || workspace.retryAvailable || !setup || owned;
  const models = setup?.observation?.models;
  const selectedChoice = models?.find((model) => model.selectionId === choiceId);
  const currentChoice = models?.find(
    (model) => model.selectionId === setup?.selection?.selectionId,
  );
  const now = useClock(null, 30_000);
  // Without a live connection the observation is the last one read. It shows, labelled, and its
  // controls stay off until a fresh read replaces it.
  const stale = !!setup?.observation && !connectionReady;
  const stamp = stale ? lastSeen(setup?.observedAt, now) : null;
  const [lastChoice, setLastChoice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const observing = useRef(false);
  useEffect(() => {
    if (currentChoice) setLastChoice(currentChoice.identity.displayName);
  }, [currentChoice]);
  const lost = selectionLost(lastChoice, setup);
  const confirmed = confirming !== null && selectionConfirmed(setup, confirming);
  const memory = lowMemory(setup, snapshot.localHardware);
  const residents = setup?.observation?.residents ?? [];
  // A read on the open connection needs no token. It asks the controller to read the runtime and
  // waits for the read to end, so the card shows what the runtime holds now.
  const { source, preview, refresh } = workspace;
  const reobserve = useCallback(async (): Promise<string | null> => {
    if (!source || preview || observing.current) return null;
    observing.current = true;
    try {
      const fresh = (await refresh()).localSetup;
      if (!fresh?.connected || fresh.operation || fresh.generation !== 'idle') return null;
      const result = await source.command({
        command: 'RefreshLocalModels',
        expectedRevision: fresh.revision,
        payload: { consent: 'explicit' },
      });
      if (!applied(result.outcome))
        return result.next ?? result.reason ?? 'The runtime could not be read.';
      for (let step = 0; step < 20 && mounted.current; step++) {
        if (!(await refresh()).localSetup?.operation) break;
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      return null;
    } catch {
      return 'The runtime could not be read. Reconnect and try again.';
    } finally {
      observing.current = false;
    }
  }, [source, preview, refresh]);
  // When Settings opens, when the window comes back, and every 15 seconds while it stays open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `requested` is read when a read starts
  useEffect(() => {
    if (!connectionReady) return;
    const read = () => {
      if (!requested && !pollAbort.current) void reobserve();
    };
    read();
    const timer = window.setInterval(read, REOBSERVE_MS);
    window.addEventListener('focus', read);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', read);
    };
  }, [connectionReady, reobserve]);
  useEffect(() => {
    if (!endpointEdited) setEndpoint(setup?.endpoint ?? '');
  }, [setup?.endpoint, endpointEdited]);
  useEffect(() => {
    setChoiceId((current) =>
      models?.some((model) => model.selectionId === current)
        ? current
        : (setup?.selection?.selectionId ?? null),
    );
  }, [models, setup?.selection?.selectionId]);
  useEffect(
    () => () => {
      mounted.current = false;
      actionGeneration.current++;
      pollAbort.current?.abort();
    },
    [],
  );
  function stopPolling() {
    actionGeneration.current++;
    pollAbort.current?.abort();
    pollAbort.current = null;
    setPolling(false);
  }
  function startPolling(targetEndpoint: string) {
    if (pollAbort.current) return;
    const control = new AbortController();
    const generation = actionGeneration.current;
    pollAbort.current = control;
    setPolling(true);
    setPollTimedOut(false);
    setMessage('Waiting for the connection and model metadata.');
    void waitForLocalReadiness({
      endpoint: targetEndpoint,
      active: () =>
        mounted.current && !control.signal.aborted && actionGeneration.current === generation,
      wait: () =>
        new Promise<void>((resolve) => {
          const stopped = () => {
            window.clearTimeout(timer);
            resolve();
          };
          const timer = window.setTimeout(() => {
            control.signal.removeEventListener('abort', stopped);
            resolve();
          }, 1000);
          control.signal.addEventListener('abort', stopped, { once: true });
        }),
      read: async () => (await refresh()).localSetup,
      discover: async (current) => {
        const result = await workspace.command({
          command: 'RefreshLocalModels',
          expectedRevision: current.revision,
          payload: { consent: 'explicit' },
        });
        if (control.signal.aborted || !mounted.current || actionGeneration.current !== generation)
          return false;
        if (applied(result.outcome)) return true;
        setMessage(result.next ?? result.reason ?? 'Model metadata could not be read.');
        return false;
      },
    })
      .then((result) => {
        if (control.signal.aborted || !mounted.current) return;
        if (result === 'ready') setMessage('Connection and model metadata are ready.');
        if (result === 'timeout') {
          setPollTimedOut(true);
          setMessage('Taking longer than expected. Try Refresh.');
        }
      })
      .catch(() => {
        if (!control.signal.aborted && mounted.current)
          setMessage('Local status could not be refreshed. Reconnect and try again.');
      })
      .finally(() => {
        if (pollAbort.current === control && mounted.current) {
          pollAbort.current = null;
          setPolling(false);
        }
      });
  }
  async function action(name: string, command: DesktopCommand) {
    if (!connected || workspace.retryAvailable || requested) return;
    setRequested(name);
    setMessage(null);
    try {
      const result = await workspace.command(command);
      if (!mounted.current) return;
      const done = applied(result.outcome);
      const said =
        command.command === 'SelectLocalModel'
          ? 'Reading the runtime to confirm the selection.'
          : command.command === 'BeginLocalConnectionInput' ||
              command.command === 'RefreshLocalModels'
            ? `${name} requested. Watch the saved status.`
            : command.command === 'CancelLocalConnectionInput'
              ? 'Cancellation requested. Refresh saved status until ownership is settled.'
              : `${name} confirmed.`;
      setMessage(done ? said : (result.next ?? result.reason ?? `${name} was not confirmed.`));
      if (done && command.command === 'SelectLocalModel') {
        // The command only saved the choice. It counts once a read made after it still holds the
        // instance.
        setConfirming(Date.now());
        void reobserve().then((problem) => problem && mounted.current && setMessage(problem));
      }
      if (done && command.command === 'DisconnectLocal') {
        setLastChoice(null);
        setConfirming(null);
      }
      if (applied(result.outcome) && command.command === 'ConfigureLocal') setEndpointEdited(false);
    } catch {
      if (mounted.current)
        setMessage(`${name} could not be confirmed. Reconnect and use exact retry if available.`);
    } finally {
      if (mounted.current) setRequested(null);
    }
  }
  async function connectLocal() {
    if (!setup || !parsedEndpoint.success || !connected || workspace.retryAvailable || requested)
      return;
    stopPolling();
    const generation = actionGeneration.current;
    setRequested('Local connection');
    setMessage(null);
    setPollTimedOut(false);
    try {
      const result = await connectLocalFlow({
        setup,
        endpoint: parsedEndpoint.data,
        authMode,
        command: workspace.command,
        active: () => mounted.current && actionGeneration.current === generation,
      });
      if (result.kind === 'stopped') return;
      if (result.kind === 'blocked') {
        setMessage(
          result.result.next ?? result.result.reason ?? 'Local connection was not confirmed.',
        );
        return;
      }
      setEndpointEdited(false);
      startPolling(parsedEndpoint.data);
    } catch {
      if (mounted.current && actionGeneration.current === generation)
        setMessage(
          'Local connection could not be confirmed. Reconnect and use exact retry if available.',
        );
    } finally {
      if (mounted.current && actionGeneration.current === generation) setRequested(null);
    }
  }
  return (
    <section className="card view-stack" aria-labelledby={titleId}>
      <div className="section-heading">
        <h2 id={titleId}>Local setup</h2>
        <span>Writer setup</span>
      </div>
      <p className="muted small">
        Connect to an existing Local runtime using its saved authentication mode. Dedicated token
        opens a native input window. No authentication connects without a token to this device's
        loopback endpoint. CrewKite does not change the runtime's authentication setting or load a
        model. Load the model in the Local app when needed.
      </p>
      <p className="notice" role="status">
        {setup?.reason
          ? setup.reason === 'connection-required' && authMode === 'none'
            ? 'Connect to the configured Local runtime.'
            : setupReasons[setup.reason]
          : setup
            ? 'Inspect the saved connection and model state.'
            : 'Local setup is unavailable. Reconnect to recover current status.'}
      </p>
      {stamp && (
        <p className="notice" role="status">
          {stamp}
        </p>
      )}
      {connectionReady && !setup?.secretConfigured && (
        <p className="notice" role="status">
          {WITHOUT_TOKEN}
        </p>
      )}
      {lost && (
        <p className="notice" role="status">
          {lost}
        </p>
      )}
      {confirmed && (
        <p className="notice" role="status">
          Model selection confirmed
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {workspace.retryAvailable && (
        <div className="button-row">
          <p className="muted small">
            The last command is uncertain. Resolve it before changing Local setup.
          </p>
          <button
            className="button secondary"
            type="button"
            disabled={!connected || busy}
            onClick={() => {
              void workspace
                .retryCommand()
                .then((result) =>
                  setMessage(
                    result
                      ? (result.next ?? result.reason ?? result.outcome)
                      : 'No exact command is pending.',
                  ),
                )
                .catch(() =>
                  setMessage('Exact retry could not be confirmed. Reconnect and retry.'),
                );
            }}
          >
            Retry exact command
          </button>
        </div>
      )}
      <label>
        Local endpoint
        <input
          value={endpoint}
          placeholder="ws://127.0.0.1:port"
          spellCheck={false}
          disabled={busy}
          aria-invalid={endpointError}
          aria-describedby={endpointError ? endpointErrorId : undefined}
          onChange={(event) => {
            stopPolling();
            setEndpoint(event.target.value);
            setEndpointEdited(true);
            setPollTimedOut(false);
          }}
        />
      </label>
      {endpointError && (
        <p className="notice" role="alert" id={endpointErrorId}>
          Use ws://127.0.0.1 with a port from 1 to 65535.
        </p>
      )}
      <div className="button-row">
        <button
          className="button primary"
          type="button"
          disabled={blocked || polling || !parsedEndpoint.success}
          onClick={() => {
            void connectLocal();
          }}
        >
          Connect
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={!connected || busy || workspace.retryAvailable || !setup?.endpoint}
          onClick={() => {
            stopPolling();
            if (setup)
              void action('Disconnect', {
                command: 'DisconnectLocal',
                expectedRevision: setup.revision,
                payload: {},
              });
          }}
        >
          Disconnect Local
        </button>
      </div>
      <p className="muted small">
        With a token: Connect opens a window for the runtime token. CrewKite keeps it in memory
        only, so it asks again after a restart.
      </p>
      <p className="muted small">
        Without a token: when the runtime has auth off on loopback, Connect finishes with no prompt.{' '}
        <ExternalLink href="https://github.com/rjk6831/crewkite/blob/main/docs/local-models.md">
          Local models
        </ExternalLink>
      </p>
      {setup?.operation && (
        <div className="button-row">
          <p className="muted small" role="status">
            {setup.operation.kind === 'input' ? 'Connection input' : 'Model discovery'} ·{' '}
            {setup.operation.state}
          </p>
          {setup.operation.kind === 'input' && (
            <button
              className="button secondary"
              type="button"
              disabled={!connected || busy || workspace.retryAvailable}
              onClick={() => {
                stopPolling();
                if (setup.operation?.kind === 'input')
                  void action('Connection input cancellation', {
                    command: 'CancelLocalConnectionInput',
                    expectedRevision: setup.revision,
                    payload: { operationId: setup.operation.operationId },
                  });
              }}
            >
              Cancel connection input
            </button>
          )}
        </div>
      )}
      <div className="facts-grid">
        <Fact label="Saved endpoint" value={setup?.endpoint ?? 'Unconfigured'} />
        <Fact
          label="Authentication"
          value={authMode === 'none' ? 'No authentication, this device only' : 'Dedicated token'}
        />
        <Fact label="Connection" value={connectionReady ? 'Connected' : 'Not connected'} />
        <Fact label="Generation" value={setup?.generation ?? 'Unknown'} />
        <Fact
          label="Selected model"
          value={
            currentChoice?.identity.displayName ??
            (setup?.selection ? 'Previous observation' : 'None')
          }
        />
      </div>
      {setup?.observation && (
        <>
          <p className="muted small">
            Runtime {setup.observation.runtime.version} · Build {setup.observation.runtime.build} ·{' '}
            {setup.observation.residentLlms} resident language models ·{' '}
            {setup.observation.embeddingInstances} embedding instances
          </p>
          {memory && (
            <p className="notice" role="status">
              {memory}
            </p>
          )}
          {residents.length > 0 && (
            <ul className="muted small" aria-label="Loaded models">
              {residents.map((resident) => {
                const name =
                  models?.find((model) => model.identity.modelKey === resident.modelKey)?.identity
                    .displayName ?? resident.modelKey;
                const selected =
                  !!currentChoice && currentChoice.instanceReference === resident.instanceReference;
                return (
                  <li key={resident.instanceReference}>
                    {name} · {(resident.sizeBytes / 1024 ** 3).toFixed(1)} GB ·{' '}
                    {resident.contextLength?.toLocaleString('en-US') ?? 'unknown'} context
                    {selected ? ' · selected' : ''}
                  </li>
                );
              })}
            </ul>
          )}
          {models?.length ? (
            <>
              <label>
                Observed Local model
                <select
                  value={choiceId ?? ''}
                  disabled={blocked || stale}
                  onChange={(event) => {
                    const next = models.find((model) => model.selectionId === event.target.value);
                    setChoiceId(next?.selectionId ?? null);
                    if (next && setup.observation)
                      void action('Model selection', {
                        command: 'SelectLocalModel',
                        expectedRevision: setup.revision,
                        payload: {
                          selectionId: next.selectionId,
                          observationHash: setup.observation.observationHash,
                        },
                      });
                  }}
                >
                  <option value="">Choose an observed model</option>
                  {models.map((model) => (
                    <option
                      key={model.selectionId}
                      value={model.selectionId}
                      disabled={model.state === 'incompatible'}
                    >
                      {model.identity.displayName} · {localModelStates[model.state]}
                      {model.reasons.length
                        ? ` · ${model.reasons.map((reason) => modelReasons[reason]).join(', ')}`
                        : ''}
                    </option>
                  ))}
                </select>
              </label>
              {selectedChoice && (
                <div className="facts-grid">
                  <Fact label="Observed state" value={localModelStates[selectedChoice.state]} />
                  <Fact label="Format" value={selectedChoice.identity.format} />
                  <Fact
                    label="Size"
                    value={`${selectedChoice.identity.sizeBytes.toLocaleString()} bytes`}
                  />
                  <Fact
                    label="Quantization"
                    value={selectedChoice.identity.quantization?.name ?? 'Unknown'}
                  />
                  <Fact
                    label="Variant"
                    value={selectedChoice.identity.selectedVariant ?? 'Unknown'}
                  />
                  <Fact
                    label="Context"
                    value={selectedChoice.contextLength?.toLocaleString() ?? 'Unknown'}
                  />
                </div>
              )}
              <details className="technical-details">
                <summary>Observed model details</summary>
                {models.map((model) => (
                  <div key={model.selectionId}>
                    <p>
                      {model.identity.displayName} · {localModelStates[model.state]} · Unqualified
                    </p>
                    <code>{model.identity.modelKey}</code>
                    {model.reasons.map((reason) => (
                      <p key={reason}>{modelReasons[reason]}</p>
                    ))}
                    <code>Metadata {model.identity.metadataHash}</code>
                  </div>
                ))}
              </details>
            </>
          ) : (
            <p className="muted">The runtime reported no model choices.</p>
          )}
        </>
      )}
      <p className="muted small">
        Model loading and unloading stay in the Local app. Local lead and orchestrator roles remain
        unqualified.
      </p>
      <button
        className="button secondary"
        type="button"
        disabled={!connected || busy || polling || !connectionReady || workspace.retryAvailable}
        onClick={() => {
          if (pollTimedOut && setup?.endpoint) startPolling(setup.endpoint);
          else void reobserve().then((problem) => mounted.current && setMessage(problem));
        }}
      >
        Refresh
      </button>
    </section>
  );
}
