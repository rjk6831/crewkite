import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeGpu, readGpuReport } from './hardware.ts';

// Shape assumed from `system_profiler SPDisplaysDataType -json` on Apple Silicon under macOS 15:
// { "SPDisplaysDataType": [{ "sppci_model": "<chip name>", "sppci_cores": "<count as text>",
// "spdisplays_ndrvs": [...], ... }] }. The chip name in the fixture is a placeholder.
const report = (entry: Record<string, unknown>) =>
  JSON.stringify({ SPDisplaysDataType: [{ spdisplays_ndrvs: [], ...entry }, { sppci_cores: 8 }] });

test('the GPU probe reads cores and chip from the report and gives nulls for anything else', async () => {
  const unknown = { gpuCores: null, gpuModel: null };
  const cases: [label: string, text: string, expected: unknown][] = [
    [
      'cores as text',
      report({ sppci_model: 'Fixture Chip Pro', sppci_cores: '20' }),
      { gpuCores: 20, gpuModel: 'Fixture Chip Pro' },
    ],
    [
      'cores as a number',
      report({ sppci_model: 'Chip', sppci_cores: 10 }),
      { gpuCores: 10, gpuModel: 'Chip' },
    ],
    ['no cores', report({ sppci_model: 'Chip' }), { gpuCores: null, gpuModel: 'Chip' }],
    [
      'cores out of range',
      report({ sppci_model: 'Chip', sppci_cores: '0' }),
      { gpuCores: null, gpuModel: 'Chip' },
    ],
    [
      'control characters in the name',
      report({ sppci_model: 'Chip\u0007', sppci_cores: 'many' }),
      unknown,
    ],
    ['empty list', JSON.stringify({ SPDisplaysDataType: [] }), unknown],
    ['other report', JSON.stringify({ SPHardwareDataType: [{}] }), unknown],
    ['not JSON', 'system_profiler: error', unknown],
  ];
  for (const [label, text, expected] of cases)
    assert.deepEqual(readGpuReport(text), expected, label);

  const calls: unknown[] = [];
  const run = async (command: string, args: readonly string[], limits: object) => {
    calls.push([command, args, limits]);
    return report({ sppci_model: 'Chip', sppci_cores: '16' });
  };
  assert.deepEqual(await probeGpu(run, { platform: 'darwin', arch: 'arm64' }), {
    gpuCores: 16,
    gpuModel: 'Chip',
  });
  assert.deepEqual(calls, [
    [
      '/usr/sbin/system_profiler',
      ['SPDisplaysDataType', '-json'],
      { timeoutMs: 5000, maxBytes: 256 * 1024 },
    ],
  ]);
  // Other platforms never run the report, and a failed run gives nulls.
  assert.equal(await probeGpu(run, { platform: 'darwin', arch: 'x64' }), null);
  assert.equal(await probeGpu(run, { platform: 'linux', arch: 'arm64' }), null);
  assert.equal(calls.length, 1);
  const failing = async () => {
    throw new Error('timed out');
  };
  assert.deepEqual(await probeGpu(failing, { platform: 'darwin', arch: 'arm64' }), unknown);
});
