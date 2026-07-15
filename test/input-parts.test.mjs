import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveInputParts } from '../input-parts.js';

test('resolveInputParts canonicalizes a workspace mention inside the runtime cwd', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccm-input-mention-'));
  try {
    mkdirSync(join(cwd, 'src'));
    const filePath = join(cwd, 'src', 'server.js');
    writeFileSync(filePath, 'export const ok = true;');

    const parts = await resolveInputParts([{
      kind: 'mention',
      name: 'untrusted-name',
      path: filePath,
    }], { cwd });

    assert.deepEqual(parts, [{
      kind: 'mention',
      name: 'src/server.js',
      path: realpathSync(filePath),
    }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInputParts accepts only an enabled skill returned by skills/list', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccm-input-skill-'));
  try {
    const skillPath = '/trusted/skills/release/SKILL.md';
    const parts = await resolveInputParts([{
      kind: 'skill',
      name: 'release',
      path: skillPath,
    }], {
      cwd,
      skillEntries: [{
        cwd,
        skills: [
          { name: 'disabled', path: '/trusted/skills/disabled/SKILL.md', enabled: false },
          { name: 'release', path: skillPath, enabled: true },
        ],
      }],
    });

    assert.deepEqual(parts, [{ kind: 'skill', name: 'release', path: skillPath }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInputParts admits an HTTPS image URL only through the explicit remote-image gate', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccm-input-image-url-'));
  try {
    const parts = await resolveInputParts([{
      kind: 'imageUrl',
      url: 'https://images.example.test/reference.png',
      detail: 'original',
    }], {
      cwd,
      allowRemoteImages: true,
      resolveHostname: async hostname => {
        assert.equal(hostname, 'images.example.test');
        return ['93.184.216.34'];
      },
    });

    assert.deepEqual(parts, [{
      kind: 'imageUrl',
      url: 'https://images.example.test/reference.png',
      detail: 'original',
    }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInputParts rejects site-local IPv6 remote image resolution', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccm-input-image-site-local-'));
  try {
    await assert.rejects(
      resolveInputParts([{
        kind: 'imageUrl',
        url: 'https://images.example.test/reference.png',
      }], {
        cwd,
        allowRemoteImages: true,
        resolveHostname: async () => ['fec0::1234'],
      }),
      /non-public address/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInputParts rejects an unsupported browser-supplied part kind', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccm-input-unsupported-'));
  try {
    await assert.rejects(
      resolveInputParts([{ kind: 'rawAppServerInput', type: 'text', text: 'bypass' }], { cwd }),
      /Unsupported input part kind/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
