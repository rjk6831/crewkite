#!/usr/bin/env node
// Writes a JSON manifest for a build: the commit it came from, the package versions and Node
// version it ran with, and checksums of the lockfile, the migrations and the artifacts. A release
// receipt cites this file. It records what was built and checked. It does not judge the build.
//
//   node scripts/release-evidence.mjs --out <file> [--test-output <file>] [--artifacts <dir>]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const listDirectories = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
const listFiles = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort()
    : [];

function packageVersions(root) {
  const manifests = ['package.json'];
  for (const dir of ['apps', 'packages'])
    for (const name of listDirectories(join(root, dir)))
      manifests.push(join(dir, name, 'package.json'));
  const versions = {};
  for (const path of manifests) {
    if (!existsSync(join(root, path))) continue;
    const { name, version } = JSON.parse(readFileSync(join(root, path), 'utf8'));
    versions[name] = version;
  }
  return versions;
}

function migrations(root) {
  // The same file pattern the controller applies at startup.
  const files = listFiles(join(root, 'apps/controller/migrations')).filter((file) =>
    /^\d{3}-[a-z0-9-]+\.sql$/.test(file),
  );
  return { count: files.length, latest: files.at(-1) ?? null };
}

// The spec reporter prints one line per test file and a summary block. Paths under the repository
// are kept relative so the manifest does not carry a home directory.
function testSummary(text, root) {
  const files = [...text.matchAll(/^\S+ (\S+\.test\.(?:ts|mjs)) \(/gmu)].map(([, file]) =>
    file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file,
  );
  const counts = {};
  for (const [, key, value] of text.matchAll(
    /^ℹ (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gmu,
  ))
    counts[key] = Number(value);
  return { files: [...new Set(files)], counts };
}

function artifactChecksums(dir) {
  return listFiles(dir).map((name) => {
    const bytes = readFileSync(join(dir, name));
    return { name, bytes: bytes.length, sha256: sha256(bytes) };
  });
}

export function buildManifest({ root, source, nodeVersion, testOutput, artifactsDir }) {
  return {
    format: 1,
    source,
    node: nodeVersion,
    packages: packageVersions(root),
    lockfile: {
      path: 'pnpm-lock.yaml',
      sha256: sha256(readFileSync(join(root, 'pnpm-lock.yaml'))),
    },
    migrations: migrations(root),
    tests: testOutput === undefined ? null : testSummary(testOutput, root),
    artifacts: artifactsDir === undefined ? [] : artifactChecksums(artifactsDir),
  };
}

function readSource(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  return { commit: git('rev-parse', 'HEAD'), clean: git('status', '--porcelain') === '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // resolve drops the trailing slash that the path to a directory URL carries.
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      'test-output': { type: 'string' },
      artifacts: { type: 'string' },
    },
  });
  const manifest = buildManifest({
    root,
    source: readSource(root),
    nodeVersion: process.version,
    testOutput:
      values['test-output'] === undefined
        ? undefined
        : readFileSync(resolve(values['test-output']), 'utf8'),
    artifactsDir: values.artifacts === undefined ? undefined : resolve(values.artifacts),
  });
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  if (values.out === undefined) process.stdout.write(json);
  else writeFileSync(resolve(values.out), json);
}
