export function isDefinitelyUnattempted(request) {
  const attempts = request?.attempts;
  return request?.state === 'pending'
    && (attempts === undefined || attempts === null || attempts === 0)
    && !request?.attemptedGatewayEpoch;
}

export function isProvisionalInstanceOrphan(request, context = {}) {
  const instanceId = request?.payload?.instanceId;
  if (!instanceId || request?.payload?.threadId) return false;
  if (instanceId === context.currentInstanceId) return false;
  if (context.instanceSnapshotReceived !== true) return false;
  const activeInstanceIds = context.activeInstanceIds instanceof Set
    ? context.activeInstanceIds
    : new Set(Array.isArray(context.activeInstanceIds) ? context.activeInstanceIds : []);
  return !activeInstanceIds.has(instanceId);
}

// 一条记录是否已经没有任何自动出路，只能由用户决定重试还是丢弃。
// drain 在 rejected/needs_reconcile 处停下以保序；attempted orphan 既不能 rebind
// （尝试过）、又匹配不上当前视图（目标已失效）、reconcile 的状态白名单也不含
// retryable —— 没有这个出口它会永远留在 outbox 里反复重绘。
export function requiresManualDisposal(request, { orphaned = false } = {}) {
  if (!request) return false;
  if (request.state === 'rejected' || request.state === 'needs_reconcile') return true;
  return orphaned && !isDefinitelyUnattempted(request);
}
