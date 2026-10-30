import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowsFrameNavigation } from './frame-navigation.ts';

test('only a subframe loading its own srcdoc may navigate', () => {
  const rows: [string, boolean, boolean][] = [
    ['about:srcdoc', false, true],
    ['about:srcdoc', true, false],
    ['about:blank', false, false],
    ['https://example.invalid/', false, false],
    ['data:text/html,<p>x</p>', false, false],
    ['javascript:alert(1)', false, false],
    ['app://crewkite/index.html', false, false],
    ['about:srcdoc#x', false, false],
  ];
  for (const [url, isMainFrame, allowed] of rows)
    assert.equal(allowsFrameNavigation({ url, isMainFrame }), allowed, `${url} ${isMainFrame}`);
});
