# Controller client

The client shares one transport between the desktop main process and CLI. The renderer imports types and framing code only. Socket access lives in the Node entry point, following [ADR 0019](../../docs/adr/0019-transport-seam-for-team-and-remote.md).

## Entry points

`@crewkite/client` exports `FrameDecoder`, `encodeFrame`, `ProtocolError` and the `DesktopSource`, `DesktopCommand` and `ConnectionState` types. It imports no Node modules.

Frames have a four-byte big-endian byte length followed by UTF-8 JSON. The decoder rejects a zero length or more than 1 MiB before allocating a body. `push(bytes)` returns complete validated messages; `finish()` rejects partial input at EOF. A protocol mismatch has `ProtocolError.reason === 'protocol-mismatch'`. Other malformed input uses `invalid-frame`. Errors never quote authentication frames.

`@crewkite/client/node` exports `connectController`, `readControllerEndpoint`, `createCommandKey` and `ControllerClient`.

```ts
const client = await connectController({
  ...readControllerEndpoint(home),
  actor: { id: 'desktop', kind: 'desktop' },
});
const snapshot = await client.snapshot();
const unsubscribe = await client.subscribe(snapshot.cursor, applyEvent, replaceSnapshot);
```

The endpoint uses `control.sock` and `token` under the selected home. The directory must belong to the current user with mode 0700. The token must be an independent regular file with mode 0600. The client reads no provider account state.

## Commands and connection loss

`command(command)` sends a complete shared command envelope. It returns the result correlated with that command key. Keep the original envelope if a retry may be needed. The controller owns idempotency and authority; the actor field is correlation data.

A lost connection or response timeout returns `outcome-unknown` for an outstanding request. The client never replays that request. An explicit retry sends its original key, payload and revision unchanged. A caller must inspect fresh state before deciding to retry an uncertain effect.

The client makes eight consecutive reconnect attempts by default. Delays grow from 250 ms to a 30-second cap, allowing about one to two minutes for a controller restart. `onConnection(listener)` reports `connecting`, `connected` or `offline`. `onReconnectExhausted(listener)` reports when that recovery window ends. Call `connect()` explicitly to start a new window after exhaustion. `close()` cancels reconnect work and closes the socket.

## Event replay

One subscription can be active per client. Events advance its cursor after successful delivery, and duplicate cursors are ignored. Reconnection first subscribes after that retained cursor. If the controller reports a history gap, the client fetches a snapshot, calls the snapshot replacement callback and subscribes after its cursor. A failed callback does not advance the cursor.

Task state comes from `task.created` and `task.updated`. Attempt output and route events do not authorize a client to infer a task transition. Disposal stops local delivery; closing the connection ends its controller subscription.
