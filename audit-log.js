import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { appendOwnerOnlyFile, fixPermissions } from './file-security.js';

export function appendJsonlAuditRecord(path, entry, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : 1024 * 1024;
  const line = `${JSON.stringify({ ts: now(), ...entry })}\n`;
  const lineBytes = Buffer.byteLength(line);
  if (lineBytes > maxBytes) throw new Error('Audit record exceeds retention limit');

  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  fixPermissions(directory, true);
  if (existsSync(path) && statSync(path).size + lineBytes > maxBytes) {
    const rotatedPath = `${path}.1`;
    rmSync(rotatedPath, { force: true });
    renameSync(path, rotatedPath);
    fixPermissions(rotatedPath, false);
  }
  appendOwnerOnlyFile(path, line);
}
