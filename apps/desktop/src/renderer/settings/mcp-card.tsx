import type {
  ChatPermissionPolicy,
  McpBridge,
  McpServerInput,
  McpState,
} from '@crewkite/contracts';
import { useCallback, useEffect, useState } from 'react';

const lines = (text: string) => text.split('\n').filter((line) => line.length > 0);
const READ_TOOLS = /[\s,]+/;
const blank = { name: '', command: '', args: '', secretArgs: '', env: '', readTools: '' };
type Draft = typeof blank;

function toInput(draft: Draft): McpServerInput {
  const env: Record<string, string> = {};
  for (const line of lines(draft.env)) {
    const at = line.indexOf('=');
    if (at < 1) throw new Error('Write each variable as NAME=value.');
    env[line.slice(0, at)] = line.slice(at + 1);
  }
  return {
    name: draft.name.trim(),
    command: draft.command.trim(),
    args: lines(draft.args),
    secretArgs: lines(draft.secretArgs),
    env,
    readTools: draft.readTools.split(READ_TOOLS).filter(Boolean),
  };
}

function useMcp(): {
  bridge: McpBridge | undefined;
  state: McpState | null;
  set: (s: McpState) => void;
} {
  const bridge = window.crewkite?.mcp;
  const [state, set] = useState<McpState | null>(null);
  useEffect(() => {
    let live = true;
    void bridge?.state().then(
      (value) => live && set(value),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [bridge]);
  return { bridge, state, set };
}

const policyText: Record<string, string> = {
  ask: 'Ask each time',
  reads: 'Allow reads',
  all: 'Allow all',
};
const ceilingText: Record<ChatPermissionPolicy, string> = {
  ask: 'This thread asks for everything, so every call asks.',
  'allow-edits': 'This thread allows edits, so calls can run without asking only for listed reads.',
  'allow-all': 'This thread allows everything, so the policy you pick applies as chosen.',
};

/** Servers the person adds by command and arguments. Each is off until a thread turns it on. */
export function McpCard() {
  const { bridge, state, set } = useMcp();
  const [draft, setDraft] = useState<Draft>(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const run = useCallback(
    async (work: () => Promise<McpState>) => {
      setError('');
      try {
        set(await work());
        return true;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'The change did not save.');
        return false;
      }
    },
    [set],
  );
  const field = (key: keyof Draft, label: string, hint: string, area = false) => (
    <div className="st-field">
      <label className="st-name" htmlFor={`mcp-${key}`}>
        {label}
      </label>
      <small className="st-hint">{hint}</small>
      {area ? (
        <textarea
          id={`mcp-${key}`}
          rows={3}
          value={draft[key]}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
        />
      ) : (
        <input
          id={`mcp-${key}`}
          value={draft[key]}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
        />
      )}
    </div>
  );
  return (
    <section className="st-card" aria-labelledby="settings-mcp">
      <header className="st-card-head">
        <h2 id="settings-mcp">MCP servers</h2>
        <span className="st-detail">Your own tools, per thread</span>
      </header>
      <div className="st-body">
        <p className="st-note">
          Every server is off. Turn one on for a thread from that thread's panel and pick how its
          calls are handled. The policy follows the thread's permissions and never goes past them.
          Anthropic asks the controller about every call. Google takes the servers only while the
          thread asks for everything. OpenAI and Local do not run them yet. Secret arguments and
          variables are stored encrypted on this device and never shown again.
        </p>
        {!bridge && <p className="st-note">MCP servers need the desktop app.</p>}
        {state && !state.encrypted && <p className="st-note">{state.reason}</p>}
        <ul className="st-models">
          {state?.servers.map((server) => (
            <li key={server.name}>
              <span>
                <strong>{server.name}</strong> <code>{server.command}</code> · {server.args.length}{' '}
                arguments, {server.secretArgCount} secret, {server.envKeys.length} variables
                {server.envKeys.length ? ` (${server.envKeys.join(', ')})` : ''}
                {server.readTools.length ? ` · reads: ${server.readTools.join(', ')}` : ''}
              </span>
              <span className="st-actions">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(server.name);
                    setDraft({
                      ...blank,
                      name: server.name,
                      command: server.command,
                      args: server.args.join('\n'),
                      readTools: server.readTools.join(', '),
                    });
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => bridge && void run(() => bridge.remove(server.name))}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
        {editing && (
          <p className="st-note">
            Editing {editing}. Arguments are not shown back. Leave the secret fields empty to keep
            what is stored.
          </p>
        )}
        <div className="st-rows">
          <div className="st-row">
            {field('name', 'Name', 'Lower case letters, digits and hyphens.')}
            {field('command', 'Command', 'The program to start, for example npx.')}
          </div>
          <div className="st-row">
            {field('args', 'Arguments', 'One per line. Not secret.', true)}
            {field('secretArgs', 'Secret arguments', 'One per line. Stored encrypted.', true)}
          </div>
          <div className="st-row">
            {field(
              'env',
              'Variables',
              'NAME=value, one per line. Values are stored encrypted.',
              true,
            )}
            {field(
              'readTools',
              'Read tools',
              'Tool names that only read, separated by commas. End a prefix with a star. Under Allow reads only these run without asking.',
            )}
          </div>
        </div>
        {error && (
          <p className="st-error" role="status">
            {error}
          </p>
        )}
        <div className="st-actions">
          <button
            type="button"
            disabled={!bridge || !draft.name || !draft.command}
            onClick={() =>
              bridge &&
              void run(() => {
                const input = toInput(draft);
                const keep =
                  editing === input.name &&
                  !input.secretArgs.length &&
                  !Object.keys(input.env).length;
                return bridge.save({ ...input, ...(keep ? { keepSecrets: true } : {}) });
              }).then((saved) => {
                if (saved) {
                  setDraft(blank);
                  setEditing(null);
                }
              })
            }
          >
            {editing ? 'Save server' : 'Add server'}
          </button>
        </div>
      </div>
    </section>
  );
}

/** The thread panel's part: which servers this thread uses and how each call is handled. */
export function McpThreadMenu({
  taskId,
  permissionPolicy,
}: {
  taskId: string;
  permissionPolicy: ChatPermissionPolicy;
}) {
  const { bridge, state, set } = useMcp();
  const [error, setError] = useState('');
  if (!bridge || !state || state.servers.length === 0) return null;
  const chosen = state.threads[taskId] ?? {};
  return (
    <fieldset className="th-mcp">
      <legend>MCP servers</legend>
      <small>{ceilingText[permissionPolicy]}</small>
      {state.servers.map((server) => (
        <label key={server.name}>
          {server.name}
          <select
            value={chosen[server.name] ?? 'off'}
            onChange={(event) => {
              const value = event.target.value;
              setError('');
              bridge
                .setThread(taskId, server.name, value === 'off' ? null : (value as 'ask'))
                .then(set, (failure) =>
                  setError(failure instanceof Error ? failure.message : 'The change did not save.'),
                );
            }}
          >
            <option value="off">Off</option>
            {Object.entries(policyText).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      ))}
      {error && <small role="status">{error}</small>}
    </fieldset>
  );
}
