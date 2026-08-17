import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_OPTIONS,
  SANDBOX_OPTIONS,
  FALLBACK_REASONING_OPTIONS,
  visibleModels,
  reasoningOptionsForModel,
  serviceTiersForModel,
  normalizeReasoningEffort,
  normalizeApprovalPolicy,
  resolveSelectedModel,
  clampEffortForModel,
  clampServiceTierForModel,
  formatModelBadge,
  formatPermissionBadge,
  formatComposerMode,
  formatComposerPermission,
  formatComposerModel,
  formatComposerEffort,
  sanitizeTurnOverrides,
  sandboxPolicyFromMode,
  buildTurnStartOverrides,
  loadCliSettings,
  saveCliSettings,
  SETTINGS_STORAGE_KEY,
} from '../public/js/cli-settings.js';

test('approval options match the CLI --ask-for-approval values plus protocol on-failure', () => {
  assert.deepEqual(APPROVAL_OPTIONS.map(option => option.id), [
    'untrusted',
    'on-failure',
    'on-request',
    'never',
  ]);
});

test('sandbox options match the CLI --sandbox values', () => {
  assert.deepEqual(SANDBOX_OPTIONS.map(option => option.id), [
    'read-only',
    'workspace-write',
    'danger-full-access',
  ]);
});

test('fallback reasoning options match the Codex CLI effort enum', () => {
  assert.deepEqual(FALLBACK_REASONING_OPTIONS.map(option => option.id), [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
  ]);
});

test('visible models hide catalog entries marked hidden', () => {
  const models = visibleModels([
    { model: 'gpt-5.6-sol', displayName: 'GPT-5.6', hidden: false },
    { model: 'secret-lab', displayName: 'Lab', hidden: true },
    { model: 'gpt-5.4', displayName: 'GPT-5.4' },
  ]);
  assert.deepEqual(models.map(model => model.model), ['gpt-5.6-sol', 'gpt-5.4']);
});

test('reasoning options come from the selected model and fall back to the CLI enum', () => {
  const fromModel = reasoningOptionsForModel({
    model: 'gpt-5.6-sol',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Faster' },
      { reasoningEffort: 'high', description: 'Deeper' },
      { reasoningEffort: 'max', description: 'Maximum' },
    ],
  });
  assert.deepEqual(fromModel.map(option => option.id), ['low', 'high', 'max']);
  assert.equal(fromModel[1].desc, 'Deeper');

  const fallback = reasoningOptionsForModel({ model: 'unknown' });
  assert.deepEqual(
    fallback.map(option => option.id),
    FALLBACK_REASONING_OPTIONS.map(option => option.id),
  );
});

test('legacy Chinese and alias labels normalize to CLI protocol ids', () => {
  assert.equal(normalizeReasoningEffort('超高'), 'xhigh');
  assert.equal(normalizeReasoningEffort('低'), 'low');
  assert.equal(normalizeReasoningEffort('中'), 'medium');
  assert.equal(normalizeReasoningEffort('高'), 'high');
  assert.equal(normalizeReasoningEffort('Ultra'), 'ultra');
  assert.equal(normalizeReasoningEffort('MAX'), 'max');
  assert.equal(normalizeApprovalPolicy('unlessTrusted'), 'untrusted');
  assert.equal(normalizeApprovalPolicy('custom'), 'on-request');
  assert.equal(normalizeApprovalPolicy('never'), 'never');
});

test('selected model prefers a stored catalog hit, then default, then a free-form CLI id', () => {
  const models = [
    { model: 'gpt-5.4', displayName: 'GPT-5.4', isDefault: false },
    { model: 'gpt-5.6-sol', displayName: 'GPT-5.6', isDefault: true },
  ];
  assert.equal(resolveSelectedModel('gpt-5.4', models), 'gpt-5.4');
  assert.equal(resolveSelectedModel('gpt-5.5', models), 'gpt-5.6-sol');
  assert.equal(resolveSelectedModel('my-local-oss', models), 'my-local-oss');
  assert.equal(resolveSelectedModel('', models), 'gpt-5.6-sol');
});

test('effort is clamped to the selected model and service tiers come from the catalog', () => {
  const model = {
    model: 'gpt-5.6-sol',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'high' },
    ],
    defaultReasoningEffort: 'high',
    serviceTiers: [
      { id: 'standard', name: 'Standard' },
      { id: 'fast', name: 'Fast' },
    ],
    defaultServiceTier: 'standard',
  };
  assert.equal(clampEffortForModel('max', model), 'high');
  assert.equal(clampEffortForModel('low', model), 'low');
  assert.deepEqual(serviceTiersForModel(model).map(tier => tier.id), ['standard', 'fast']);
  assert.deepEqual(serviceTiersForModel({}), []);
});

test('an unset service tier stays unset instead of inventing Fast', () => {
  const model = {
    serviceTiers: [
      { name: 'Fast', description: '1.5x speed, increased usage', serviceTier: 'priority' },
      { id: 'standard', name: 'Standard', description: 'Default speed' },
    ],
    defaultServiceTier: 'standard',
  };
  assert.deepEqual(serviceTiersForModel(model).map(tier => tier.id), ['priority', 'standard']);
  assert.equal(clampServiceTierForModel('', model), '');
  assert.equal(clampServiceTierForModel('fast', model), '');
  assert.equal(clampServiceTierForModel('priority', model), 'priority');
  assert.equal(clampServiceTierForModel('standard', model), 'standard');
});

test('empty settings do not invent CLI overrides that would clobber config.toml', () => {
  assert.deepEqual(sanitizeTurnOverrides({}), {});
  assert.deepEqual(buildTurnStartOverrides({}), {});
  assert.equal(formatPermissionBadge({}), '🛡 配置默认');
  assert.equal(formatModelBadge({}), '');
});

test('badges show CLI-faithful model, effort, approval and sandbox labels', () => {
  assert.equal(
    formatModelBadge({ model: 'gpt-5.6-sol', effort: 'max', displayName: 'GPT-5.6' }),
    'GPT-5.6 最大',
  );
  assert.equal(
    formatModelBadge({ model: 'gpt-5.4-mini', effort: 'high', serviceTier: 'fast' }),
    '5.4-mini 高 · ⚡',
  );
  assert.equal(
    formatPermissionBadge({ approvalPolicy: 'on-request', sandbox: 'workspace-write' }),
    '🖐️ 按请求批准 · 工作区可写',
  );
  assert.equal(
    formatPermissionBadge({ approvalPolicy: 'never', sandbox: 'danger-full-access' }),
    '⚠️ 从不询问 · 完全访问',
  );
});

test('composer chips use short labels that will not wrap on a phone toolbar', () => {
  assert.equal(formatComposerMode('/chat'), '对话');
  assert.equal(formatComposerMode('/plan'), '计划');
  assert.equal(
    formatComposerPermission({ approvalPolicy: 'on-request', sandbox: 'workspace-write' }),
    '按请求 · 可写',
  );
  assert.equal(
    formatComposerPermission({ approvalPolicy: 'never', sandbox: 'danger-full-access' }),
    '不问 · 全开',
  );
  assert.equal(formatComposerPermission({}), '默认');
  assert.equal(formatComposerModel({ displayName: 'GPT-5.6-Sol', effort: 'max' }), 'GPT-5.6-Sol');
  assert.equal(formatComposerModel({ model: 'gpt-5.4-mini' }), '5.4-mini');
  assert.equal(formatComposerEffort('max'), '最大');
  assert.equal(formatComposerEffort(''), '');
  for (const label of [
    formatComposerMode('/chat'),
    formatComposerPermission({ approvalPolicy: 'on-request', sandbox: 'workspace-write' }),
    formatComposerModel({ displayName: 'GPT-5.6-Sol' }),
  ]) {
    assert.equal(/\p{Extended_Pictographic}/u.test(label), false);
    assert.ok(label.length <= 12, `${label} is too long for the composer chip`);
  }
});

test('turn overrides map CLI sandbox modes onto turn/start sandboxPolicy objects', () => {
  assert.deepEqual(
    sanitizeTurnOverrides({
      model: 'gpt-5.6-sol',
      effort: '超高',
      approvalPolicy: 'unlessTrusted',
      sandbox: 'workspace-write',
      serviceTier: 'fast',
      extra: 'drop-me',
    }),
    {
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      serviceTier: 'fast',
    },
  );
  assert.equal(sanitizeTurnOverrides({ approvalPolicy: 'nope', sandbox: 'jailbreak' }).approvalPolicy, undefined);
  assert.deepEqual(sandboxPolicyFromMode('read-only'), { type: 'readOnly', networkAccess: false });
  assert.deepEqual(sandboxPolicyFromMode('danger-full-access'), { type: 'dangerFullAccess' });
  assert.deepEqual(sandboxPolicyFromMode('workspace-write'), {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
  assert.deepEqual(
    buildTurnStartOverrides({
      model: 'gpt-5.6-sol',
      effort: 'max',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      serviceTier: 'fast',
    }),
    {
      model: 'gpt-5.6-sol',
      effort: 'max',
      approvalPolicy: 'never',
      serviceTier: 'fast',
      sandboxPolicy: { type: 'dangerFullAccess' },
    },
  );
});

test('browser settings migrate old slash-label keys into CLI protocol ids', () => {
  const data = Object.create(null);
  const storage = {
    getItem: key => Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null,
    setItem: (key, value) => { data[key] = String(value); },
  };
  storage.setItem('codex_selected_model', 'gpt-5.5');
  storage.setItem('codex_selected_reasoning', '超高');
  storage.setItem('codex_selected_speed', '快速');
  const migrated = loadCliSettings(storage);
  assert.deepEqual(migrated, {
    model: 'gpt-5.5',
    effort: 'xhigh',
    serviceTier: 'fast',
  });

  saveCliSettings(storage, {
    model: 'gpt-5.6-sol',
    effort: 'max',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  });
  assert.equal(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)).model, 'gpt-5.6-sol');
  assert.deepEqual(loadCliSettings(storage), {
    model: 'gpt-5.6-sol',
    effort: 'max',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  });
});
