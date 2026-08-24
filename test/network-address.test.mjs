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

test('public IP classification rejects the well-known NAT64 prefix', () => {
  // 64:ff9b::/96 把 IPv4 映射进 IPv6。此前只挡了 64:ff9b:1::/48（local-use），
  // 于是 64:ff9b::7f00:1 —— 也就是 127.0.0.1 —— 会被当作公网地址放行。
  for (const address of ['64:ff9b::7f00:1', '64:ff9b::a00:1', '64:ff9b::c0a8:101']) {
    assert.equal(isPublicIpAddress(address), false, `${address} 不应被当作公网地址`);
  }
});

test('public IP classification rejects IPv4-compatible and IPv4-translated forms', () => {
  // ::/96 与 ::ffff:0:0/96 都把 IPv4 塞进 IPv6 地址。已被废弃（RFC 4291 / RFC 2765），
  // 主流内核也不做自动隧道，但这个谓词是 push-sender 和 input-parts 两处 SSRF 防线的
  // 共同基础，不该依赖「内核大概不会路由它」这种前提。
  for (const address of ['::7f00:1', '::a00:1', '::c0a8:101', '::ffff:0:7f00:1', '::ffff:0:a00:1']) {
    assert.equal(isPublicIpAddress(address), false, `${address} 不应被当作公网地址`);
  }
});

test('public IP classification still accepts genuine global IPv6', () => {
  for (const address of ['2606:4700:4700::1111', '2400:cb00::1']) {
    assert.equal(isPublicIpAddress(address), true, `${address} 是公网地址`);
  }
});
