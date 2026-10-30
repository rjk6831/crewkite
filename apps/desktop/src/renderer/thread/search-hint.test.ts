import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchHint } from './composer-rules.ts';

test('the search hint names Command on a Mac and Control everywhere else', () => {
  const cases = [
    { mac: true, want: '⌘ K' },
    { mac: false, want: 'Ctrl K' },
  ];
  for (const { mac, want } of cases) assert.equal(searchHint(mac), want, `mac ${mac}`);
});
