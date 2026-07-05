export function normalizeAddress(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (raw.startsWith('::ffff:')) return raw.slice('::ffff:'.length);
  return raw;
}

export function hostnameFromHeader(value = '') {
  let host = String(value || '').trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end >= 0 ? host.slice(1, end) : host;
  }
  const colon = host.lastIndexOf(':');
  if (colon > -1 && host.indexOf(':') === colon) host = host.slice(0, colon);
  return host;
}

export function isLoopbackAddress(value = '') {
  const addr = normalizeAddress(value);
  return addr === 'localhost' || addr === '::1' || /^127(?:\.\d{1,3}){3}$/.test(addr);
}

export function isLoopbackHostHeader(value = '') {
  return isLoopbackAddress(hostnameFromHeader(value));
}

export function isLocalAccess({ remoteAddress, hostHeader }) {
  return isLoopbackAddress(remoteAddress) && isLoopbackHostHeader(hostHeader);
}

export function resolveListenHost({ env = {}, authToken = '' }) {
  const host = env.HOST || '127.0.0.1';
  if (!authToken && !isLoopbackHostHeader(host)) {
    throw new Error('HOST must be loopback when AUTH_TOKEN is empty; set AUTH_TOKEN before binding remote interfaces');
  }
  return host;
}
