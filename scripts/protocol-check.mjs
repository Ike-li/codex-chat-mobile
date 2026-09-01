#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STABLE_PROTOCOL_DIR = join(ROOT, '.protocol', 'stable');
const CODEX_VERSION_FILE = join(ROOT, '.codex-version');
const PROTOCOL_KINDS = {
  serverNotifications: 'ServerNotification',
  clientRequests: 'ClientRequest',
  serverRequests: 'ServerRequest',
  clientNotifications: 'ClientNotification',
};
const SERVER_REQUEST_SET_NAME = 'ALL_REQUEST_METHODS';

export const LEGACY_METHOD_ALLOWLIST = new Set([
  // Phase 1 keeps dual-track compatibility with this legacy notification even
  // though codex 0.147.0 no longer exports it in ServerNotification.
  'turn/failed',
]);

export const EXPERIMENTAL_METHOD_ALLOWLIST = new Set([
  // Probed and degraded: B1 does not export this request. The bridge treats
  // -32601 / experimentalApi errors as "defer to next turn/start".
  'thread/settings/update',
]);

export function readProtocolMethodSets(protocolDir) {
  const out = {};
  for (const [kind, typeName] of Object.entries(PROTOCOL_KINDS)) {
    const file = join(protocolDir, `${typeName}.ts`);
    out[kind] = parseProtocolMethods(readFileSync(file, 'utf8'));
  }
  return out;
}

export function parseProtocolMethods(source) {
  const methods = new Set();
  for (const match of source.matchAll(/["']method["']\s*:\s*["']([^"']+)["']/g)) {
    methods.add(match[1]);
  }
  return methods;
}

// Top-level string members of a union alias. Object variants (e.g. the
// `granular` shape of AskForApproval) are skipped so their quoted keys are not
// mistaken for accepted values.
export function parseStringLiteralUnion(source, typeName) {
  const alias = source.match(new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`));
  if (!alias) throw new Error(`Type alias ${typeName} not found in protocol source.`);

  const members = [];
  let depth = 0;
  let current = '';
  for (const char of alias[1]) {
    if (char === '{' || char === '(' || char === '[') depth += 1;
    else if (char === '}' || char === ')' || char === ']') depth -= 1;
    else if (char === '|' && depth === 0) {
      members.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  members.push(current);

  const literals = new Set();
  for (const member of members) {
    const literal = member.trim().match(/^"([^"]+)"$/);
    if (literal) literals.add(literal[1]);
  }
  return literals;
}

export function collectBridgeMethodUsage({ agentAppserverSource, approvalBrokerSource }) {
  const serverNotifications = extractCaseMethodsFromFunction(agentAppserverSource, 'handleNotification');
  const clientRequests = extractCallMethodLiterals(agentAppserverSource, 'request');
  const clientNotifications = extractCallMethodLiterals(agentAppserverSource, 'notify');
  const serverRequests = new Set([
    ...extractServerRequestMethodsFromAgent(agentAppserverSource),
    ...extractServerRequestMethodsFromApprovalBroker(approvalBrokerSource),
  ]);

  return {
    serverNotifications,
    clientRequests,
    clientNotifications,
    serverRequests,
  };
}

export function findMissingProtocolCoverage({
  usage,
  protocol,
  allowlist = new Set([...LEGACY_METHOD_ALLOWLIST, ...EXPERIMENTAL_METHOD_ALLOWLIST]),
}) {
  const missing = [];
  for (const [direction, protocolType] of Object.entries(PROTOCOL_KINDS)) {
    const used = usage[direction] || new Set();
    const exported = protocol[direction] || new Set();
    for (const method of sortSet(used)) {
      if (allowlist.has(method)) continue;
      if (!exported.has(method)) {
        missing.push({ direction, protocolType, method });
      }
    }
  }
  return missing;
}

export function formatMissingProtocolCoverage(missing) {
  if (missing.length === 0) return 'Protocol coverage: OK';
  const lines = ['Protocol coverage: missing bridge methods in generated exports'];
  for (const item of missing) {
    lines.push(`  - ${item.protocolType}: ${item.method}`);
  }
  return lines.join('\n');
}

export function diffMethodSets(baseline, current) {
  const out = {};
  for (const [direction, protocolType] of Object.entries(PROTOCOL_KINDS)) {
    out[protocolType] = {
      added: difference(current[direction] || new Set(), baseline[direction] || new Set()),
      removed: difference(baseline[direction] || new Set(), current[direction] || new Set()),
    };
  }
  return out;
}

export function readProtocolTypeSet(protocolDir) {
  const types = new Set();
  for (const file of listTsFiles(protocolDir)) {
    if (basename(file) === 'index.ts') continue;
    types.add(stripTsExtension(toPosix(relative(protocolDir, file))));
  }
  return types;
}

export function diffTypeSets(baseline, current) {
  return {
    added: difference(current, baseline),
    removed: difference(baseline, current),
  };
}

export function diffProtocolFiles(baselineDir, currentDir) {
  const baselineFiles = new Map(listTsFiles(baselineDir).map(file => [toPosix(relative(baselineDir, file)), file]));
  const currentFiles = new Map(listTsFiles(currentDir).map(file => [toPosix(relative(currentDir, file)), file]));
  const added = difference(new Set(currentFiles.keys()), new Set(baselineFiles.keys()));
  const removed = difference(new Set(baselineFiles.keys()), new Set(currentFiles.keys()));
  const changed = [];

  for (const relPath of [...baselineFiles.keys()].sort()) {
    if (!currentFiles.has(relPath)) continue;
    const baselineText = normalizeGeneratedText(readFileSync(baselineFiles.get(relPath), 'utf8'));
    const currentText = normalizeGeneratedText(readFileSync(currentFiles.get(relPath), 'utf8'));
    if (baselineText !== currentText) changed.push(relPath);
  }

  return { added, removed, changed };
}

export function hasProtocolDrift({ methodDiff, typeDiff, fileDiff }) {
  if (typeDiff.added.length || typeDiff.removed.length) return true;
  if (fileDiff.added.length || fileDiff.removed.length || fileDiff.changed.length) return true;
  return Object.values(methodDiff).some(diff => diff.added.length || diff.removed.length);
}

export function formatProtocolDrift({ methodDiff, typeDiff, fileDiff }) {
  if (!hasProtocolDrift({ methodDiff, typeDiff, fileDiff })) {
    return 'Protocol export drift: OK';
  }

  const lines = [
    'Protocol export drift detected between .protocol/stable and freshly generated codex output.',
    'Method removals plus additions may indicate a rename.',
  ];

  for (const [protocolType, diff] of Object.entries(methodDiff)) {
    if (diff.added.length === 0 && diff.removed.length === 0) continue;
    lines.push(`\n${protocolType} methods:`);
    appendList(lines, 'added', diff.added);
    appendList(lines, 'removed', diff.removed);
  }

  if (typeDiff.added.length || typeDiff.removed.length) {
    lines.push('\nType files:');
    appendList(lines, 'added', typeDiff.added);
    appendList(lines, 'removed', typeDiff.removed);
  }

  if (fileDiff.added.length || fileDiff.removed.length || fileDiff.changed.length) {
    lines.push('\nGenerated files:');
    appendList(lines, 'added', fileDiff.added);
    appendList(lines, 'removed', fileDiff.removed);
    appendList(lines, 'changed', fileDiff.changed, 40);
  }

  return lines.join('\n');
}

export function readPinnedCodexVersion(versionFile = CODEX_VERSION_FILE) {
  return readFileSync(versionFile, 'utf8').trim();
}

function extractCaseMethodsFromFunction(source, functionName) {
  const body = extractFunctionBody(source, functionName);
  const methods = new Set();
  for (const match of body.matchAll(/\bcase\s+(['"`])([^'"`]+)\1\s*:/g)) {
    methods.add(match[2]);
  }
  return methods;
}

function extractCallMethodLiterals(source, methodName) {
  const methods = new Set();
  const pattern = new RegExp(`\\bthis\\.${methodName}\\s*\\(\\s*(['"\`])([^'"\`]+)\\1`, 'g');
  for (const match of source.matchAll(pattern)) {
    methods.add(match[2]);
  }
  return methods;
}

function extractServerRequestMethodsFromAgent(source) {
  const body = extractFunctionBody(source, 'handleServerRequest');
  const methods = new Set();
  for (const match of body.matchAll(/\bmethod\s*={2,3}\s*(['"`])([^'"`]+)\1/g)) {
    methods.add(match[2]);
  }
  return methods;
}

function extractServerRequestMethodsFromApprovalBroker(source) {
  const setDefinitions = parseConstSetDefinitions(source);
  return resolveConstSet(SERVER_REQUEST_SET_NAME, setDefinitions);
}

function parseConstSetDefinitions(source) {
  const definitions = new Map();
  const setPattern = /\bconst\s+([A-Z0-9_]+)\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)\s*;/g;
  for (const match of source.matchAll(setPattern)) {
    const entries = [];
    for (const entry of match[2].matchAll(/(['"`])([^'"`]+)\1|\.\.\.([A-Z0-9_]+)/g)) {
      if (entry[2]) entries.push({ type: 'literal', value: entry[2] });
      if (entry[3]) entries.push({ type: 'spread', value: entry[3] });
    }
    definitions.set(match[1], entries);
  }
  return definitions;
}

function resolveConstSet(name, definitions, seen = new Set()) {
  if (seen.has(name)) return new Set();
  seen.add(name);
  const entries = definitions.get(name) || [];
  const out = new Set();
  for (const entry of entries) {
    if (entry.type === 'literal') out.add(entry.value);
    if (entry.type === 'spread') {
      for (const value of resolveConstSet(entry.value, definitions, seen)) {
        out.add(value);
      }
    }
  }
  return out;
}

function extractFunctionBody(source, functionName) {
  const nameIndex = findDefinitionIndex(source, functionName);
  if (nameIndex === -1) return '';
  const openIndex = source.indexOf('{', nameIndex);
  if (openIndex === -1) return '';

  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return '';
}

// Locate a method/function definition, skipping property-access call sites such as
// `this.handleNotification(` so a call that precedes the definition is not mistaken
// for it (which would slice an empty body and void the coverage extraction).
function findDefinitionIndex(source, functionName) {
  const needle = `${functionName}(`;
  let from = 0;
  for (;;) {
    const index = source.indexOf(needle, from);
    if (index === -1) return -1;
    if (source[index - 1] !== '.') return index;
    from = index + needle.length;
  }
}

function listTsFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...listTsFiles(path));
    } else if (entry.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out.sort();
}

function difference(left, right) {
  return [...left].filter(value => !right.has(value)).sort();
}

function sortSet(values) {
  return [...values].sort();
}

function appendList(lines, label, values, limit = Infinity) {
  if (values.length === 0) return;
  const visible = values.slice(0, limit);
  lines.push(`  ${label}:`);
  for (const value of visible) lines.push(`    - ${value}`);
  if (values.length > visible.length) {
    lines.push(`    ... ${values.length - visible.length} more`);
  }
}

function normalizeGeneratedText(text) {
  return text.replace(/\r\n/g, '\n');
}

function stripTsExtension(path) {
  return path.replace(/\.ts$/, '');
}

function toPosix(path) {
  return path.split(sep).join('/');
}

function checkCodexBinary(pin) {
  const version = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  if (version.error?.code === 'ENOENT') {
    throw new Error(codexInstallMessage(pin));
  }
  if (version.error) throw version.error;
  if (version.status !== 0) {
    throw new Error(`Unable to run codex --version.\n${version.stderr || version.stdout}`);
  }

  const text = `${version.stdout || ''}\n${version.stderr || ''}`;
  if (!text.includes(pin)) {
    throw new Error(`Installed codex does not match .codex-version ${pin}.\nFound:\n${text.trim()}\n\n${codexInstallMessage(pin)}`);
  }
}

function codexInstallMessage(pin) {
  return `codex binary not found or not pinned. Install with:\n  npm i -g @openai/codex@${pin}`;
}

function generateProtocolToTemp(pin) {
  checkCodexBinary(pin);
  const outDir = mkdtempSync(join(tmpdir(), 'codex-protocol-'));
  const generated = spawnSync('codex', ['app-server', 'generate-ts', '--out', outDir], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (generated.error?.code === 'ENOENT') {
    rmSync(outDir, { recursive: true, force: true });
    throw new Error(codexInstallMessage(pin));
  }
  if (generated.error) {
    rmSync(outDir, { recursive: true, force: true });
    throw generated.error;
  }
  if (generated.status !== 0) {
    rmSync(outDir, { recursive: true, force: true });
    throw new Error(`codex app-server generate-ts failed.\n${generated.stderr || generated.stdout}`);
  }
  return outDir;
}

function runProtocolCheck() {
  const pin = readPinnedCodexVersion();
  const generatedDir = generateProtocolToTemp(pin);
  try {
    const baselineMethods = readProtocolMethodSets(STABLE_PROTOCOL_DIR);
    const generatedMethods = readProtocolMethodSets(generatedDir);
    const methodDiff = diffMethodSets(baselineMethods, generatedMethods);
    const typeDiff = diffTypeSets(readProtocolTypeSet(STABLE_PROTOCOL_DIR), readProtocolTypeSet(generatedDir));
    const fileDiff = diffProtocolFiles(STABLE_PROTOCOL_DIR, generatedDir);
    const usage = collectBridgeMethodUsage({
      agentAppserverSource: readFileSync(join(ROOT, 'agent-appserver.js'), 'utf8'),
      approvalBrokerSource: readFileSync(join(ROOT, 'approval-broker.js'), 'utf8'),
    });
    const missing = findMissingProtocolCoverage({ usage, protocol: baselineMethods });
    const driftReport = formatProtocolDrift({ methodDiff, typeDiff, fileDiff });
    const coverageReport = formatMissingProtocolCoverage(missing);

    console.log(`Codex protocol pin: ${pin}`);
    console.log(driftReport);
    console.log(coverageReport);
    console.log(`Legacy allowlist: ${sortSet(LEGACY_METHOD_ALLOWLIST).join(', ') || '(empty)'}`);
    console.log(`Experimental allowlist: ${sortSet(EXPERIMENTAL_METHOD_ALLOWLIST).join(', ') || '(empty)'}`);

    return hasProtocolDrift({ methodDiff, typeDiff, fileDiff }) || missing.length > 0 ? 1 : 0;
  } finally {
    rmSync(generatedDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runProtocolCheck();
  } catch (err) {
    console.error(err?.message || err);
    process.exitCode = 1;
  }
}
