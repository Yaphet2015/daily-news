import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnvironmentFingerprint,
  shouldLogEnvironmentDiagnostics,
} from '../src/envDiagnostics.js';

test('buildEnvironmentFingerprint captures runtime, env, command paths, parent, and data files', async () => {
  const fingerprint = await buildEnvironmentFingerprint({
    argv: ['node', 'src/generate.ts', '--mode=review'],
    cwd: () => '/repo',
    env: {
      PATH: '/bin:/usr/bin',
      HTTP_PROXY: 'http://proxy.example:6152',
      HTTPS_PROXY: '',
      http_proxy: 'http://lower.example:6152',
      all_proxy: 'socks5://proxy.example:6153',
      ENABLED_SOURCES: 'twitter,substack',
      TERM_PROGRAM: 'Apple_Terminal',
    },
    execPath: '/usr/local/bin/node',
    fileExists: async (path) => path === '/repo/data/state.json',
    getParentCommand: async () => '/Applications/Codex.app/Contents/MacOS/Codex',
    ppid: 12345,
    resolveCommand: async (name) => `/resolved/${name}`,
  });

  assert.deepEqual(fingerprint, {
    cwd: '/repo',
    execPath: '/usr/local/bin/node',
    argv: ['node', 'src/generate.ts', '--mode=review'],
    ppid: 12345,
    parentCommand: '/Applications/Codex.app/Contents/MacOS/Codex',
    path: '/bin:/usr/bin',
    resolvedCommands: {
      node: '/resolved/node',
      npm: '/resolved/npm',
      twitter: '/resolved/twitter',
      curl: '/resolved/curl',
    },
    env: {
      HTTP_PROXY: 'http://proxy.example:6152',
      HTTPS_PROXY: '',
      http_proxy: 'http://lower.example:6152',
      https_proxy: undefined,
      ALL_PROXY: undefined,
      all_proxy: 'socks5://proxy.example:6153',
      TWITTER_PROXY: undefined,
      ENABLED_SOURCES: 'twitter,substack',
      TERM_PROGRAM: 'Apple_Terminal',
    },
    dataFiles: {
      stateJson: true,
      pendingDraftJson: false,
    },
  });
});

test('shouldLogEnvironmentDiagnostics only enables explicit diagnostics', () => {
  assert.equal(shouldLogEnvironmentDiagnostics({ DAILY_NEWS_ENV_DIAGNOSTICS: '1' }), true);
  assert.equal(shouldLogEnvironmentDiagnostics({ DAILY_NEWS_ENV_DIAGNOSTICS: 'true' }), true);
  assert.equal(shouldLogEnvironmentDiagnostics({ DAILY_NEWS_ENV_DIAGNOSTICS: '0' }), false);
  assert.equal(shouldLogEnvironmentDiagnostics({}), false);
});
