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

function readProxyEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
 * dispatcher. No-op when no proxy is set, preserving direct connections.
 */
export function applyProxyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  sink: ProxyDispatcherSink = defaultSink,
): ProxyConfig {
  const config = resolveProxyConfig(env);
  if (!config.enabled) return config;
  sink.setGlobalDispatcher(
    new EnvHttpProxyAgent({
      ...(config.httpProxy ? { httpProxy: config.httpProxy } : {}),
      ...(config.httpsProxy ? { httpsProxy: config.httpsProxy } : {}),
      ...(config.noProxy ? { noProxy: config.noProxy } : {}),
    }),
  );
  return config;
}
