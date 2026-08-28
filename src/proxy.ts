import { EnvHttpProxyAgent, setGlobalDispatcher, type Dispatcher } from 'undici';

export interface ProxyConfig {
  enabled: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

export interface ProxyDispatcherSink {
  setGlobalDispatcher(dispatcher: Dispatcher): void;
}

const defaultSink: ProxyDispatcherSink = { setGlobalDispatcher };
const LOOPBACK_NO_PROXY_HOSTS = ['127.0.0.1', 'localhost', '::1'];

function readProxyEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function mergeLoopbackNoProxy(noProxy: string | undefined): string {
  const existing = (noProxy ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  return [...new Set([...existing, ...LOOPBACK_NO_PROXY_HOSTS])].join(',');
}

/**
 * Resolve proxy settings from the process environment.
 * Honors HTTP(S)_PROXY / NO_PROXY in both upper- and lowercase.
 */
export function resolveProxyConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const httpProxy = readProxyEnvValue(env.HTTP_PROXY) ?? readProxyEnvValue(env.http_proxy);
  const httpsProxy = readProxyEnvValue(env.HTTPS_PROXY) ?? readProxyEnvValue(env.https_proxy);
  const noProxy = readProxyEnvValue(env.NO_PROXY) ?? readProxyEnvValue(env.no_proxy);
  return {
    enabled: Boolean(httpProxy || httpsProxy),
    httpProxy,
    httpsProxy,
    noProxy,
  };
}

/**
 * Route in-process `fetch` (AI SDK / OpenAI SDK calls, RSS fetches, …) through the
 * proxy declared in HTTP_PROXY / HTTPS_PROXY / NO_PROXY. Node 20's built-in fetch
 * ignores these by default, so we install an undici EnvHttpProxyAgent as the global
 * dispatcher. Loopback always stays in noProxy so local health checks cannot be
 * intercepted when NO_PROXY is empty. No-op when no proxy is set.
 */
export function applyProxyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  sink: ProxyDispatcherSink = defaultSink,
): ProxyConfig {
  const config = resolveProxyConfig(env);
  if (!config.enabled) return config;
  const noProxy = mergeLoopbackNoProxy(config.noProxy);
  sink.setGlobalDispatcher(
    new EnvHttpProxyAgent({
      ...(config.httpProxy ? { httpProxy: config.httpProxy } : {}),
      ...(config.httpsProxy ? { httpsProxy: config.httpsProxy } : {}),
      noProxy,
    }),
  );
  return { ...config, noProxy };
}
