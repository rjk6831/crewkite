import {
  LocalEndpointSchema,
  type LocalSetup as LocalSetupState,
  type Snapshot,
} from '@crewkite/contracts';
import { useEffect, useId, useState } from 'react';
import { Fact } from './components.tsx';
import type { DesktopCommand, Workspace } from './source.ts';

const setupReasons: Record<NonNullable<LocalSetupState['reason']>, string> = {
  unconfigured: 'Configure a loopback endpoint first.',
  'connection-required': 'Connect through the native input window.',
  'connection-unavailable':
    'Local connection failed. Confirm the server authentication setting matches this connection.',
  'input-active': 'The native connection input window is open.',
  'input-unknown': 'Connection input ownership is unknown. Refresh saved status before continuing.',
  'discovery-required': 'Refresh the model list to observe the connected runtime.',
  'discovery-active': 'The controller is reading model metadata.',
  'discovery-unknown':
    'Model discovery ownership is unknown. Refresh saved status before continuing.',
  'model-selection-required': 'Select an observed model.',
  'model-unloaded':
    'The selected model is installed and unloaded. Load it in the Local app, refresh models, then select it again.',
  'model-incompatible':
    'The selected model does not meet this profile. Inspect its observed reasons.',
  'selection-stale':
    'The model observation changed. Refresh models and select from the current observation.',
  'generation-active':
    'A Local generation is active. Stop its task before changing this connection.',
  'generation-unknown': 'Local generation ownership is unknown. Connection changes remain blocked.',
  'capability-unavailable': 'The native Local connection input is unavailable.',
  'setup-unavailable': 'The Local setup is unavailable. Refresh saved status.',
  'qualification-pending': 'The selected Local writer is unqualified.',
};
export const localModelStates = {
  'installed-unloaded': 'Installed and unloaded',
  'loaded-eligible': 'Loaded and eligible',
  incompatible: 'Incompatible',
};
const modelReasons = {
  'unsupported-format': 'Unsupported model format',
  'remote-model': 'Remote model',
  'identity-ambiguous': 'Model identity is ambiguous',
  'multiple-resident-models': 'Multiple resident models',
  'resident-embedding': 'Embedding model is resident',
  busy: 'Model is busy',
  context: 'Loaded context length is not 8192 tokens',
  draft: 'Draft model is configured',
  'not-downloaded': 'Model is not downloaded',
};
const applied = (outcome: string) => outcome === 'applied' || outcome === 'already-applied';

export function LocalSetup({
  snapshot,
  workspace,
}: {
  snapshot: Pick<Snapshot, 'localSetup'>;
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
  async function action(name: string, command: DesktopCommand) {
    if (!connected || workspace.retryAvailable || requested) return;
    setRequested(name);
    setMessage(null);
    try {
      const result = await workspace.command(command);
      setMessage(
        applied(result.outcome)
          ? command.command === 'BeginLocalConnectionInput' ||
            command.command === 'RefreshLocalModels'
            ? `${name} requested. Watch the saved status.`
            : command.command === 'CancelLocalConnectionInput'
              ? 'Cancellation requested. Refresh saved status until ownership is settled.'
              : `${name} confirmed.`
          : (result.next ?? result.reason ?? `${name} was not confirmed.`),
      );
      if (applied(result.outcome) && command.command === 'ConfigureLocal') setEndpointEdited(false);
    } catch {
      setMessage(
        `${name} could not be confirmed. Refresh saved status and use exact retry if available.`,
      );
    } finally {
      setRequested(null);
    }
  }
  return (
    <section className="card view-stack" aria-labelledby={titleId}>
      <div className="section-heading">
        <h2 id={titleId}>Local setup</h2>
        <span>Writer only · Qualification pending</span>
      </div>
      <p className="muted small">
        Connect to an existing Local runtime using its saved authentication mode. Dedicated token
        opens a native input window. No authentication connects without a token to this device's
        loopback endpoint. CrewKite does not change the runtime's authentication setting. Refresh
        reads model metadata without loading a model or starting generation. Connecting or
        refreshing models clears the saved model choice. Select a model from the new observation.
      </p>
      <p className="notice" role="status">
        {setup?.reason
          ? setup.reason === 'connection-required' && authMode === 'none'
            ? 'Connect to the configured Local runtime.'
            : setupReasons[setup.reason]
          : setup
            ? 'Inspect the saved connection and model state.'
            : 'Local setup is unavailable. Refresh saved status.'}
      </p>
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
            setEndpoint(event.target.value);
            setEndpointEdited(true);
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
          className="button secondary"
          type="button"
          disabled={blocked || !parsedEndpoint.success}
          onClick={() => {
            if (setup && parsedEndpoint.success)
              void action('Endpoint configuration', {
                command: 'ConfigureLocal',
                expectedRevision: setup.revision,
                payload: { endpoint: parsedEndpoint.data, authMode },
              });
          }}
        >
          Configure endpoint
        </button>
        <button
          className="button primary"
          type="button"
          disabled={blocked || !setup?.endpoint}
          onClick={() => {
            if (setup?.endpoint)
              void action(authMode === 'none' ? 'Local connection' : 'Connection input', {
                command: 'BeginLocalConnectionInput',
                expectedRevision: setup.revision,
                payload: { consent: 'explicit' },
              });
          }}
        >
          Connect Local
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={blocked || !connectionReady}
          onClick={() => {
            if (setup)
              void action('Model refresh', {
                command: 'RefreshLocalModels',
                expectedRevision: setup.revision,
                payload: { consent: 'explicit' },
              });
          }}
        >
          Refresh models
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={blocked || !setup?.endpoint}
          onClick={() => {
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
          {models?.length ? (
            <>
              <label>
                Observed Local model
                <select
                  value={choiceId ?? ''}
                  disabled={blocked}
                  onChange={(event) => setChoiceId(event.target.value || null)}
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
              <button
                className="button primary"
                type="button"
                disabled={blocked || !selectedChoice || selectedChoice.state === 'incompatible'}
                onClick={() => {
                  if (setup.observation && selectedChoice)
                    void action('Model selection', {
                      command: 'SelectLocalModel',
                      expectedRevision: setup.revision,
                      payload: {
                        selectionId: selectedChoice.selectionId,
                        observationHash: setup.observation.observationHash,
                      },
                    });
                }}
              >
                Select observed model
              </button>
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
        disabled={!connected || busy}
        onClick={() => {
          void workspace
            .refresh()
            .then(() => setMessage('Saved Local status refreshed.'))
            .catch(() => setMessage('Saved Local status could not be refreshed.'));
        }}
      >
        Refresh saved status
      </button>
    </section>
  );
}
