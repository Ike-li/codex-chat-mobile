import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkdirAllowlist, resolveWithinWorkdirs } from '../workdir-allowlist.js';

test('WORK_DIRS can load a JSON array of workspace paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-workdirs-'));
  try {
    const alpha = join(root, 'alpha');
    const beta = join(root, 'beta');
    mkdirSync(alpha);
    mkdirSync(beta);
    writeFileSync(join(root, 'workdirs.json'), JSON.stringify([alpha, beta, alpha]));
    const primaryPath = join(root, 'primary');
    mkdirSync(primaryPath);
    const primary = realpathSync(primaryPath);
    const resolved = resolveWorkdirAllowlist({
      workDir: primary,
      extra: 'workdirs.json',
      baseDir: root,
    });
    assert.deepEqual(resolved.workDirs, [primary, realpathSync(alpha), realpathSync(beta)]);
    assert.equal(resolved.warnings.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('comma-separated WORK_DIRS still adds extra directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-workdirs-csv-'));
  try {
    const primaryPath = join(root, 'primary');
    const extra = join(root, 'extra');
    mkdirSync(primaryPath);
    mkdirSync(extra);
    const resolved = resolveWorkdirAllowlist({
      workDir: primaryPath,
      extra,
      baseDir: root,
    });
    assert.deepEqual(resolved.workDirs, [realpathSync(primaryPath), realpathSync(extra)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// fs/readFile 与 fs/writeFile 只收绝对路径，协议侧不做作用域约束——手机拿到一个有效
// token 就能读 ~/.ssh/id_rsa 和 ~/.codex/auth.json。凭据外泄是唯一撤销设备也收不回的
// 破坏，所以边界要落在服务端，不能只是前端约定。
test('工作区作用域拦截穿越、软链接逃逸和前缀碰撞', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-scope-')));
  try {
    const work = join(root, 'work');
    const outside = join(root, 'outside');
    // 前缀碰撞：/…/work 获准时 /…/work-other 不能跟着获准。
    const sibling = join(root, 'work-other');
    for (const dir of [work, outside, sibling]) mkdirSync(dir);
    writeFileSync(join(work, 'a.txt'), 'a');
    writeFileSync(join(outside, 'secret'), 's');
    writeFileSync(join(sibling, 'b.txt'), 'b');
    symlinkSync(join(outside, 'secret'), join(work, 'escape'));
    const workDirs = [work];

    assert.equal(resolveWithinWorkdirs(join(work, 'a.txt'), workDirs), join(work, 'a.txt'));
    assert.equal(resolveWithinWorkdirs(work, workDirs), work, '工作区根目录本身可用');
    // 尚不存在的目标要能通过，否则新建文件无从下手；但祖先仍需落在工作区内。
    assert.equal(resolveWithinWorkdirs(join(work, 'new.txt'), workDirs), join(work, 'new.txt'));

    assert.equal(resolveWithinWorkdirs(join(outside, 'secret'), workDirs), null, '工作区外');
    assert.equal(resolveWithinWorkdirs(join(work, '..', 'outside', 'secret'), workDirs), null, '路径穿越');
    assert.equal(resolveWithinWorkdirs(join(work, 'escape'), workDirs), null, '软链接逃逸');
    assert.equal(resolveWithinWorkdirs(join(sibling, 'b.txt'), workDirs), null, '前缀碰撞');
    assert.equal(resolveWithinWorkdirs('relative/path', workDirs), null, '相对路径');
    assert.equal(resolveWithinWorkdirs('', workDirs), null);
    assert.equal(resolveWithinWorkdirs(join(work, 'a.txt'), []), null, '没有工作区时一律拒绝');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
