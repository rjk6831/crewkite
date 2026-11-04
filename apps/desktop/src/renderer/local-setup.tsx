import type { LocalTokenStatus } from '@crewkite/client';
import {
  LocalEndpointSchema,
  type LocalSetup as LocalSetupState,
  type WorkspaceState,
} from '@crewkite/contracts';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Fact } from './components.tsx';
import { ExternalLink } from './external-link.tsx';
import { formatSize } from './format-size.ts';
import {
  connectInPlace,
  connectLocalFlow,
  DEFAULT_LOCAL_ENDPOINT,
  followDiscovery,
  LAUNCH_RETRY_MS,
  lastSeen,
  launchReconnect,
  localNotices,
  lowMemory,
  REOBSERVE_MS,
  selectionConfirmed,
  selectionLost,
  settledLine,
  statusLine,
  WAITING_LINE,
  WITHOUT_TOKEN,
  waitForLocalReadiness,
} from './local-setup-flow.ts';
import { useClock } from './settings/use-catalog.ts';
import { type DesktopCommand, localResultLine, type Workspace } from './source.ts';

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
  busy: 'Busy',
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
  // With nothing saved the field starts on the runtime's usual port, so Connect works as it is.
  const [endpoint, setEndpoint] = useState(setup?.endpoint ?? DEFAULT_LOCAL_ENDPOINT);
  const [endpointEdited, setEndpointEdited] = useState(false);
  const [choiceId, setChoiceId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [requested, setRequested] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const [remembered, setRemembered] = useState<LocalTokenStatus | null>(null);
  const held = useRef<string | null>(null);
  const pollAbort = useRef<AbortController | null>(null);
  const actionGeneration = useRef(0);
  const mounted = useRef(true);
  const titleId = useId();
  const endpointErrorId = useId();
  const parsedEndpoint = LocalEndpointSchema.safeParse(endpoint);
  const endpointError = endpoint.length > 0 && !parsedEndpoint.success;
  const connected = workspace.connection === 'connected' && !workspace.preview;
  const busy = Boolean(workspace.pending || requested);
  // The model read the card starts on its own, on open, every 15 seconds and when the window
  // comes back, leaves the controls as they were. Greying them for each read made Settings blink.
  const backgroundRead = quiet && setup?.operation?.kind === 'discovery';
  const owned = Boolean(
    (setup?.operation && !backgroundRead) || (setup && setup.generation !== 'idle'),
  );
  const blocked = !connected || busy || !setup || owned;
  const models = setup?.observation?.models;
  const selectedChoice = models?.find((model) => model.selectionId === choiceId);
  const currentChoice = models?.find(
    (model) => model.selectionId === setup?.selection?.selectionId,
  );
  const now = useClock(null, 30_000);
  // Without a live connection, or on a new one before its first read, the observation is the last
  // one read. It shows, labelled, and its controls stay off until a fresh read replaces it.
  const stale = !!setup?.observation && (!connectionReady || !!setup.observationStale);
  const stamp = stale ? lastSeen(setup?.observedAt, now, connectionReady) : null;
  const [lastChoice, setLastChoice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  // The model read the card runs, so an action can wait for it to end.
  const observing = useRef<Promise<void> | null>(null);
  const connecting = useRef(false);
  useEffect(() => {
    if (currentChoice) setLastChoice(currentChoice.identity.displayName);
  }, [currentChoice]);
  const lost = selectionLost(lastChoice, setup);
  const confirmed = confirming !== null && selectionConfirmed(setup, confirming);
  const memory = lowMemory(setup, snapshot.localHardware);
  const notices = localNotices({
    setup,
    message,
    following: polling,
    connected: connectionReady,
    stamp,
  });
  const status = statusLine({
    setup,
    message: notices.message,
    lost,
    confirmed,
    quiet,
    held: held.current,
  });
  // The line to return to while a read the card started runs on its own.
  useEffect(() => {
    if (!(quiet && setup?.reason === 'discovery-active'))
      held.current = statusLine({
        setup,
        message: null,
        lost: null,
        confirmed: false,
        quiet,
        held: null,
      });
  });
  const residents = setup?.observation?.residents ?? [];
  // A read on the open connection needs no token. It asks the controller to read the runtime and
  // waits for the read to end, so the card shows what the runtime holds now.
  const { source, preview, refresh } = workspace;
  const reobserve = useCallback(
    async (background = false): Promise<string | null> => {
      if (!source || preview || observing.current || (background && connecting.current))
        return null;
      const ended = Promise.withResolvers<void>();
      observing.current = ended.promise;
      // A read the card starts on its own posts no line. Only a change in what is loaded does.
      if (background) setQuiet(true);
      try {
        const fresh = (await refresh()).localSetup;
        if (!fresh?.connected || fresh.operation || fresh.generation !== 'idle') return null;
        const result = await source.command({
          command: 'RefreshLocalModels',
          expectedRevision: fresh.revision,
          payload: { consent: 'explicit' },
        });
        if (!applied(result.outcome))
          return localResultLine(result, 'The runtime could not be read.');
        await followDiscovery({
          read: async () => (await refresh()).localSetup,
          wait: () => new Promise((resolve) => window.setTimeout(resolve, 500)),
          active: () => mounted.current,
        });
        return null;
      } catch {
        return 'The runtime could not be read. Reconnect and try again.';
      } finally {
        observing.current = null;
        ended.resolve();
        if (mounted.current) setQuiet(false);
      }
    },
    [source, preview, refresh],
  );
  // When Settings opens, when the window comes back, and every 15 seconds while it stays open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `requested` is read when a read starts
  useEffect(() => {
    if (!connectionReady) return;
    const read = () => {
      if (!requested && !pollAbort.current) void reobserve(true);
    };
    read();
    const timer = window.setInterval(read, REOBSERVE_MS);
    window.addEventListener('focus', read);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', read);
    };
  }, [connectionReady, reobserve]);
  // What this device keeps for the saved endpoint. It changes with the endpoint and with a
  // connect that held a token, so it is read again then.
  const tokenHeld = Boolean(setup?.secretConfigured) && setup?.connectedWithoutToken === false;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the inputs name when the answer can change
  useEffect(() => {
    if (!source?.localTokenStatus || preview) return;
    let live = true;
    void source
      .localTokenStatus()
      .then((status) => live && setRemembered(status))
      .catch(() => live && setRemembered(null));
    return () => {
      live = false;
    };
  }, [source, preview, setup?.endpoint, setup?.authMode, tokenHeld]);
  async function keepToken(keep: boolean) {
    const change = keep ? source?.rememberLocalToken : source?.forgetLocalToken;
    if (!change || requested) return;
    setRequested(keep ? 'Remember' : 'Forget');
    setMessage(null);
    try {
      const status = await change.call(source);
      if (!mounted.current) return;
      setRemembered(status);
      // The kept-token line under the buttons already says a token is kept.
      if (status.remembered !== keep)
        setMessage(status.reason ?? 'The token setting was not changed.');
      else if (!keep) setMessage('The kept token is removed from this device.');
    } catch {
      if (mounted.current) setMessage('The token setting could not be changed. Try again.');
    } finally {
      if (mounted.current) setRequested(null);
    }
  }
  useEffect(() => {
    if (!endpointEdited) setEndpoint(setup?.endpoint ?? DEFAULT_LOCAL_ENDPOINT);
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
    setMessage(WAITING_LINE);
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
        setMessage(localResultLine(result, 'Model metadata could not be read.'));
        return false;
      },
      reconnect: async (current) => {
        const result = await workspace.command({
          command: 'BeginLocalConnectionInput',
          expectedRevision: current.revision,
          payload: { consent: 'explicit' },
        });
        if (control.signal.aborted || !mounted.current || actionGeneration.current !== generation)
          return false;
        if (applied(result.outcome)) return true;
        setMessage(localResultLine(result, 'Local connection was not confirmed.'));
        return false;
      },
    })
      .then((result) => {
        if (control.signal.aborted || !mounted.current) return;
        // A connect that ended without a connection leaves the card's reason line, such as a
        // failed connection, in place of the waiting line.
        // A refusal said during the follow stays. Only the waiting line goes.
        if (result === 'ready' || (result === 'stopped' && actionGeneration.current === generation))
          setMessage((current) => (current === WAITING_LINE ? null : current));
        if (result === 'timeout') {
          setPollTimedOut(true);
          setMessage('Taking longer than expected. Try Refresh model list.');
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
  // The controls stay on during a model read the card runs, and the controller refuses a change
  // while it runs. An action pressed then waits for the read to end and goes with the setup that
  // read left. Null when there was no read to wait for.
  async function afterRead(): Promise<LocalSetupState | null | undefined> {
    const running = observing.current;
    if (!running) return null;
    await running;
    return (await refresh()).localSetup;
  }
  async function action(name: string, command: DesktopCommand) {
    if (!connected || requested) return;
    setRequested(name);
    setMessage(null);
    setConfirming(null);
    try {
      const fresh = await afterRead();
      if (!mounted.current) return;
      const result = await workspace.command(
        fresh && 'expectedRevision' in command
          ? { ...command, expectedRevision: fresh.revision }
          : command,
      );
      if (!mounted.current) return;
      const done = applied(result.outcome);
      const said =
        command.command === 'SelectLocalModel'
          ? 'Reading the runtime to confirm the selection.'
          : command.command === 'BeginLocalConnectionInput' ||
              command.command === 'RefreshLocalModels'
            ? `${name} requested. Watch the saved status.`
            : command.command === 'CancelLocalConnectionInput'
              ? 'Connection input closed. Local is not connected.'
              : `${name} confirmed.`;
      setMessage(done ? said : localResultLine(result, `${name} was not confirmed.`));
      if (done && command.command === 'SelectLocalModel') {
        // The command only saved the choice. It counts once a read made after it still holds the
        // instance.
        setConfirming(Date.now());
        void reobserve().then((problem) => mounted.current && setMessage(problem));
      }
      if (done && command.command === 'DisconnectLocal') {
        setLastChoice(null);
        setConfirming(null);
      }
    } catch {
      if (mounted.current) setMessage(`${name} could not be confirmed. Reconnect, then try again.`);
    } finally {
      if (mounted.current) setRequested(null);
    }
  }
  async function connectLocal() {
    if (!setup || !parsedEndpoint.success || !connected || requested) return;
    stopPolling();
    const generation = actionGeneration.current;
    const active = () => mounted.current && actionGeneration.current === generation;
    setRequested('Local connection');
    // Every Connect starts from a clean card: no line from an earlier attempt stays on it.
    setMessage(null);
    setConfirming(null);
    setPollTimedOut(false);
    connecting.current = true;
    try {
      const fresh = await afterRead();
      if (!active()) return;
      const result = await connectLocalFlow({
        setup: fresh ?? setup,
        endpoint: parsedEndpoint.data,
        command: workspace.command,
        // A read started elsewhere, such as the model picker, holds the runtime for a moment.
        wait: () => new Promise((resolve) => window.setTimeout(resolve, 1000)),
        active,
      });
      if (result.kind === 'stopped') return;
      if (result.kind === 'blocked') {
        setMessage(localResultLine(result.result, 'Local connection was not confirmed.'));
        return;
      }
      setEndpointEdited(false);
      startPolling(parsedEndpoint.data);
    } catch {
      if (mounted.current && actionGeneration.current === generation)
        setMessage('Local connection could not be confirmed. Reconnect, then press Connect again.');
    } finally {
      connecting.current = false;
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
        Connect to an existing Local runtime on this device. Every Connect checks whether the
        runtime wants a token. When it does, a native window asks for it. CrewKite does not change
        the runtime's authentication setting or load a model. Load the model in the Local app when
        needed.{' '}
        <ExternalLink href="https://github.com/rjk6831/crewkite/blob/main/docs/local-models.md">
          Local models
        </ExternalLink>
      </p>
      <p className={settledLine(status) ? 'muted small' : 'notice'} role="status">
        {status}
      </p>
      {notices.stamp && (
        <p className="notice" role="status">
          {notices.stamp}
        </p>
      )}
      {notices.withoutToken && (
        <p className="muted small" role="status">
          {WITHOUT_TOKEN}
        </p>
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
          {requested === 'Local connection' || polling ? 'Connecting…' : 'Connect'}
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={!connected || busy || !setup?.endpoint}
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
      {/* Remember appears once a token was used. A saved no-token mode keeps no token. */}
      {remembered &&
        authMode === 'token' &&
        (remembered.remembered || (remembered.available && tokenHeld)) && (
          <div className="button-row">
            <p className="muted small">
              {remembered.remembered
                ? 'The token is kept on this device for this endpoint.'
                : 'Connect will not ask for it again after a restart.'}
            </p>
            <button
              className="button secondary"
              type="button"
              disabled={!connected || busy}
              onClick={() => void keepToken(!remembered.remembered)}
            >
              {remembered.remembered ? 'Forget' : 'Remember the token on this device'}
            </button>
          </div>
        )}
      {remembered &&
        authMode === 'token' &&
        !remembered.available &&
        !remembered.remembered &&
        tokenHeld && <p className="muted small">{remembered.reason}</p>}
      {setup?.operation && !(quiet && setup.operation.kind === 'discovery') && (
        <div className="button-row">
          <p className="muted small" role="status">
            {setup.operation.kind === 'input' ? 'Connection input' : 'Model discovery'} ·{' '}
            {setup.operation.state}
          </p>
          {setup.operation.kind === 'input' && (
            <button
              className="button secondary"
              type="button"
              disabled={!connected || busy}
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
          label="Connection"
          value={
            connectionReady
              ? setup?.connectedWithoutToken === true
                ? 'Connected, no token'
                : 'Connected'
              : 'Not connected'
          }
        />
        <Fact label="Generation" value={setup?.generation ?? 'Unknown'} />
        <Fact
          label="Selected model"
          value={
            // The pick shows at once. The controller's saved selection replaces it when it lands.
            currentChoice?.identity.displayName ??
            (requested === 'Model selection' ? selectedChoice?.identity.displayName : null) ??
            (setup?.selection ? 'Previous observation' : stale && lastChoice ? lastChoice : 'None')
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
                    {name} · {formatSize(resident.sizeBytes)} ·{' '}
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
                  <Fact
                    label="Observed state"
                    value={`${localModelStates[selectedChoice.state]}${selectedChoice.reasons.includes('busy') && selectedChoice.state === 'loaded-eligible' ? ' · Busy' : ''}`}
                  />
                  <Fact label="Format" value={selectedChoice.identity.format} />
                  <Fact label="Size" value={formatSize(selectedChoice.identity.sizeBytes)} />
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
        disabled={!connected || busy || polling || !connectionReady}
        onClick={() => {
          if (pollTimedOut && setup?.endpoint) startPolling(setup.endpoint);
          else void reobserve().then((problem) => mounted.current && setMessage(problem));
        }}
      >
        Refresh model list
      </button>
    </section>
  );
}

/**
 * Reconnects Local at launch on a device that connected it once, with no click. While the runtime
 * is not running the card says so and this tries again every few seconds until it answers.
 */
export function useLocalReconnect(workspace: Workspace) {
  const { source, header, preview, refresh } = workspace;
  const once = header?.providerConnections?.connectedOnce.includes('local') ?? false;
  const setup = header?.localSetup;
  const live = workspace.connection === 'connected' && !preview;
  const [remembered, setRemembered] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const running = useRef(false);
  const mounted = useRef(true);
  const timer = useRef(0);
  useEffect(
    () => () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
    },
    [],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the kept token belongs to the endpoint and mode
  useEffect(() => {
    if (!live || !once || !source?.localTokenStatus) return;
    let active = true;
    void source
      .localTokenStatus()
      .then((status) => active && setRemembered(status.remembered))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [live, once, source, setup?.endpoint, setup?.authMode]);
  const due = live && launchReconnect(setup, once, remembered);
  // The attempt outlives this effect on purpose. Its own connect command starts an operation,
  // which turns `due` off for a moment; cancelling there would drop the attempt and never set
  // the next try. A try that ends without a connection always schedules the next one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` schedules the next try
  useEffect(() => {
    if (!due || !setup || running.current) return;
    running.current = true;
    void connectInPlace({
      setup,
      command: (input) => workspace.command(input),
      read: async () => (await refresh()).localSetup,
      wait: () => new Promise((resolve) => window.setTimeout(resolve, 500)),
      active: () => mounted.current,
      unattended: true,
    })
      .catch(() => null)
      .then((result) => {
        running.current = false;
        if (mounted.current && result?.kind !== 'connected')
          timer.current = window.setTimeout(
            () => setAttempt((value) => value + 1),
            LAUNCH_RETRY_MS,
          );
      });
  }, [due, attempt]);
}
