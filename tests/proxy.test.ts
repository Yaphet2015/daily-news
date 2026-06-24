import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvHttpProxyAgent, type Dispatcher } from 'undici';
import {
  resolveProxyConfig,
  applyProxyFromEnv,
  type ProxyDispatcherSink,
} from '../src/proxy.js';

function fakeSink(): ProxyDispatcherSink & { calls: Dispatcher[] } {
  const calls: Dispatcher[] = [];
  return {
    calls,
    setGlobalDispatcher: (dispatcher: Dispatcher) => {
      calls.push(dispatcher);
    },
  };
}

test('resolveProxyConfig reads HTTPS_PROXY / HTTP_PROXY / NO_PROXY', () => {
  const config = resolveProxyConfig({
    HTTP_PROXY: 'http://h.example:8080',
    HTTPS_PROXY: 'http://s.example:8080',
    NO_PROXY: 'localhost,127.0.0.1',
  });
  assert.equal(config.enabled, true);
  assert.equal(config.httpProxy, 'http://h.example:8080');
  assert.equal(config.httpsProxy, 'http://s.example:8080');
  assert.equal(config.noProxy, 'localhost,127.0.0.1');
});

test('resolveProxyConfig falls back to lowercase *_proxy variants', () => {
  const config = resolveProxyConfig({
    http_proxy: 'http://lh.example:8080',
    https_proxy: 'http://ls.example:8080',
    no_proxy: '.internal',
  });
  assert.equal(config.enabled, true);
  assert.equal(config.httpProxy, 'http://lh.example:8080');
  assert.equal(config.httpsProxy, 'http://ls.example:8080');
  assert.equal(config.noProxy, '.internal');
});

test('resolveProxyConfig prefers uppercase over lowercase', () => {
  const config = resolveProxyConfig({
    HTTPS_PROXY: 'http://upper.example:8080',
    https_proxy: 'http://lower.example:8080',
  });
  assert.equal(config.httpsProxy, 'http://upper.example:8080');
});

test('resolveProxyConfig is disabled and omits proxies when nothing is set', () => {
  const config = resolveProxyConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.httpProxy, undefined);
  assert.equal(config.httpsProxy, undefined);
  assert.equal(config.noProxy, undefined);
});

test('resolveProxyConfig treats blank/whitespace values as unset (still enabled if another is set)', () => {
  const config = resolveProxyConfig({ HTTPS_PROXY: '   ', HTTP_PROXY: 'http://h.example:8080' });
  assert.equal(config.httpsProxy, undefined);
  assert.equal(config.httpProxy, 'http://h.example:8080');
  assert.equal(config.enabled, true);
});

test('applyProxyFromEnv installs an EnvHttpProxyAgent dispatcher when a proxy is set', () => {
  const sink = fakeSink();
  const config = applyProxyFromEnv(
    { HTTPS_PROXY: 'http://s.example:8080', HTTP_PROXY: 'http://h.example:8080', NO_PROXY: 'localhost' },
    sink,
  );
  assert.equal(config.enabled, true);
  assert.equal(sink.calls.length, 1);
  assert.ok(sink.calls[0] instanceof EnvHttpProxyAgent, 'expected an EnvHttpProxyAgent to be installed');
});

test('applyProxyFromEnv is a no-op (no dispatcher installed) when no proxy is set', () => {
  const sink = fakeSink();
  const config = applyProxyFromEnv({}, sink);
  assert.equal(config.enabled, false);
  assert.equal(sink.calls.length, 0);
});
