import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { localProbeFailure, probeLocal } from './chat-connect.ts';

// Claim: a runtime that rejects the handshake with 401 or 403 is told apart from one that is down,
// slow or broken, because only the first one is asking for a token. The probe reads the status
// from a real loopback socket, so the claim covers the message the socket library produces.
test('the loopback probe tells a runtime that asks for a token from one that is unavailable', async () => {
  for (const [message, expected] of [
    ['Unexpected server response: 401', 'token-required'],
    ['Unexpected server response: 403', 'token-required'],
    ['Unexpected server response: 404', 'unavailable'],
    ['Unexpected server response: 4010', 'unavailable'],
    ['Unexpected server response: 500', 'unavailable'],
    ['connect ECONNREFUSED 127.0.0.1:1', 'unavailable'],
    ['', 'unavailable'],
  ] as const)
    assert.equal(localProbeFailure(new Error(message)), expected, message);
  assert.equal(localProbeFailure('Unexpected server response: 401'), 'unavailable');

  if (Object.hasOwn(process.env, 'LM_API_TOKEN')) return;
  for (const [status, expected] of [
    [401, 'token-required'],
    [403, 'token-required'],
    [500, 'unavailable'],
  ] as const) {
    const server = createServer();
    server.on('upgrade', (_request, socket) => {
      socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      assert.equal(await probeLocal(`ws://127.0.0.1:${port}`, 5000), expected, String(status));
    } finally {
      server.close();
    }
  }
});
