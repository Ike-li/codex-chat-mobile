import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildUserInputs } from '../user-inputs.js';

test('buildUserInputs emits the pinned v2 text shape with text_elements', () => {
  assert.deepEqual(buildUserInputs({ text: 'hello app-server' }), [{
    type: 'text',
    text: 'hello app-server',
    text_elements: [],
  }]);
});

test('buildUserInputs maps a verified uploaded image to localImage', () => {
  assert.deepEqual(buildUserInputs({
    text: 'inspect this image',
    attachments: [{
      kind: 'image',
      absPath: '/tmp/.ccm-uploads/pixel.png',
      name: 'pixel.png',
      detectedMimeType: 'image/png',
    }],
  }), [
    { type: 'text', text: 'inspect this image', text_elements: [] },
    { type: 'localImage', path: '/tmp/.ccm-uploads/pixel.png' },
  ]);
});

test('buildUserInputs maps an uploaded file to mention without path text injection', () => {
  assert.deepEqual(buildUserInputs({
    text: 'review this file',
    attachments: [{
      kind: 'file',
      absPath: '/tmp/.ccm-uploads/notes.txt',
      name: 'notes.txt',
      mimeType: 'text/plain',
    }],
  }), [
    { type: 'text', text: 'review this file', text_elements: [] },
    { type: 'mention', name: 'notes.txt', path: '/tmp/.ccm-uploads/notes.txt' },
  ]);
});

test('buildUserInputs maps a server-verified skill descriptor', () => {
  assert.deepEqual(buildUserInputs({
    text: 'use the selected skill',
    parts: [{
      kind: 'skill',
      name: 'release-notes',
      path: '/tmp/work/.agents/skills/release-notes/SKILL.md',
    }],
  }), [
    { type: 'text', text: 'use the selected skill', text_elements: [] },
    {
      type: 'skill',
      name: 'release-notes',
      path: '/tmp/work/.agents/skills/release-notes/SKILL.md',
    },
  ]);
});

test('buildUserInputs maps a server-verified workspace mention', () => {
  assert.deepEqual(buildUserInputs({
    parts: [{
      kind: 'mention',
      name: 'src/server.js',
      path: '/tmp/work/src/server.js',
    }],
  }), [{
    type: 'mention',
    name: 'src/server.js',
    path: '/tmp/work/src/server.js',
  }]);
});

test('buildUserInputs maps a server-verified image URL with pinned detail', () => {
  assert.deepEqual(buildUserInputs({
    parts: [{
      kind: 'imageUrl',
      url: 'https://images.example.test/reference.png',
      detail: 'high',
    }],
  }), [{
    type: 'image',
    url: 'https://images.example.test/reference.png',
    detail: 'high',
  }]);
});
