import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeAvailableMemory, probeGpu, readGpuReport, readVmStat } from './hardware.ts';

// Shape assumed from `system_profiler SPDisplaysDataType -json` on Apple Silicon under macOS 15:
// { "SPDisplaysDataType": [{ "sppci_model": "<chip name>", "sppci_cores": "<count as text>",
// "spdisplays_ndrvs": [...], ... }] }. The chip name in the fixture is a placeholder.
const report = (entry: Record<string, unknown>) =>
  JSON.stringify({ SPDisplaysDataType: [{ spdisplays_ndrvs: [], ...entry }, { sppci_cores: 8 }] });

test('the hardware probes read GPU cores and available memory and give nulls for anything else', async () => {
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

  // Shape from `vm_stat` on macOS 15. Available is free plus inactive plus purgeable pages.
  const vmStat = (pageSize: number, free: string, inactive: string, purgeable: string) =>
    [
      `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)`,
      `Pages free:                               ${free}.`,
      'Pages active:                           901234.',
      `Pages inactive:                          ${inactive}.`,
      'Pages speculative:                        12345.',
      'Pages wired down:                        234567.',
      `Pages purgeable:                          ${purgeable}.`,
      '"Translation faults":                 123456789.',
    ].join('\n');
  const memoryCases: [label: string, text: string, expected: number | null][] = [
    ['busy Mac', vmStat(16384, '6400', '70000', '2000'), (6400 + 70000 + 2000) * 16384],
    ['other page size', vmStat(4096, '10', '20', '0'), 30 * 4096],
    ['no purgeable line', vmStat(16384, '1', '2', '3').replace(/^Pages purgeable.*$/m, ''), null],
    ['no page size', vmStat(16384, '1', '2', '3').replace(/\(page size.*\)/, ''), null],
    ['not vm_stat', 'vm_stat: error', null],
  ];
  for (const [label, text, expected] of memoryCases)
    assert.equal(readVmStat(text), expected, label);
  const memoryCalls: unknown[] = [];
  const vm = async (command: string, args: readonly string[], limits: object) => {
    memoryCalls.push([command, args, limits]);
    return vmStat(16384, '1', '2', '3');
  };
  assert.equal(await probeAvailableMemory(vm, { platform: 'darwin' }), 6 * 16384);
  assert.deepEqual(memoryCalls, [['/usr/bin/vm_stat', [], { timeoutMs: 2000, maxBytes: 16384 }]]);
  // Elsewhere freemem answers and vm_stat never runs. A failed run gives null.
  assert.equal(await probeAvailableMemory(vm, { platform: 'linux' }, () => 1234), 1234);
  assert.equal(memoryCalls.length, 1);
  assert.equal(await probeAvailableMemory(failing, { platform: 'darwin' }), null);
});
