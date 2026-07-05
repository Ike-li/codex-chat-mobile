// push.js —— VAPID Web Push 离线通知。
// 当 codex turn 完成时，向已订阅的手机推送通知。
//
// 推荐使用 web-push npm 包处理 VAPID 加密细节（ES256 JWT + aes128gcm）。
// 本文件提供骨架 + web-push 对接。
//
// 用法：
//   1. 安装：npm install web-push
//   2. 生成密钥：npx web-push generate-vapid-keys
//   3. 设置 .env：VAPID_SUBJECT（mailto: 或 URL）、VAPID_PUBLIC_KEY、VAPID_PRIVATE_KEY
//   4. 手机端注册 Service Worker → pushManager.subscribe() → 发送订阅到 bridge
//   5. bridge 调用 sendPush(subscription, payload)

// ---- 订阅存储 ----
let subscriptions = [];

export function addSubscription(sub) {
  if (!subscriptions.some(s => s.endpoint === sub.endpoint)) {
    subscriptions.push(sub);
  }
}

export function removeSubscription(endpoint) {
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
}

export function getSubscriptions() {
  return [...subscriptions];
}

// ---- 推送通知 ----
let _webPush = null;

async function getWebPush() {
  if (_webPush) return _webPush;
  try {
    // 动态 require（ESM 兼容）
    _webPush = (await import('web-push')).default || (await import('web-push'));
  } catch {
    console.warn('[push] web-push 未安装，推送功能不可用。npm install web-push');
    return null;
  }
  return _webPush;
}

export async function initPush() {
  const wp = getWebPush();
  if (!wp) return false;

  const subject = process.env.VAPID_SUBJECT;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;

  if (!subject || !publicKey || !privateKey) {
    console.warn('[push] VAPID 未配置（需要 VAPID_SUBJECT + VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY）');
    return false;
  }

  wp.setVapidDetails(subject, publicKey, privateKey);
  return true;
}

export async function sendPush(subscription, payload) {
  const wp = getWebPush();
  if (!wp) return false;

  const { endpoint, keys } = subscription;
  if (!endpoint || !keys) return false;

  try {
    await wp.sendNotification(
      { endpoint, keys },
      JSON.stringify({
        title: payload.title || 'Codex 完成',
        body: payload.body || '任务已完成',
        icon: '/icon-192.png',
        data: payload.data || {},
      }),
    );
    return true;
  } catch (err) {
    console.error('[push] 推送失败:', err.message);
    return false;
  }
}
