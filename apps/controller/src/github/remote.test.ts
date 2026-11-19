import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gitAndGhEnvironment, githubHosts, readRemote, type SshHost } from './remote.ts';

// Claim: one parser gives one answer for every remote form, and gh is only ever pointed at a host
// the ssh configuration or the URL itself names. A name ssh cannot resolve is never guessed.
test('a remote reads as a GitHub repository only on its real host, and every other remote as plain git', () => {
  // The ssh configuration this test stands in for: one alias for github.com, GitHub's port 443
  // name, and one alias nothing maps.
  const ssh: SshHost = (alias, port) =>
    alias === 'gh-work'
      ? 'github.com'
      : alias === 'ssh.github.com' && port === '443'
        ? 'ssh.github.com'
        : alias === 'lost'
          ? null
          : alias;
  const enterprise = githubHosts({ GH_HOST: 'GHE.example.com' });
  const github = (host: string) => ({
    kind: 'github',
    repo: { host, owner: 'rjk6831', name: 'demo-shop' },
  });
  const git = { kind: 'git' };
  for (const [url, expected, hosts] of [
    ['https://github.com/rjk6831/demo-shop.git', github('github.com')],
    ['https://token@github.com/rjk6831/demo-shop', github('github.com')],
    ['git@github.com:rjk6831/demo-shop.git', github('github.com')],
    ['github.com:rjk6831/demo-shop.git', github('github.com')],
    ['ssh://git@github.com/rjk6831/demo-shop.git', github('github.com')],
    ['git@gh-work:rjk6831/demo-shop.git', github('github.com')],
    ['ssh://git@ssh.github.com:443/rjk6831/demo-shop.git', github('github.com')],
    ['git@lost:rjk6831/demo-shop.git', { kind: 'unresolved', alias: 'lost' }],
    ['https://ghe.example.com/rjk6831/demo-shop.git', github('ghe.example.com'), enterprise],
    ['https://ghe.example.com/rjk6831/demo-shop.git', git],
    ['https://gitlab.com/group/subgroup/demo-shop.git', git],
    ['git@gitlab.com:group/subgroup/demo-shop.git', git],
    ['https://gitlab.com/rjk6831/demo-shop.git', git],
    ['https://github.com/rjk6831/demo-shop/extra', git],
    ['/srv/git/demo-shop.git', git],
    ['../demo-shop.git', git],
    ['file:///srv/git/demo-shop.git', git],
    ['http://git.example.com/rjk6831/demo-shop.git', git],
    ['git://git.example.com/rjk6831/demo-shop.git', git],
  ] as const)
    assert.deepEqual(
      readRemote(url, ssh, hosts ?? githubHosts({})),
      expected,
      `${url}${hosts ? ' with GH_HOST' : ''}`,
    );
});

// Claim: a token sign-in, an enterprise host and a proxy reach git and gh, and nothing else the
// controller holds does.
test('git and gh get the sign-in, host and proxy variables and no other', () => {
  const passed = {
    GH_TOKEN: 'gho_token',
    GITHUB_TOKEN: 'ghp_token',
    GH_HOST: 'ghe.example.com',
    GH_ENTERPRISE_TOKEN: 'ghe_token',
    HTTPS_PROXY: 'http://proxy.example:3128',
    https_proxy: 'http://proxy.example:3128',
    NO_PROXY: 'localhost',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
  };
  const environment = gitAndGhEnvironment({
    ...passed,
    OPENAI_API_KEY: 'sk-kept-out',
    ANTHROPIC_API_KEY: 'sk-ant-kept-out',
    CREWKITE_TOKEN: 'kept-out',
    EMPTY_PROXY: '',
  });
  assert.deepEqual(environment, passed);
});
