import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNewer, launchCheckDue, offerOnLaunch, parseRelease } from './update-check.ts';

// Claim: only a published release on the CrewKite releases page counts, and only a higher
// version is offered.
test('a newer published release is offered, and nothing else is', () => {
  const release = (change: Record<string, unknown> = {}) => ({
    tag_name: 'v0.1.1',
    html_url: 'https://github.com/rjk6831/crewkite/releases/tag/v0.1.1',
    draft: false,
    prerelease: false,
    ...change,
  });
  assert.deepEqual(parseRelease(release()), {
    version: '0.1.1',
    url: 'https://github.com/rjk6831/crewkite/releases/tag/v0.1.1',
  });
  assert.equal(parseRelease(release({ prerelease: true })), null);
  assert.equal(parseRelease(release({ draft: true })), null);
  assert.equal(parseRelease(release({ tag_name: 'nightly' })), null);
  assert.equal(parseRelease(release({ html_url: 'https://example.com/releases/v0.1.1' })), null);
  assert.equal(parseRelease(null), null);
  for (const [latest, current, want] of [
    ['0.1.1', '0.1.0', true],
    ['0.2.0', '0.1.9', true],
    ['1.0.0', '0.9.9', true],
    ['0.1.0', '0.1.0', false],
    ['0.1.0', '0.1.1', false],
    ['0.10.0', '0.9.0', true],
  ] as const)
    assert.equal(isNewer(latest, current), want, `${latest} vs ${current}`);
});

// Claim: the launch check runs at most once a day and does not offer a version put off with Later.
test('the launch check waits a day and skips a version put off', () => {
  const day = 86_400_000;
  assert.equal(launchCheckDue({ checkedAt: 0, skipped: null }, day), true);
  assert.equal(launchCheckDue({ checkedAt: day, skipped: null }, day + day - 1), false);
  const release = {
    version: '0.1.1',
    url: 'https://github.com/rjk6831/crewkite/releases/tag/v0.1.1',
  };
  assert.equal(offerOnLaunch({ checkedAt: 0, skipped: null }, release, '0.1.0'), true);
  assert.equal(offerOnLaunch({ checkedAt: 0, skipped: '0.1.1' }, release, '0.1.0'), false);
  assert.equal(offerOnLaunch({ checkedAt: 0, skipped: null }, release, '0.1.1'), false);
});
