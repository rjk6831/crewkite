import assert from 'node:assert/strict';
import test from 'node:test';
import { formatLocalTime } from './format-time.ts';

test('a controller time reads as local date and minutes, never raw ISO text', () => {
  const utc = { locale: 'en-US', timeZone: 'UTC' };
  assert.match(formatLocalTime('2026-10-31T16:06:28.290Z', utc) ?? '', /^Oct 31, 2026, 4:06\sPM$/);
  // The same instant in Bangkok, seven hours ahead.
  assert.match(
    formatLocalTime('2026-10-31T12:33:58.591Z', { locale: 'en-US', timeZone: 'Asia/Bangkok' }) ??
      '',
    /^Oct 31, 2026, 7:33\sPM$/,
  );
  const local = formatLocalTime('2026-10-31T16:06:28.290Z') ?? '';
  assert.doesNotMatch(local, /T\d\d:|Z$|\.\d{3}|:28/);
  assert.equal(formatLocalTime(null), null);
  assert.equal(formatLocalTime(''), null);
  assert.equal(formatLocalTime('not a time'), null);
});
