import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  chatScratchDirectory,
  claimScratchDirectory,
  scratchFolderName,
} from './scratch-folder.ts';

// Claim: a new thread's copy is named after its project, and a thread made before the name was
// recorded keeps `scratch`, whatever the project is called now.

test('the copy folder is a short slug of the project name, or scratch when none fits', () => {
  const rows: [string, string][] = [
    ['demo-shop', 'demo-shop'],
    ['Demo Shop', 'demo-shop'],
    ['  Café API v2!  ', 'cafe-api-v2'],
    ['ร้านค้า', 'scratch'],
    ['', 'scratch'],
    ['Files', 'scratch'],
    ['slices', 'scratch'],
    ['turns', 'scratch'],
    ['sessions', 'scratch'],
    ['scratch-name', 'scratch'],
    ['accept-x', 'scratch'],
    ['a'.repeat(80), 'a'.repeat(60)],
  ];
  for (const [name, want] of rows) assert.equal(scratchFolderName(name), want, name);
});

test('a new thread records its folder, and an older thread resolves to scratch', () => {
  const home = mkdtempSync(join(tmpdir(), 'scratch-folder-'));
  const task = 'tsk_01M51M322B2AEBXD9MA74CBCFM';
  const folder = join(home, 'chat', task);
  // Before the first turn there is no record, so readers see scratch.
  assert.equal(chatScratchDirectory(home, task), join(folder, 'scratch'));
  assert.equal(claimScratchDirectory(home, task, 'Demo Shop'), join(folder, 'demo-shop'));
  assert.equal(readFileSync(join(folder, 'scratch-name'), 'utf8'), 'demo-shop');
  assert.equal(chatScratchDirectory(home, task), join(folder, 'demo-shop'));
  // A renamed project keeps the folder the first turn chose.
  assert.equal(claimScratchDirectory(home, task, 'Renamed'), join(folder, 'demo-shop'));

  // A thread whose copy already sits in scratch keeps it and gets no record.
  const older = 'tsk_01M51M322B2AEBXD9MA74CBCFN';
  mkdirSync(join(home, 'chat', older, 'scratch'), { recursive: true });
  assert.equal(
    claimScratchDirectory(home, older, 'Demo Shop'),
    join(home, 'chat', older, 'scratch'),
  );
  assert.equal(existsSync(join(home, 'chat', older, 'scratch-name')), false);
  assert.equal(chatScratchDirectory(home, older), join(home, 'chat', older, 'scratch'));

  // A record that does not hold a usable name reads as scratch.
  const odd = 'tsk_01M51M322B2AEBXD9MA74CBCFP';
  mkdirSync(join(home, 'chat', odd), { recursive: true });
  writeFileSync(join(home, 'chat', odd, 'scratch-name'), '../elsewhere');
  assert.equal(chatScratchDirectory(home, odd), join(home, 'chat', odd, 'scratch'));
});
