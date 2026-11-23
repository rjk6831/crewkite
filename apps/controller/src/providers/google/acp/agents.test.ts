import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { hashCanonical } from '@crewkite/contracts/hash';
import { scanGoogleAgents } from './agents.ts';
import { importGoogleAcp } from './import.ts';
import {
  type AcpReviewMapping,
  type AcpSetupProof,
  googleAcpDeveloperIdRequirement,
  resolveGoogleAcpProfile,
  validateAcpClientIdentity,
} from './profile.ts';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const team = 'EQHXZ8M8AV';
const environment = { HOME: userInfo().homedir, PATH: '/usr/bin:/bin' };
const host = { platform: 'darwin', arch: 'arm64' } as const;

/** A home with the 1.4.0 bundle imported as Connect leaves it, from fixture bytes. */
async function bundleHome(root: string) {
  const home = join(root, 'home');
  const staged = join(home, 'imports/google-acp-v1');
  mkdirSync(staged, { recursive: true, mode: 0o700 });
  const server = '#!/bin/sh\nexit 0\n';
  const harness = '#!/bin/sh\nexit 99\n';
  writeFileSync(join(staged, 'agy_acp_server.par'), server, { mode: 0o600 });
  writeFileSync(join(staged, 'localharness_external'), harness, { mode: 0o600 });
  const pin = { version: '1.4.0', sha256: sha(server), signerTeamId: team };
  writeFileSync(
    join(staged, 'identity.json'),
    JSON.stringify({ ...pin, harnessSha256: sha(harness) }),
    { mode: 0o600 },
  );
  const imported = await importGoogleAcp(
    { home, consent: 'explicit' },
    {
      verifySignature: async ({ client }) => ({
        verified: true,
        quiescent: true,
        signerTeamId: client.signerTeamId,
        requirement: googleAcpDeveloperIdRequirement(client.signerTeamId),
      }),
    },
  );
  assert.equal(imported.reason, 'imported');
  return { home, pin };
}

test('the newest signed agent with the acp subcommand is chosen over the 1.4.0 bundle, and an unsigned, wrongly signed, group-writable or acp-less copy never is', async () => {
  mkdirSync(resolve('internal'), { recursive: true });
  const root = realpathSync(mkdtempSync(resolve('internal/google-agents-')));
  try {
    const { home, pin } = await bundleHome(root);
    const mapping: AcpReviewMapping = {
      client: pin,
      surface: 'config',
      configId: 'mode-slot',
      valueId: 'fixture-review',
      semantics: 'request-review',
      evidenceHash: 'e'.repeat(64),
    };
    const configOptions = {
      model: {
        optionId: 'model-slot',
        currentValue: 'fixture-model',
        supported: ['fixture-model'],
      },
      thoughtLevel: null,
    };
    const modeValues = [{ optionId: 'mode-slot', valueId: 'fixture-review' }];
    // A proof as 0.2.0 stores it for the bundle.
    const stored: AcpSetupProof = {
      version: 1,
      profileId: 'google-acp-v1',
      client: pin,
      capabilities: {
        protocolVersion: 1,
        authMethods: ['oauth-personal'],
        sessionClose: true,
        fs: false,
        terminal: false,
      },
      configOptions,
      auth: { method: 'oauth-personal', status: 'authenticated' },
      reviewMode: {
        surface: 'config',
        configId: 'mode-slot',
        valueId: 'fixture-review',
        semantics: 'request-review',
        mappingEvidenceHash: 'e'.repeat(64),
        discoveryStateHash: hashCanonical({ configOptions, modeValues }),
      },
      modeValues,
    };
    const today = (proof: AcpSetupProof | null) =>
      resolveGoogleAcpProfile({ home, proof, environment }, { reviewMappings: [mapping], ...host });
    // The proof is valid for the bundle, so the bundle-only resolution is ready.
    assert.equal(today(stored).facts.available, true);

    const agent = (name: string, version: string, mode = 0o700) => {
      const folder = join(root, name);
      mkdirSync(folder, { mode: 0o700 });
      const path = join(folder, 'agy');
      writeFileSync(path, `#!/bin/sh\necho 'agy ${version}'\n`);
      chmodSync(path, mode);
      return path;
    };
    const older = agent('older', '1.5.5');
    const newest = agent('newest', '1.6.0');
    const shared = agent('shared', '1.7.0', 0o770);
    // CrewKite's own folder with four fetched copies. 1.7.0 holds a server larger than the quota
    // client's bound and smaller than the bundle server's, as a fetched server is. The others
    // carry an unsigned helper, a launch line outside the list, and a file over every bound.
    const managed = join(root, 'state/clients');
    const fetched = (version: string, args: string[], size: number, helper = false) => {
      const folder = join(managed, 'google', version);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      writeFileSync(join(folder, 'agent.json'), JSON.stringify({ cmd: 'agy', args }), {
        mode: 0o600,
      });
      const path = join(folder, 'agy');
      writeFileSync(path, '#!/bin/sh\n', { mode: 0o700 });
      truncateSync(path, size);
      if (helper)
        writeFileSync(
          join(folder, 'helper'),
          Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.alloc(60)]),
          {
            mode: 0o700,
          },
        );
      return path;
    };
    const large = fetched('1.7.0', ['acp'], 300 * 1024 * 1024);
    fetched('1.8.0', ['acp'], 1024, true);
    fetched('1.9.0', ['--sandbox'], 1024);
    fetched('2.0.0', ['acp'], 400 * 1024 * 1024);
    const unsignedHelper = join(managed, 'google/1.8.0/helper');
    const rows: {
      name: string;
      copies: string[];
      managed?: string;
      unsigned?: string[];
      otherTeam?: string[];
      timedOut?: string[];
      noAcp?: string[];
      proof?: AcpSetupProof;
      chosen: string | 'bundle';
      version?: string;
      unverified?: string[];
    }[] = [
      { name: 'signed with acp', copies: [older, newest], chosen: newest, version: '1.6.0' },
      {
        name: 'signature refused',
        copies: [older, newest],
        unsigned: [newest],
        chosen: older,
        version: '1.5.5',
      },
      {
        name: 'signed by another team',
        copies: [older, newest],
        otherTeam: [newest],
        chosen: older,
        version: '1.5.5',
      },
      // A check that ran out of time leaves the copy out and on the device.
      {
        name: 'signature check timed out',
        copies: [older, newest],
        timedOut: [newest],
        chosen: older,
        version: '1.5.5',
        unverified: [newest],
      },
      { name: 'group-writable', copies: [older, shared], chosen: older, version: '1.5.5' },
      {
        name: 'no acp subcommand',
        copies: [older, newest],
        noAcp: [newest],
        chosen: older,
        version: '1.5.5',
      },
      {
        name: 'fetched copies',
        copies: [older],
        managed,
        unsigned: [unsignedHelper],
        chosen: large,
        version: '1.7.0',
      },
      { name: 'only the bundle', copies: [], chosen: 'bundle' },
      { name: 'none trusted', copies: [newest], unsigned: [newest], chosen: 'bundle' },
      { name: 'a proof stored by 0.2.0', copies: [older, newest], proof: stored, chosen: 'bundle' },
    ];
    // A home without the bundle sets up on the newest copy. A home with it sets up the bundle.
    const bare = join(root, 'bare');
    mkdirSync(bare, { mode: 0o700 });
    const digests = new Map<string, string>();
    for (const row of rows) {
      const verified: string[] = [];
      const scan = await scanGoogleAgents({
        environment,
        managed: row.managed ?? null,
        directories: [],
        copies: row.copies,
        cache: new Map(),
        host,
        verify: async (executable, wanted) => {
          verified.push(executable);
          if (row.timedOut?.includes(executable)) throw new Error('timeout');
          if (row.unsigned?.includes(executable)) throw new Error('signature-refused');
          if (wanted !== (row.otherTeam?.includes(executable) ? 'ABCDE12345' : team))
            throw new Error('signature-refused');
        },
        help: async (executable) =>
          row.noAcp?.includes(executable)
            ? 'exit 1\nError: unknown subcommand: acp\n'
            : '\nUsage: agy acp [flags]\n\nFlags:\n',
      });
      for (const agent of scan.agents) digests.set(agent.executable, agent.sha256);
      assert(!verified.includes(shared), `${row.name}: a group-writable copy is never checked`);
      assert.deepEqual(
        scan.unverified,
        (row.unverified ?? []).map((path) => sha(readFileSync(path))),
        row.name,
      );
      const resolve = (from: string, proof: AcpSetupProof | null) =>
        resolveGoogleAcpProfile(
          { home: from, proof, environment, agents: scan.agents },
          { reviewMappings: [mapping], ...host },
        );
      // With the bundle in the home and no other proof, the route resolves exactly as 0.2.0 did.
      assert.deepEqual(resolve(home, row.proof ?? null), today(row.proof ?? null), row.name);
      if (row.chosen === 'bundle') continue;
      const resolved = resolve(bare, null);
      assert.equal(scan.agents[0]?.executable, row.chosen, row.name);
      assert.equal(resolved.client?.executable, row.chosen, row.name);
      assert.deepEqual(
        resolved.client && 'args' in resolved.client ? resolved.client.args : null,
        ['acp'],
        row.name,
      );
      assert.equal(resolved.facts.clientVersion, row.version, row.name);
      assert.equal(resolved.client?.sha256, scan.agents[0]?.sha256, row.name);
    }

    // The launch checks a copy again: the same file passes, and one that became group-writable
    // or changed its bytes since the scan is refused with the error a changed bundle gets.
    const identity = {
      version: '1.5.5',
      sha256: digests.get(older) ?? '',
      signerTeamId: team,
      executable: older,
      args: ['acp'],
      helpers: [],
    };
    assert.equal(validateAcpClientIdentity(identity, true).executable, older);
    // A fetched server above the quota client's bound starts too.
    const server = {
      ...identity,
      version: '1.7.0',
      sha256: digests.get(large) ?? '',
      executable: large,
    };
    assert.equal(validateAcpClientIdentity(server, true).executable, large);
    chmodSync(older, 0o720);
    assert.throws(() => validateAcpClientIdentity(identity, true), /Managed executable changed/);
    chmodSync(older, 0o700);
    writeFileSync(older, "#!/bin/sh\necho 'agy 1.5.6'\n");
    assert.throws(() => validateAcpClientIdentity(identity, true), /Managed executable changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
