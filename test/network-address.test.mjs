import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPublicIpAddress } from '../network-address.js';

test('public IP classification rejects non-global IPv4 and IPv6 ranges', () => {
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'fec0::1',
    'ff00::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  assert.equal(isPublicIpAddress('8.8.8.8'), true);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
});
