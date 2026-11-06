import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controllerPath } from './controller-path.ts';

// Claim: a Finder launch on macOS can still find node and npm for project checks, and a terminal
// PATH keeps its order with nothing added twice. Other platforms keep the PATH they were given.
test('the controller PATH adds the macOS install folders once', () => {
  assert.equal(
    controllerPath('/usr/bin:/bin:/usr/sbin:/sbin', 'darwin'),
    '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin',
  );
  assert.equal(
    controllerPath('/Users/me/.nvm/bin:/opt/homebrew/bin:/usr/bin', 'darwin'),
    '/Users/me/.nvm/bin:/opt/homebrew/bin:/usr/bin:/usr/local/bin',
  );
  assert.equal(controllerPath(undefined, 'darwin'), '/opt/homebrew/bin:/usr/local/bin');
  assert.equal(controllerPath('/usr/bin:/bin', 'linux'), '/usr/bin:/bin');
});
