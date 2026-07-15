import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');

blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
for (const [address, prefix] of [
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]) blocked.addSubnet(address, prefix, 'ipv6');

export function isPublicIpAddress(address) {
  const normalized = String(address || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized.startsWith('::ffff:') && isIP(normalized.slice('::ffff:'.length)) === 4) {
    return isPublicIpAddress(normalized.slice('::ffff:'.length));
  }
  const version = isIP(normalized);
  if (version === 4) return !blocked.check(normalized, 'ipv4');
  if (version === 6) return !blocked.check(normalized, 'ipv6');
  return false;
}

export function isPublicEndpointHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  return Boolean(normalized)
    && normalized !== 'localhost'
    && !normalized.endsWith('.localhost')
    && !normalized.endsWith('.local')
    && !normalized.endsWith('.internal');
}
