// Checks what CrewKite sends each provider client against a published build of that client:
//
//   node scripts/protocol-check.mjs [--section openai] [--version latest] [--binary <path>] [--keep]
//
// Each section installs its client into a temporary npm prefix, or takes --binary, and runs it
// with no account and no model call. A shape the build refuses, a confirmed setting that differs
// or a schema mismatch fails the run and names the request. Sections live beside their adapters
// and register here by family, so a family adds its own check without touching the others.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = new URL('../', import.meta.url);

/** Family to section module. A section exports name, npmPackage, executable(prefix) and check(). */
export const sections = {
  openai: () => import(new URL('apps/controller/src/providers/openai/protocol-check.ts', root)),
};

const kind = (value) =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : typeof value === 'number' && Number.isInteger(value)
        ? 'integer'
        : typeof value;

/**
 * The parts of JSON Schema the generated client schemas use: $ref into definitions, type, enum,
 * const, anyOf, oneOf, allOf, properties, required and items. Extra keys pass, since the client
 * ignores unknown fields; experimental fields are absent from the schema by design.
 */
export function validate(schema, value) {
  const definitions = schema.definitions ?? {};
  const problems = [];
  const walk = (node, data, path) => {
    if (!node || node === true) return;
    if (node.$ref) return walk(definitions[node.$ref.split('/').at(-1)], data, path);
    if (node.allOf) for (const part of node.allOf) walk(part, data, path);
    for (const key of ['anyOf', 'oneOf'])
      if (node[key]) {
        const passes = node[key].some((part) => {
          const before = problems.length;
          walk(part, data, path);
          const ok = problems.length === before;
          problems.length = before;
          return ok;
        });
        if (!passes) problems.push(`${path || 'params'} matches no allowed shape`);
      }
    if (node.const !== undefined && data !== node.const)
      problems.push(`${path} is not ${node.const}`);
    if (node.enum && !node.enum.includes(data))
      problems.push(`${path} is not one of ${node.enum.join(', ')}`);
    if (node.type) {
      const types = [node.type].flat();
      const actual = kind(data);
      if (!types.includes(actual) && !(actual === 'integer' && types.includes('number')))
        problems.push(`${path || 'params'} is ${actual}, expected ${types.join(' or ')}`);
    }
    if (kind(data) === 'object') {
      for (const key of node.required ?? [])
        if (!(key in data)) problems.push(`${path ? `${path}.` : ''}${key} is missing`);
      for (const [key, inner] of Object.entries(node.properties ?? {}))
        if (key in data) walk(inner, data[key], path ? `${path}.${key}` : key);
    }
    if (kind(data) === 'array' && node.items)
      for (const [index, item] of data.entries()) walk(node.items, item, `${path}[${index}]`);
  };
  walk(schema, value, '');
  return problems;
}

async function run(family, options) {
  const section = await sections[family]();
  const work = mkdtempSync(join(tmpdir(), `protocol-check-${family}-`));
  try {
    let binary = options.binary;
    if (!binary) {
      const prefix = join(work, 'client');
      const installed = spawnSync(
        'npm',
        [
          'install',
          '--prefix',
          prefix,
          '--no-audit',
          '--no-fund',
          `${section.npmPackage}@${options.version}`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      if (installed.status !== 0)
        throw Error(
          `npm could not install ${section.npmPackage}@${options.version}: ${installed.stderr.trim().split('\n').at(-1)}`,
        );
      binary = section.executable(prefix);
    }
    const { version, rows } = await section.check({ binary, work, validate });
    console.log(`\n${section.name} ${version}`);
    for (const row of rows)
      console.log(`  ${row.result.padEnd(8)} ${row.request} (${row.shape}): ${row.detail}`);
    return rows.filter((row) => row.result === 'refused').length;
  } finally {
    if (!options.keep) rmSync(work, { recursive: true, force: true });
    else console.log(`  kept ${work}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      section: { type: 'string', multiple: true },
      version: { type: 'string', default: 'latest' },
      binary: { type: 'string' },
      keep: { type: 'boolean', default: false },
    },
  });
  const families = values.section ?? Object.keys(sections);
  let refused = 0;
  for (const family of families) {
    if (!sections[family]) throw Error(`No protocol check for ${family}.`);
    refused += await run(family, values);
  }
  if (refused) {
    console.log(`\n${refused} ${refused === 1 ? 'check' : 'checks'} refused.`);
    process.exit(1);
  }
}
