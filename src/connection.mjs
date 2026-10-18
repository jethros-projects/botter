import { createGatewayClient } from './gateway.mjs';

/** Resolve the same live connection used by the desktop app.
 * The returned descriptor contains credentials. Keep it in memory or a private
 * credential file; do not log it or include it in artifact bundles.
 */
export async function resolveGatewayDescriptor(client, { wake = true, signal, timeoutMs = 120000 } = {}) {
  if (typeof wake !== 'boolean') throw new TypeError('wake must be a boolean.');
  // Match the desktop's connect() and describe() paths. supportsAsleepBox is
  // reserved for locate(), which may deliberately return a sleeping computer.
  const box = await client.rpc('EnsureSandBox', wake ? {} : { wake: false }, { signal, timeoutMs });
  if (typeof box.gatewayUrl !== 'string' || !box.gatewayUrl || typeof box.gatewayToken !== 'string' || !box.gatewayToken) {
    const error = new Error(wake ? 'The computer did not return a usable gateway connection.' : 'No active gateway connection. Connect with wake enabled.');
    error.code = 'gateway_unavailable'; throw error;
  }
  const descriptor = { baseUrl: box.gatewayUrl, token: box.gatewayToken,
    ...(box.networkToken ? { headers: { 'x-anyrun-network-token': box.networkToken } } : {}) };
  // Reuse the transport validation before exposing any credentials to a URL.
  createGatewayClient(descriptor);
  return descriptor;
}

export async function connectGateway(client, options = {}) {
  return createGatewayClient(await resolveGatewayDescriptor(client, options));
}

/** Inspect connectivity without exposing gateway or network tokens. */
export async function gatewayStatus(client, options = {}) {
  const descriptor = await resolveGatewayDescriptor(client, { ...options, wake: options.wake ?? false });
  const health = new URL('/health', descriptor.baseUrl);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
  const response = await (options.fetchImpl ?? globalThis.fetch)(health, {
    method: 'GET', redirect: 'error', signal,
    headers: { ...descriptor.headers, authorization: `Bearer ${descriptor.token}` },
  });
  await response.body?.cancel();
  return { connected: response.ok, status: response.status, host: health.hostname,
    networkRoutingHeader: !!descriptor.headers?.['x-anyrun-network-token'] };
}
